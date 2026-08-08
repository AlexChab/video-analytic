'use strict';

const logger = require('../utils/Logger');
const ptzDiagnostics = require('./PtzDiagnosticsStore');

/**
 * Неблокирующий диспетчер команд камеры.
 *
 * Пока драйвер выполняет запрос, новые команды не образуют очередь: хранится
 * только последняя актуальная команда. После завершения отправки она немедленно
 * заменяет все промежуточные команды. Видеоконвейер никогда не ожидает драйвер.
 */
class CameraCommandDispatcher {
  constructor({
    driver,
    minIntervalMs = 100,
    commandTimeoutMs = 500,
    repeatIntervalMs = 500,
  }) {
    if (!driver || typeof driver.move !== 'function') {
      throw new TypeError('CameraCommandDispatcher требует CameraDriver');
    }

    this.driver = driver;
    this.minIntervalMs = this.#nonNegative(minIntervalMs, 100);
    this.commandTimeoutMs = this.#positive(commandTimeoutMs, 500);
    this.repeatIntervalMs = this.#nonNegative(repeatIntervalMs, 500);

    this.pendingCommand = null;
    this.processing = false;
    this.stopped = false;
    this.connected = false;
    this.lastSentKey = null;
    this.lastSentAt = 0;
    this.timer = null;

    this.stats = {
      submitted: 0,
      sent: 0,
      replaced: 0,
      suppressed: 0,
      errors: 0,
      timeouts: 0,
    };
  }

  /** Запускает подключение без блокировки вызывающего видеокадра. */
  start() {
    logger.info(
      `[CAMERA] Диспетчер запущен: driver=${this.driver.constructor.name}, ` +
      `interval=${this.minIntervalMs} мс, repeat=${this.repeatIntervalMs} мс`,
    );

    this.#ensureConnected()
      .then(() => {
        logger.info(`[CAMERA] Драйвер ${this.driver.constructor.name} подключён.`);
      })
      .catch((error) => {
      this.stats.errors += 1;
        logger.error('[CAMERA] Ошибка подключения драйвера:', error.message);
      });
  }

  /**
   * Принимает команду и сразу возвращает управление.
   * @returns {boolean} true, если команда принята.
   */
  submit(command) {
    if (this.stopped) return false;

    const normalized = this.#normalizeCommand(command);
    this.stats.submitted += 1;

    if (this.pendingCommand) this.stats.replaced += 1;
    this.pendingCommand = normalized;

    ptzDiagnostics.updateDispatcher({
      stage: 'SUBMITTED',
      accepted: true,
      pending: true,
      processing: this.processing,
      pan: normalized.pan,
      tilt: normalized.tilt,
      panSpeed: normalized.panSpeed,
      tiltSpeed: normalized.tiltSpeed,
      reason: normalized.reason ?? 'UNKNOWN',
      submittedAt: Date.now(),
    });

    this.#scheduleDrain(0);
    return true;
  }

  /** STOP имеет приоритет и заменяет любую ожидающую команду. */
  stopMotion(reason = 'STOP') {
    return this.submit({
      pan: 'STOP',
      tilt: 'STOP',
      zoom: 'STOP',
      panSpeed: 0,
      tiltSpeed: 0,
      zoomSpeed: 0,
      moving: false,
      reason,
      force: true,
    });
  }

  getStatus() {
    return {
      processing: this.processing,
      pending: Boolean(this.pendingCommand),
      connected: this.connected,
      stopped: this.stopped,
      stats: { ...this.stats },
      capabilities: this.driver.getCapabilities?.() ?? {},
    };
  }

