'use strict';

/**
 * Выбирает режим грубого или точного центрирования.
 *
 * Модуль ничего не знает о KCF, VADIR, ONVIF и сетевом диспетчере.
 * Он работает только с ошибкой цели относительно центра кадра.
 */
class FineCenteringController {
  constructor(options = {}) {
    this.mode = 'COARSE';
    this.updateConfiguration(options);
  }

  updateConfiguration(options = {}) {
    this.enabled = options.enabled !== false;

    this.enterErrorX = FineCenteringController.#positive(
      options.enterErrorX,
      24,
    );
    this.enterErrorY = FineCenteringController.#positive(
      options.enterErrorY,
      24,
    );

    this.stopErrorX = FineCenteringController.#nonNegative(
      options.stopErrorX,
      5,
    );
    this.stopErrorY = FineCenteringController.#nonNegative(
      options.stopErrorY,
      5,
    );

    this.hysteresis = FineCenteringController.#nonNegative(
      options.hysteresis,
      4,
    );

    this.minPanSpeed = FineCenteringController.#speed(
      options.minPanSpeed,
      0.006,
    );
    this.maxPanSpeed = FineCenteringController.#speed(
      options.maxPanSpeed,
      0.020,
    );

    this.minTiltSpeed = FineCenteringController.#speed(
      options.minTiltSpeed,
      0.005,
    );
    this.maxTiltSpeed = FineCenteringController.#speed(
      options.maxTiltSpeed,
      0.015,
    );

    this.brakingEnabled = Boolean(options.brakingEnabled ?? false);
    this.panLeadPixels = FineCenteringController.#nonNegative(
      options.panLeadPixels,
      0,
    );
    this.tiltLeadPixels = FineCenteringController.#nonNegative(
      options.tiltLeadPixels,
      0,
    );

    if (!this.enabled) this.mode = 'COARSE';

    return this.getConfiguration();
  }

  reset() {
    this.mode = 'COARSE';
  }

  /**
   * Возвращает решение для каждой оси.
   *
   * В FINE одна ось может уже стоять, пока вторая продолжает точную доводку.
   */
  evaluate(errorX, errorY) {
    const absX = Math.abs(Number(errorX) || 0);
    const absY = Math.abs(Number(errorY) || 0);

    if (!this.enabled) {
      this.mode = 'COARSE';
      return this.#coarseResult(absX, absY);
    }

    if (this.mode === 'COARSE') {
      if (absX <= this.enterErrorX && absY <= this.enterErrorY) {
        this.mode = 'FINE';
      }
    } else {
      const leaveX = this.enterErrorX + this.hysteresis;
      const leaveY = this.enterErrorY + this.hysteresis;

      if (absX > leaveX || absY > leaveY) {
        this.mode = 'COARSE';
      }
    }

    if (this.mode !== 'FINE') {
      return this.#coarseResult(absX, absY);
    }

    const effectiveStopX =
      this.stopErrorX +
      (this.brakingEnabled ? this.panLeadPixels : 0);

    const effectiveStopY =
      this.stopErrorY +
      (this.brakingEnabled ? this.tiltLeadPixels : 0);

    const panActive = absX > effectiveStopX;
    const tiltActive = absY > effectiveStopY;

    return {
      mode: 'FINE',
      panActive,
      tiltActive,
      panSpeed: panActive
        ? this.#fineSpeed(
          absX,
          effectiveStopX,
          this.enterErrorX,
          this.minPanSpeed,
          this.maxPanSpeed,
        )
        : 0,
      tiltSpeed: tiltActive
        ? this.#fineSpeed(
          absY,
          effectiveStopY,
          this.enterErrorY,
          this.minTiltSpeed,
          this.maxTiltSpeed,
        )
        : 0,
      absErrorX: absX,
      absErrorY: absY,
      stopErrorX: effectiveStopX,
      stopErrorY: effectiveStopY,
      enterErrorX: this.enterErrorX,
      enterErrorY: this.enterErrorY,
      centered: !panActive && !tiltActive,
    };
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      enterErrorX: this.enterErrorX,
      enterErrorY: this.enterErrorY,
      stopErrorX: this.stopErrorX,
      stopErrorY: this.stopErrorY,
      hysteresis: this.hysteresis,
      minPanSpeed: this.minPanSpeed,
      maxPanSpeed: this.maxPanSpeed,
      minTiltSpeed: this.minTiltSpeed,
      maxTiltSpeed: this.maxTiltSpeed,
      brakingEnabled: this.brakingEnabled,
      panLeadPixels: this.panLeadPixels,
      tiltLeadPixels: this.tiltLeadPixels,
    };
  }

  #coarseResult(absX, absY) {
    return {
      mode: 'COARSE',
      panActive: null,
      tiltActive: null,
      panSpeed: null,
      tiltSpeed: null,
      absErrorX: absX,
      absErrorY: absY,
      stopErrorX: this.stopErrorX,
      stopErrorY: this.stopErrorY,
      enterErrorX: this.enterErrorX,
      enterErrorY: this.enterErrorY,
      centered: false,
    };
  }

  #fineSpeed(error, stopError, enterError, minSpeed, maxSpeed) {
    const range = Math.max(1, enterError - stopError);
    const normalized = Math.min(
      1,
      Math.max(0, (error - stopError) / range),
    );

    const low = Math.min(minSpeed, maxSpeed);
    const high = Math.max(minSpeed, maxSpeed);

    return low + normalized * (high - low);
  }

  static #speed(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(1, Math.max(0, number))
      : fallback;
  }

  static #positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? number
      : fallback;
  }

  static #nonNegative(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? number
      : fallback;
  }
}

module.exports = FineCenteringController;
