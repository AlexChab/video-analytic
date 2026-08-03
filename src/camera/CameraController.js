'use strict';

const logger = require('../utils/Logger');
const KalmanTargetFilter = require('../tracking/KalmanTargetFilter');

/**
 * Универсальный контроллер наведения камеры по координатам цели.
 *
 * Класс не знает протокол устройства. Он только:
 * - фильтрует центр цели;
 * - вычисляет ошибку относительно центра кадра;
 * - применяет мёртвую зону;
 * - рассчитывает нормализованную скорость 0..1;
 * - передаёт последнюю команду в CameraCommandDispatcher.
 */
class CameraController {
  constructor({
    frameWidth,
    frameHeight,
    commandDispatcher = null,
    deadZoneX = 100,
    deadZoneY = 70,
    kalmanEnabled = true,
    kalmanProcessNoise = 35,
    kalmanMeasurementNoise = 90,
    predictionLeadMs = 120,
    minPanSpeed = 0.15,
    maxPanSpeed = 1,
    minTiltSpeed = 0.15,
    maxTiltSpeed = 1,
    invertPan = false,
    invertTilt = false,
  }) {
    if (!Number.isFinite(frameWidth) || frameWidth <= 0 ||
        !Number.isFinite(frameHeight) || frameHeight <= 0) {
      throw new Error('CameraController: размеры кадра должны быть положительными');
    }

    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.frameCenter = { x: frameWidth / 2, y: frameHeight / 2 };
    this.commandDispatcher = commandDispatcher;

    this.filter = new KalmanTargetFilter({
      processNoise: kalmanProcessNoise,
      measurementNoise: kalmanMeasurementNoise,
    });

    this.updateConfiguration({
      deadZoneX,
      deadZoneY,
      kalmanEnabled,
      predictionLeadMs,
      minPanSpeed,
      maxPanSpeed,
      minTiltSpeed,
      maxTiltSpeed,
      invertPan,
      invertTilt,
    });
  }

  updateConfiguration(configuration = {}) {
    if (Number.isFinite(Number(configuration.deadZoneX))) {
      this.deadZoneX = this.#nonNegative(Number(configuration.deadZoneX), 100);
    }
    if (Number.isFinite(Number(configuration.deadZoneY))) {
      this.deadZoneY = this.#nonNegative(Number(configuration.deadZoneY), 70);
    }
    if (configuration.kalmanEnabled !== undefined) {
      this.kalmanEnabled = Boolean(configuration.kalmanEnabled);
    }
    if (Number.isFinite(Number(configuration.predictionLeadMs))) {
      this.predictionLeadSeconds = this.#nonNegative(
        Number(configuration.predictionLeadMs),
        0,
      ) / 1000;
    }

