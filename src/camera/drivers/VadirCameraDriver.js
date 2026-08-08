'use strict';

const BaseCameraDriver = require('./BaseCameraDriver');
const VadirCameraClient = require('../vadir/VadirCameraClient');
const logger = require('../../utils/Logger');
const ptzDiagnostics = require('../PtzDiagnosticsStore');

/**
 * Драйвер управления VADIR через TCP-протокол камеры.
 *
 * На вход получает универсальную команду CameraController:
 *
 * {
 *   pan: 'LEFT' | 'RIGHT' | 'STOP',
 *   tilt: 'UP' | 'DOWN' | 'STOP',
 *   zoom: 'IN' | 'OUT' | 'STOP',
 *   panSpeed: 0..1,
 *   tiltSpeed: 0..1,
 *   zoomSpeed: 0..1,
 * }
 *
 * Расчёт ошибки цели, dead zone и инверсия осей остаются за пределами
 * драйвера. Драйвер только переводит уже готовую команду в протокол VADIR.
 */
class VadirCameraDriver extends BaseCameraDriver {
  constructor(options = {}) {
    super(options);

    this.host = String(options.host ?? '').trim();
    this.port = this.#positiveInteger(options.port, 10930);

    this.allowMotion = this.#boolean(options.allowMotion, false);
    this.allowZoom = this.#boolean(
      options.allowZoom,
      this.allowMotion,
    );
    this.logCommands = this.#boolean(options.logCommands, true);
    this.ptzTraceEnabled = this.#boolean(
      process.env.PTZ_TRACE_ENABLED,
      false,
    );
    this.pollTelemetry = this.#boolean(options.pollTelemetry, false);

    this.maxPanRate = this.#positiveNumber(options.maxPanRate, 15.70);
    this.maxTiltRate = this.#positiveNumber(options.maxTiltRate, 10.46);
    this.maxZoomRate = this.#positiveNumber(options.maxZoomRate, 50);

    this.client = new VadirCameraClient({
      host: this.host,
      port: this.port,
      pollIntervalMs: this.#positiveInteger(
        options.pollIntervalMs,
        120,
      ),
      responseTimeoutMs: this.#positiveInteger(
        options.responseTimeoutMs,
        2000,
      ),
      reconnectDelayMs: this.#positiveInteger(
        options.reconnectDelayMs,
        1000,
      ),
    });

    this.lastCommandKey = null;
    this.lastTelemetry = null;
    this.lastWarning = null;
    this.lastError = null;

    this.#attachClientEvents();
  }

  async connect() {
    if (this.connected && this.client.connected) return;

    if (!this.host) {
      throw new Error('VadirCameraDriver: не указан host камеры');
    }

    await this.client.connect();
    this.connected = true;

    if (this.pollTelemetry) {
      this.client.startPolling();
    }

    logger.info(
      `[CAMERA] VADIR подключён: ${this.host}:${this.port}; ` +
      `motion=${this.allowMotion ? 'разрешено' : 'заблокировано'}; ` +
      `zoom=${this.allowZoom ? 'разрешён' : 'заблокирован'}; ` +
      `telemetry=${this.pollTelemetry ? 'включена' : 'выключена'}`,
    );
  }

  async move(command = {}) {
    if (!this.connected || !this.client.connected) {
      await this.connect();
    }

    const motion = this.#commandToMotion(command);
    const zoomRate = this.#commandToZoomRate(command);

    ptzDiagnostics.updateDriver({
      stage: 'RECEIVED',
      driver: 'VadirCameraDriver',
      dryRun: !this.allowMotion,
      pan: command.pan ?? 'STOP',
      tilt: command.tilt ?? 'STOP',
      panSpeed: Number(command.panSpeed ?? 0),
      tiltSpeed: Number(command.tiltSpeed ?? 0),
      panRate: motion.panRate,
      tiltRate: motion.tiltRate,
      zoomRate,
      reason: command.reason ?? 'UNKNOWN',
      receivedAt: Date.now(),
    });

    if (this.ptzTraceEnabled) {
      logger.info(
        '[CAMERA] VADIR MOVE ENTER: ' +
        `PAN=${command.pan ?? 'STOP'}; ` +
        `panSpeed=${Number(command.panSpeed ?? 0).toFixed(3)}; ` +
        `TILT=${command.tilt ?? 'STOP'}; ` +
        `tiltSpeed=${Number(command.tiltSpeed ?? 0).toFixed(3)}; ` +
        `moving=${Boolean(command.moving)}; ` +
        `allowMotion=${this.allowMotion}; ` +
        `panRate=${motion.panRate.toFixed(3)}; ` +
        `tiltRate=${motion.tiltRate.toFixed(3)}; ` +
        `reason=${command.reason ?? 'UNKNOWN'}`,
      );
    }

    const key = [
      motion.panRate.toFixed(3),
      motion.tiltRate.toFixed(3),
      zoomRate.toFixed(3),
      command.reason ?? 'UNKNOWN',
    ].join(':');

    const stopMotion =
      !command.moving ||
      (motion.panRate === 0 && motion.tiltRate === 0);

    if (!this.allowMotion && !stopMotion) {
      this.#logDryCommand(command, motion, zoomRate, key);
      this.lastCommandKey = key;

      ptzDiagnostics.updateDriver({
        stage: 'DRY_RUN',
        driver: 'VadirCameraDriver',
        dryRun: true,
        pan: command.pan ?? 'STOP',
        tilt: command.tilt ?? 'STOP',
        panRate: motion.panRate,
        tiltRate: motion.tiltRate,
        reason: command.reason ?? 'UNKNOWN',
        completedAt: Date.now(),
      });

      this.#writeConsolidatedDiagnostics();

      return {
        success: true,
        dryRun: true,
        motion,
        zoomRate,
      };
    }

    /*
     * STOP разрешён даже при allowMotion=false. Это безопасно и позволяет
     * гарантированно остановить платформу после диагностического запуска.
     */
    await this.client.setMotion(
      stopMotion ? 0 : motion.panRate,
      stopMotion ? 0 : motion.tiltRate,
    );

    if (this.allowZoom) {
      await this.client.setDayZoomRate(zoomRate);
    } else if (zoomRate === 0) {
      /*
       * Нулевая команда безопасна и останавливает ранее запущенный зум.
       */
      await this.client.setDayZoomRate(0);
    }

    if (this.ptzTraceEnabled && stopMotion) {
      logger.info(
        '[CAMERA] VADIR STOP COMMAND: ' +
        `reason=${command.reason ?? 'UNKNOWN'}; ` +
        `allowMotion=${this.allowMotion}`,
      );
    }

    if (this.logCommands && key !== this.lastCommandKey) {
      logger.info(
        `[CAMERA:VADIR] panRate=${motion.panRate.toFixed(3)}; ` +
        `tiltRate=${motion.tiltRate.toFixed(3)}; ` +
        `zoomRate=${zoomRate.toFixed(3)}; ` +
        `PAN=${command.pan ?? 'STOP'}; ` +
        `TILT=${command.tilt ?? 'STOP'}; ` +
        `ZOOM=${command.zoom ?? 'STOP'}; ` +
        `reason=${command.reason ?? 'UNKNOWN'}`,
      );
    }

    this.lastCommandKey = key;

    ptzDiagnostics.updateDriver({
      stage: 'SENT',
      driver: 'VadirCameraDriver',
      dryRun: false,
      pan: command.pan ?? 'STOP',
      tilt: command.tilt ?? 'STOP',
      panRate: motion.panRate,
      tiltRate: motion.tiltRate,
      reason: command.reason ?? 'UNKNOWN',
      completedAt: Date.now(),
    });

    this.#writeConsolidatedDiagnostics();

    return {
      success: true,
      dryRun: false,
      motion,
      zoomRate,
    };
  }

  async stop(reason = 'STOP') {
    if (!this.connected || !this.client.connected) {
      /*
       * Если соединение отсутствует, не открываем его только ради STOP.
       */
      return {
        success: true,
        skipped: true,
        reason,
      };
    }

    await this.client.stopMotion();
    await this.client.stopZoom();

    this.lastCommandKey = null;

    if (this.logCommands) {
      logger.info(`[CAMERA:VADIR] STOP; reason=${reason}`);
    }

    return {
      success: true,
      reason,
    };
  }

  async getStatus() {
    return {
      connected: this.connected && this.client.connected,
      driver: this.constructor.name,
      host: this.host,
      port: this.port,
      allowMotion: this.allowMotion,
      allowZoom: this.allowZoom,
      pollTelemetry: this.pollTelemetry,
      telemetry: this.lastTelemetry
        ? { ...this.lastTelemetry }
        : { ...this.client.telemetry },
      lastWarning: this.lastWarning,
      lastError: this.lastError,
    };
  }

  getCapabilities() {
    return {
      continuousMove: true,
      absoluteMove: false,
      relativeMove: false,
      zoom: true,
      presets: false,
      positionFeedback: this.pollTelemetry,
      protocol: 'VADIR_TCP',
    };
  }

  async disconnect() {
    try {
      await this.client.close();
    } finally {
      this.connected = false;
      this.lastCommandKey = null;
    }
  }

  #commandToMotion(command) {
    const panSpeed = this.#speed(command.panSpeed);
    const tiltSpeed = this.#speed(command.tiltSpeed);

    let panRate = 0;
    let tiltRate = 0;

    switch (String(command.pan ?? 'STOP').toUpperCase()) {
      case 'LEFT':
        panRate = -this.maxPanRate * panSpeed;
        break;
      case 'RIGHT':
        panRate = this.maxPanRate * panSpeed;
        break;
      default:
        panRate = 0;
    }

    switch (String(command.tilt ?? 'STOP').toUpperCase()) {
      case 'UP':
        tiltRate = this.maxTiltRate * tiltSpeed;
        break;
      case 'DOWN':
        tiltRate = -this.maxTiltRate * tiltSpeed;
        break;
      default:
        tiltRate = 0;
    }

    return {
      panRate,
      tiltRate,
    };
  }

  #commandToZoomRate(command) {
    const zoomSpeed = this.#speed(command.zoomSpeed);
    const direction = String(command.zoom ?? 'STOP').toUpperCase();

    if (direction === 'IN' || direction === 'ZOOM_IN') {
      return this.maxZoomRate * zoomSpeed;
    }

    if (direction === 'OUT' || direction === 'ZOOM_OUT') {
      return -this.maxZoomRate * zoomSpeed;
    }

    return 0;
  }

  #writeConsolidatedDiagnostics() {
    if (!ptzDiagnostics.shouldWriteLog()) return;

    logger.info(
      `[PTZ] DIAG: ${ptzDiagnostics.formatSnapshot()}`,
    );
  }

  #attachClientEvents() {
    this.client.on('connected', () => {
      this.connected = true;
    });

    this.client.on('disconnected', () => {
      this.connected = false;
    });

    this.client.on('telemetry', (telemetry) => {
      this.lastTelemetry = { ...telemetry };
    });

    this.client.on('warning', (message) => {
      this.lastWarning = String(message);
      logger.warn(`[CAMERA:VADIR] ${message}`);
    });

    /*
     * EventEmitter завершает процесс, если событие error не имеет обработчика.
     * Поэтому ошибка всегда перехватывается и передаётся в журнал проекта.
     */
    this.client.on('error', (error) => {
      this.lastError = error?.message ?? String(error);
      this.connected = false;
      logger.error(`[CAMERA:VADIR] ${this.lastError}`);
    });

    if (this.logCommands) {
      this.client.on('tx', (command) => {
        logger.debug?.(`[CAMERA:VADIR:TX] ${command}`);
      });
    }
  }

  #logDryCommand(command, motion, zoomRate, key) {
    if (!this.logCommands || key === this.lastCommandKey) return;

    logger.info(
      `[CAMERA:VADIR:DRY] panRate=${motion.panRate.toFixed(3)}; ` +
      `tiltRate=${motion.tiltRate.toFixed(3)}; ` +
      `zoomRate=${zoomRate.toFixed(3)}; ` +
      `PAN=${command.pan ?? 'STOP'}; ` +
      `TILT=${command.tilt ?? 'STOP'}; ` +
      `reason=${command.reason ?? 'UNKNOWN'}`,
    );
  }

  #speed(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(1, Math.max(0, number))
      : 0;
  }

  #positiveInteger(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0
      ? number
      : fallback;
  }

  #positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? number
      : fallback;
  }

  #boolean(value, fallback) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value === 'boolean') return value;

    return ['1', 'true', 'yes', 'on'].includes(
      String(value).trim().toLowerCase(),
    );
  }
}

module.exports = VadirCameraDriver;
