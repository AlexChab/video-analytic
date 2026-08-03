'use strict';

const ConsoleCameraDriver = require('./drivers/ConsoleCameraDriver');
const OnvifCameraDriver = require('./drivers/OnvifCameraDriver');

/** Создаёт драйвер по имени из конфигурации устройства. */
class CameraDriverFactory {
  static create(driverName, options = {}) {
    const normalized = String(driverName || 'console').trim().toLowerCase();

    switch (normalized) {
      case 'console':
      case 'simulation':
        return new ConsoleCameraDriver(options);
      case 'onvif':
        return new OnvifCameraDriver(options);
      default:
        throw new Error(`Неизвестный драйвер камеры: ${driverName}`);
    }
  }
}

module.exports = CameraDriverFactory;