  /** Безопасно останавливает движение и закрывает драйвер. */
  async shutdown(reason = 'SHUTDOWN') {
    if (this.stopped) return;

    this.pendingCommand = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      await this.#withTimeout(
        Promise.resolve(this.driver.stop(reason)),
        this.commandTimeoutMs,
      );
    } catch (error) {
      logger.warn('[CAMERA] Не удалось отправить финальный STOP:', error.message);
    }

    this.stopped = true;
    try {
      await this.driver.disconnect();
    } catch (error) {
      logger.warn('[CAMERA] Ошибка отключения драйвера:', error.message);
    }
    this.connected = false;
  }

  #scheduleDrain(delayMs) {
    if (this.processing || this.timer || this.stopped) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain().catch((error) => {
        this.stats.errors += 1;
        logger.error('[CAMERA] Ошибка диспетчера:', error.message);
      });
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  async #drain() {
    if (this.processing || this.stopped || !this.pendingCommand) return;

    const now = Date.now();
    const waitMs = Math.max(0, this.minIntervalMs - (now - this.lastSentAt));
    if (waitMs > 0) {
      this.#scheduleDrain(waitMs);
      return;
    }

    const command = this.pendingCommand;
    this.pendingCommand = null;
    const key = this.#commandKey(command);
    const repeatElapsed = now - this.lastSentAt >= this.repeatIntervalMs;

    if (!command.force && key === this.lastSentKey && !repeatElapsed) {
      this.stats.suppressed += 1;

      ptzDiagnostics.updateDispatcher({
        stage: 'SUPPRESSED',
        pending: Boolean(this.pendingCommand),
        processing: this.processing,
        pan: command.pan,
        tilt: command.tilt,
        panSpeed: command.panSpeed,
        tiltSpeed: command.tiltSpeed,
        reason: command.reason ?? 'UNKNOWN',
        suppressedAt: Date.now(),
      });

      if (this.pendingCommand) this.#scheduleDrain(0);
      return;
    }

    this.processing = true;
    try {
      await this.#ensureConnected();
      await this.#withTimeout(
        Promise.resolve(this.driver.move(command)),
        this.commandTimeoutMs,
      );
      this.stats.sent += 1;
      this.lastSentKey = key;
      this.lastSentAt = Date.now();

      ptzDiagnostics.updateDispatcher({
        stage: 'SENT',
        pending: Boolean(this.pendingCommand),
        processing: false,
        pan: command.pan,
        tilt: command.tilt,
        panSpeed: command.panSpeed,
        tiltSpeed: command.tiltSpeed,
        reason: command.reason ?? 'UNKNOWN',
        sentAt: this.lastSentAt,
      });
    } catch (error) {
      if (error?.code === 'CAMERA_COMMAND_TIMEOUT') this.stats.timeouts += 1;
      else this.stats.errors += 1;
      logger.error('[CAMERA] Команда не отправлена:', error.message);
    } finally {
      this.processing = false;
      if (this.pendingCommand) this.#scheduleDrain(0);
    }
  }

  async #ensureConnected() {
    if (this.connected) return;
    await this.#withTimeout(
      Promise.resolve(this.driver.connect()),
      this.commandTimeoutMs,
    );
    this.connected = true;
  }

  #withTimeout(promise, timeoutMs) {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`тайм-аут команды камеры: ${timeoutMs} мс`);
        error.code = 'CAMERA_COMMAND_TIMEOUT';
        reject(error);
      }, timeoutMs);
      timeout.unref?.();
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeout);
    });
  }

  #normalizeCommand(command) {
    const source = command && typeof command === 'object' ? command : {};
    return {
      ...source,
      pan: this.#direction(source.pan),
      tilt: this.#direction(source.tilt),
      zoom: this.#direction(source.zoom),
      panSpeed: this.#speed(source.panSpeed),
      tiltSpeed: this.#speed(source.tiltSpeed),
      zoomSpeed: this.#speed(source.zoomSpeed),
      timestamp: Date.now(),
    };
  }

  #direction(value) {
    const normalized = String(value ?? 'STOP').trim().toUpperCase();
    return normalized || 'STOP';
  }

  #speed(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
  }

  #commandKey(command) {
    return [
      command.pan,
      command.tilt,
      command.zoom,
      command.panSpeed.toFixed(3),
      command.tiltSpeed.toFixed(3),
      command.zoomSpeed.toFixed(3),
    ].join(':');
  }

  #nonNegative(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  #positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }
}

module.exports = CameraCommandDispatcher;