    this.minPanSpeed = this.#clampSpeed(
      configuration.minPanSpeed ?? this.minPanSpeed ?? 0.15,
    );
    this.maxPanSpeed = this.#clampSpeed(
      configuration.maxPanSpeed ?? this.maxPanSpeed ?? 1,
    );
    this.minTiltSpeed = this.#clampSpeed(
      configuration.minTiltSpeed ?? this.minTiltSpeed ?? 0.15,
    );
    this.maxTiltSpeed = this.#clampSpeed(
      configuration.maxTiltSpeed ?? this.maxTiltSpeed ?? 1,
    );
    this.invertPan = Boolean(configuration.invertPan ?? this.invertPan ?? false);
    this.invertTilt = Boolean(configuration.invertTilt ?? this.invertTilt ?? false);

    return this.getConfiguration();
  }

  getConfiguration() {
    return {
      deadZoneX: this.deadZoneX,
      deadZoneY: this.deadZoneY,
      kalmanEnabled: this.kalmanEnabled,
      predictionLeadMs: this.predictionLeadSeconds * 1000,
      minPanSpeed: this.minPanSpeed,
      maxPanSpeed: this.maxPanSpeed,
      minTiltSpeed: this.minTiltSpeed,
      maxTiltSpeed: this.maxTiltSpeed,
      invertPan: this.invertPan,
      invertTilt: this.invertTilt,
    };
  }

  calculate(targetCenter, timestampMs = Date.now()) {
    if (!this.#isValidPoint(targetCenter)) {
      return this.#stopCommand('INVALID_TARGET');
    }

    let filtered = { x: targetCenter.x, y: targetCenter.y, vx: 0, vy: 0 };
    if (this.kalmanEnabled) {
      const estimate = this.filter.update(targetCenter, timestampMs);
      if (estimate) filtered = estimate;
    }

    const controlPoint = {
      x: filtered.x + filtered.vx * this.predictionLeadSeconds,
      y: filtered.y + filtered.vy * this.predictionLeadSeconds,
    };
    if (!this.#isValidPoint(controlPoint)) {
      return this.#stopCommand('INVALID_FILTER_RESULT');
    }

    const errorX = controlPoint.x - this.frameCenter.x;
    const errorY = controlPoint.y - this.frameCenter.y;
    const panDirection = this.#axisDirection(
      errorX,
      this.deadZoneX,
      'LEFT',
      'RIGHT',
      this.invertPan,
    );
    const tiltDirection = this.#axisDirection(
      errorY,
      this.deadZoneY,
      'UP',
      'DOWN',
      this.invertTilt,
    );

    const panSpeed = panDirection === 'STOP'
      ? 0
      : this.#calculateAxisSpeed(
        Math.abs(errorX),
        this.deadZoneX,
        this.frameWidth / 2,
        this.minPanSpeed,
        this.maxPanSpeed,
      );
    const tiltSpeed = tiltDirection === 'STOP'
      ? 0
      : this.#calculateAxisSpeed(
        Math.abs(errorY),
        this.deadZoneY,
        this.frameHeight / 2,
        this.minTiltSpeed,
        this.maxTiltSpeed,
      );

    return {
      pan: panDirection,
      tilt: tiltDirection,
      zoom: 'STOP',
      panSpeed,
      tiltSpeed,
      zoomSpeed: 0,
      errorX,
      errorY,
      moving: panDirection !== 'STOP' || tiltDirection !== 'STOP',
      rawTargetCenter: { x: targetCenter.x, y: targetCenter.y },
      filteredTargetCenter: { x: filtered.x, y: filtered.y },
      controlPoint,
      velocity: { x: filtered.vx, y: filtered.vy },
      kalmanEnabled: this.kalmanEnabled,
      reason: 'TRACKING',
    };
  }

  /** Передаёт команду асинхронному диспетчеру без ожидания сети. */
  execute(command, state) {
    const safeCommand = command && typeof command === 'object'
      ? command
      : this.#stopCommand('INVALID_COMMAND');

    if (this.commandDispatcher) {
      this.commandDispatcher.submit({ ...safeCommand, state });
      return;
    }

    // Резервный лог нужен для запуска старых тестов без CameraDispatcher.
    logger.info(
      `[CAMERA] state=${state}, PAN=${safeCommand.pan}, ` +
      `panSpeed=${safeCommand.panSpeed.toFixed(2)}, ` +
      `TILT=${safeCommand.tilt}, tiltSpeed=${safeCommand.tiltSpeed.toFixed(2)}`,
    );
  }

  reset(reason = 'RESET') {
    this.filter.reset();
    this.commandDispatcher?.stopMotion(reason);
    logger.info(`[CAMERA] Контур наведения сброшен: ${reason}`);
  }

  #stopCommand(reason) {
    return {
      pan: 'STOP',
      tilt: 'STOP',
      zoom: 'STOP',
      panSpeed: 0,
      tiltSpeed: 0,
      zoomSpeed: 0,
      errorX: 0,
      errorY: 0,
      moving: false,
      rawTargetCenter: null,
      filteredTargetCenter: null,
      controlPoint: null,
      velocity: { x: 0, y: 0 },
      kalmanEnabled: this.kalmanEnabled,
      reason,
    };
  }

  #axisDirection(error, deadZone, negative, positive, inverted) {
    let direction = 'STOP';
    if (error < -deadZone) direction = negative;
    else if (error > deadZone) direction = positive;

    if (!inverted || direction === 'STOP') return direction;
    return direction === negative ? positive : negative;
  }

  #calculateAxisSpeed(error, deadZone, maxError, minSpeed, maxSpeed) {
    const activeRange = Math.max(1, maxError - deadZone);
    const normalized = Math.min(1, Math.max(0, (error - deadZone) / activeRange));
    const low = Math.min(minSpeed, maxSpeed);
    const high = Math.max(minSpeed, maxSpeed);
    return low + normalized * (high - low);
  }

  #isValidPoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  #nonNegative(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  #clampSpeed(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
  }
}

module.exports = CameraController;
