'use strict';

/**
 * Базовый контракт драйвера управления камерой.
 *
 * Драйвер отвечает только за конкретный протокол устройства: TCP, UDP,
 * HTTP, ONVIF, последовательный порт и т. п. Расчёт ошибки цели, dead zone
 * и выбор скорости в драйвер не входят.
 */
class BaseCameraDriver {
  constructor(options = {}) {
    this.options = { ...options };
    this.connected = false;
  }

  async connect() {
    this.connected = true;
  }

  /** @param {object} _command Универсальная команда CameraController. */
  async move(_command) {
    throw new Error(`${this.constructor.name}.move() не реализован`);
  }

  async stop(reason = 'STOP') {
    return this.move({
      pan: 'STOP',
      tilt: 'STOP',
      zoom: 'STOP',
      panSpeed: 0,
      tiltSpeed: 0,
      zoomSpeed: 0,
      moving: false,
      reason,
    });
  }

  async getStatus() {
    return {
      connected: this.connected,
      driver: this.constructor.name,
    };
  }

  getCapabilities() {
    return {
      continuousMove: false,
      absoluteMove: false,
      relativeMove: false,
      zoom: false,
      presets: false,
      positionFeedback: false,
    };
  }

  async disconnect() {
    this.connected = false;
  }
}

module.exports = BaseCameraDriver;
