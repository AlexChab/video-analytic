'use strict';


const logger = require('../utils/Logger');
const KalmanTargetFilter = require('./KalmanTargetFilter');

/**
 * Рассчитывает команды управления PTZ-камерой.
 *
 * Центр цели предварительно сглаживается фильтром Калмана. Это уменьшает
 * дрожание команд LEFT/RIGHT/UP/DOWN из-за шумов CSRT и детектора.
 *
 * Сейчас execute() только выводит команды в консоль. В дальнейшем в этом
 * методе можно подключить HTTP-, ONVIF- или фирменный клиент камеры.
 */
class PtzController {
  constructor({
    frameWidth,
    frameHeight,
    deadZoneX = 100,
    deadZoneY = 70,
    commandIntervalMs = 300,
    kalmanEnabled = true,
    kalmanProcessNoise = 35,
    kalmanMeasurementNoise = 90,
    predictionLeadMs = 120,
  }) {
    if (!Number.isFinite(frameWidth) || frameWidth <= 0 ||
        !Number.isFinite(frameHeight) || frameHeight <= 0) {
      throw new Error('PtzController: frameWidth и frameHeight должны быть положительными числами');
    }

    this.frameCenter = { x: frameWidth / 2, y: frameHeight / 2 };
    this.deadZoneX = this.#nonNegative(deadZoneX, 100);
    this.deadZoneY = this.#nonNegative(deadZoneY, 70);
    this.commandIntervalMs = this.#nonNegative(commandIntervalMs, 300);
    this.kalmanEnabled = Boolean(kalmanEnabled);
    this.predictionLeadSeconds = this.#nonNegative(predictionLeadMs, 120) / 1000;

    this.filter = new KalmanTargetFilter({
      processNoise: kalmanProcessNoise,
      measurementNoise: kalmanMeasurementNoise,
    });

    this.lastCommandKey = null;
    this.lastCommandTime = 0;
  }

  /**
   * Применяет новые параметры PTZ без пересоздания TrackingManager.
   * При изменении параметров Калмана фильтр пересоздаётся и очищается.
   */
  updateConfiguration({
    deadZoneX,
    deadZoneY,
    commandIntervalMs,
    kalmanEnabled,
    kalmanProcessNoise,
    kalmanMeasurementNoise,
    predictionLeadMs,
  } = {}) {
    if (Number.isFinite(Number(deadZoneX))) {
      this.deadZoneX = this.#nonNegative(Number(deadZoneX), this.deadZoneX);
    }
    if (Number.isFinite(Number(deadZoneY))) {
      this.deadZoneY = this.#nonNegative(Number(deadZoneY), this.deadZoneY);
    }
    if (Number.isFinite(Number(commandIntervalMs))) {
      this.commandIntervalMs = this.#nonNegative(Number(commandIntervalMs), this.commandIntervalMs);
    }
    if (kalmanEnabled !== undefined) {
      this.kalmanEnabled = Boolean(kalmanEnabled);
    }
    if (Number.isFinite(Number(predictionLeadMs))) {
      this.predictionLeadSeconds = this.#nonNegative(Number(predictionLeadMs), 0) / 1000;
    }

    const processNoiseChanged = Number.isFinite(Number(kalmanProcessNoise));
    const measurementNoiseChanged = Number.isFinite(Number(kalmanMeasurementNoise));

    if (processNoiseChanged || measurementNoiseChanged) {
      this.filter = new KalmanTargetFilter({
        processNoise: processNoiseChanged ? Number(kalmanProcessNoise) : 35,
        measurementNoise: measurementNoiseChanged ? Number(kalmanMeasurementNoise) : 90,
      });
      this.lastCommandKey = null;
      this.lastCommandTime = 0;
    }

    return {
      deadZoneX: this.deadZoneX,
      deadZoneY: this.deadZoneY,
      commandIntervalMs: this.commandIntervalMs,
      kalmanEnabled: this.kalmanEnabled,
      predictionLeadMs: this.predictionLeadSeconds * 1000,
    };
  }

