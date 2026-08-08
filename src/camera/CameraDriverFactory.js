'use strict';

/**
 * Создаёт драйвер по имени из конфигурации потока.
 *
 * Драйверы подключаются лениво. Это позволяет запускать тесты VADIR
 * без установленного пакета ONVIF и наоборот.
 */
class CameraDriverFactory {
  static create(driverName, options = {}) {
    const normalized = String(driverName || 'console')
      .trim()
      .toLowerCase();

    switch (normalized) {
      case 'console':
      case 'simulation': {
        const ConsoleCameraDriver = require(
          './drivers/ConsoleCameraDriver',
        );
        return new ConsoleCameraDriver(options);
      }

      case 'onvif': {
        const OnvifCameraDriver = require(
          './drivers/OnvifCameraDriver',
        );
        return new OnvifCameraDriver(options);
      }

      case 'vadir':
      case 'vadir-tcp': {
        const VadirCameraDriver = require(
          './drivers/VadirCameraDriver',
        );
        return new VadirCameraDriver(options);
      }

      default:
        throw new Error(
          `Неизвестный драйвер камеры: ${driverName}`,
        );
    }
  }
}

module.exports = CameraDriverFactory;
