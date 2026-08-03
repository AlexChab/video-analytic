'use strict';

const BaseCameraDriver = require('./BaseCameraDriver');
const logger = require('../../utils/Logger');

/**
 * Драйвер управления ONVIF PTZ.
 *
 * Драйвер переводит универсальные команды CameraController в ONVIF
 * ContinuousMove/Stop. Видеоконвейер не ожидает эти операции: асинхронность
 * и тайм-ауты контролируются CameraCommandDispatcher.
 *
 * Для работы требуется пакет:
 *   npm install onvif@0.8.1
 */
class OnvifCameraDriver extends BaseCameraDriver {
  constructor(options = {}) {
    super(options);

    this.host = String(options.host || '').trim();
    this.port = Number.parseInt(options.port || '80', 10);
    this.username = String(options.username || '');
    this.password = String(options.password || '');
    this.timeoutMs = this.#positive(options.timeoutMs, 5000);

    // Защита от случайного движения при первой диагностике.
    this.allowMotion = options.allowMotion === true || options.allowMotion === '1';
    this.cam = null;
    this.profileToken = options.profileToken || null;
    this.lastCommand = null;
  }

  async connect() {
    if (this.connected && this.cam) return;
    if (!this.host) throw new Error('ONVIF: не указан host камеры');

    let Cam;
    try {
      ({ Cam } = require('onvif'));
    } catch (error) {
      const dependencyError = new Error(
        'ONVIF: пакет "onvif" не установлен. Выполните: npm install onvif@0.8.1',
      );
      dependencyError.cause = error;
      throw dependencyError;
    }

    this.cam = await new Promise((resolve, reject) => {
      const camera = new Cam(
        {
          hostname: this.host,
          port: this.port,
          username: this.username,
          password: this.password,
          timeout: this.timeoutMs,
          preserveAddress: true,
        },
        (error) => {
          if (error) {
            reject(new Error(`ONVIF: ошибка подключения: ${error.message}`));
            return;
          }
          resolve(camera);
        },
      );
    });

    this.profileToken =
      this.profileToken || this.cam?.activeSource?.profileToken || null;
    this.connected = true;

    logger.info(
      `[CAMERA] ONVIF подключён: ${this.host}:${this.port}; ` +
        `profile=${this.profileToken || 'auto'}; ` +
        `motion=${this.allowMotion ? 'РАЗРЕШЕНО' : 'заблокировано (диагностика)'}`,
    );
  }

  async move(command) {
    if (!this.connected || !this.cam) await this.connect();

    const normalized = this.#normalize(command);
    this.lastCommand = normalized;

    if (!normalized.moving) {
      await this.stop(normalized.reason || 'STOP');
      return;
    }

    if (!this.allowMotion) {
      logger.info(
        `[CAMERA:ONVIF:DRY] x=${normalized.x.toFixed(3)}; ` +
          `y=${normalized.y.toFixed(3)}; z=${normalized.zoom.toFixed(3)}; ` +
          `reason=${normalized.reason}`,
      );
      return;
    }

    const options = {
      x: normalized.x,
      y: normalized.y,
      zoom: normalized.zoom,
      timeout: this.#positive(this.options.moveTimeoutMs, 350),
    };
    if (this.profileToken) options.profileToken = this.profileToken;

    await this.#call('continuousMove', options);
  }

  async stop(reason = 'STOP') {
    if (!this.connected || !this.cam) {
      // Во время завершения приложения соединение могло ещё не установиться.
      return;
    }

    if (!this.allowMotion) {
      logger.info(`[CAMERA:ONVIF:DRY] STOP; reason=${reason}`);
      return;
    }

    const options = { panTilt: true, zoom: true };
    if (this.profileToken) options.profileToken = this.profileToken;
    await this.#call('stop', options);
  }

  async getStatus() {
    if (!this.connected || !this.cam) await this.connect();

    let ptz = null;
    if (typeof this.cam.getStatus === 'function') {
      try {
        const options = this.profileToken
          ? { profileToken: this.profileToken }
          : {};
        ptz = await this.#call('getStatus', options);
      } catch (error) {
        logger.warn('[CAMERA] ONVIF GetStatus недоступен:', error.message);
      }
    }

    return {
      connected: this.connected,
      driver: this.constructor.name,
      host: this.host,
      port: this.port,
      profileToken: this.profileToken,
      allowMotion: this.allowMotion,
      ptz,
      lastCommand: this.lastCommand,
    };
  }

  getCapabilities() {
    return {
      continuousMove: true,
      absoluteMove: false,
      relativeMove: false,
      zoom: true,
      presets: true,
      positionFeedback: true,
      safeDiagnosticMode: !this.allowMotion,
    };
  }

  async disconnect() {
    if (this.connected && this.cam && this.allowMotion) {
      try {
        await this.stop('DISCONNECT');
      } catch (error) {
        logger.warn('[CAMERA] ONVIF STOP при отключении не выполнен:', error.message);
      }
    }
    this.cam = null;
    this.connected = false;
  }

  #call(methodName, options = {}) {
    return new Promise((resolve, reject) => {
      const method = this.cam?.[methodName];
      if (typeof method !== 'function') {
        reject(new Error(`ONVIF: метод ${methodName} не поддерживается клиентом`));
        return;
      }

      method.call(this.cam, options, (error, result) => {
        if (error) {
          reject(new Error(`ONVIF ${methodName}: ${error.message}`));
          return;
        }
        resolve(result);
      });
    });
  }

  #normalize(command = {}) {
    const panDirection = String(command.pan || 'STOP').toUpperCase();
    const tiltDirection = String(command.tilt || 'STOP').toUpperCase();
    const zoomDirection = String(command.zoom || 'STOP').toUpperCase();

    return {
      x: this.#signedSpeed(
        panDirection,
        command.panSpeed,
        'RIGHT',
        'LEFT',
      ),
      // В стандартном ONVIF ContinuousMove положительный Y соответствует UP.
      y: this.#signedSpeed(
        tiltDirection,
        command.tiltSpeed,
        'UP',
        'DOWN',
      ),
      zoom: this.#signedSpeed(
        zoomDirection,
        command.zoomSpeed,
        'IN',
        'OUT',
      ),
      moving: Boolean(command.moving),
      reason: String(command.reason || 'TRACKING'),
    };
  }

  #signedSpeed(direction, speed, positiveDirection, negativeDirection) {
    const value = this.#speed(speed);
    if (direction === positiveDirection) return value;
    if (direction === negativeDirection) return -value;
    return 0;
  }

  #speed(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
  }

  #positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }
}

module.exports = OnvifCameraDriver;