  /**
   * Рассчитывает PTZ-команду по центру цели.
   *
   * @param {{x:number,y:number}|null} targetCenter
   * @param {number} [timestampMs=Date.now()]
   */
  calculate(targetCenter, timestampMs = Date.now()) {
    if (!this.#isValidPoint(targetCenter)) {
      return this.#stopCommand('INVALID_TARGET');
    }

    let filtered = {
      x: targetCenter.x,
      y: targetCenter.y,
      vx: 0,
      vy: 0,
    };

    if (this.kalmanEnabled) {
      const estimate = this.filter.update(targetCenter, timestampMs);
      if (estimate) filtered = estimate;
    }

    // Небольшое упреждение компенсирует задержку видеопотока и команды камеры.
    const controlPoint = {
      x: filtered.x + filtered.vx * this.predictionLeadSeconds,
      y: filtered.y + filtered.vy * this.predictionLeadSeconds,
    };

    if (!this.#isValidPoint(controlPoint)) {
      return this.#stopCommand('INVALID_FILTER_RESULT');
    }

    const errorX = controlPoint.x - this.frameCenter.x;
    const errorY = controlPoint.y - this.frameCenter.y;

    let pan = 'STOP';
    let tilt = 'STOP';

    if (errorX < -this.deadZoneX) pan = 'LEFT';
    else if (errorX > this.deadZoneX) pan = 'RIGHT';

    if (errorY < -this.deadZoneY) tilt = 'UP';
    else if (errorY > this.deadZoneY) tilt = 'DOWN';

    return {
      pan,
      tilt,
      errorX,
      errorY,
      moving: pan !== 'STOP' || tilt !== 'STOP',
      rawTargetCenter: { x: targetCenter.x, y: targetCenter.y },
      filteredTargetCenter: { x: filtered.x, y: filtered.y },
      controlPoint,
      velocity: { x: filtered.vx, y: filtered.vy },
      kalmanEnabled: this.kalmanEnabled,
      reason: 'TRACKING',
    };
  }

  /**
   * Сбрасывает фильтр после выбора новой цели, потери цели или отключения.
   * Это не позволяет старой скорости повлиять на новую цель.
   */
  reset(reason = 'RESET') {
    this.filter.reset();
    this.lastCommandKey = null;
    this.lastCommandTime = 0;
    logger.info(`[PTZ] Фильтр Калмана сброшен: ${reason}`);
  }

  /** Пока только выводит команду в консоль. */
  execute(command, state) {
    const safeCommand = command && typeof command === 'object'
      ? command
      : this.#stopCommand('INVALID_COMMAND');

    const commandKey = `${state}:${safeCommand.pan}:${safeCommand.tilt}`;
    const currentTime = Date.now();
    const commandChanged = commandKey !== this.lastCommandKey;
    const intervalElapsed = currentTime - this.lastCommandTime >= this.commandIntervalMs;

    if (!commandChanged && !intervalElapsed) return;

    const filtered = safeCommand.filteredTargetCenter;
    const filteredText = filtered
      ? `, filteredX=${Math.round(filtered.x)}, filteredY=${Math.round(filtered.y)}`
      : '';

    logger.info(
      `[PTZ] state=${state}, PAN=${safeCommand.pan}, TILT=${safeCommand.tilt}, ` +
      `errorX=${Math.round(safeCommand.errorX || 0)}, ` +
      `errorY=${Math.round(safeCommand.errorY || 0)}${filteredText}`,
    );

    this.lastCommandKey = commandKey;
    this.lastCommandTime = currentTime;
  }

  #stopCommand(reason) {
    return {
      pan: 'STOP',
      tilt: 'STOP',
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

  #isValidPoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  #nonNegative(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }
}

module.exports = PtzController;
