'use strict';

const BaseCameraDriver = require('./BaseCameraDriver');
const logger = require('../../utils/Logger');

/**
 * Безопасный тестовый драйвер.
 * Не двигает физическую камеру, а выводит нормализованные команды в журнал.
 */
class ConsoleCameraDriver extends BaseCameraDriver {
  constructor(options = {}) {
    super(options);
    this.lastCommandKey = null;
  }

  async connect() {
    await super.connect();
    logger.info('[CAMERA] ConsoleCameraDriver подключён (режим симуляции).');
  }

  async move(command) {
    if (!this.connected) await this.connect();

    const safeCommand = command && typeof command === 'object' ? command : {};
    const key = [
      safeCommand.pan ?? 'STOP',
      safeCommand.tilt ?? 'STOP',
      Number(safeCommand.panSpeed ?? 0).toFixed(3),
      Number(safeCommand.tiltSpeed ?? 0).toFixed(3),
    ].join(':');

    // Повторный вывод одинаковой команды подавляется диспетчером, но эта
    // защита полезна при прямом тестировании драйвера.
    if (key !== this.lastCommandKey) {
      logger.info(
        `[CAMERA:SIM] PAN=${safeCommand.pan ?? 'STOP'} ` +
        `speed=${Number(safeCommand.panSpeed ?? 0).toFixed(2)}; ` +
        `TILT=${safeCommand.tilt ?? 'STOP'} ` +
        `speed=${Number(safeCommand.tiltSpeed ?? 0).toFixed(2)}; ` +
        `reason=${safeCommand.reason ?? 'UNKNOWN'}`,
      );
      this.lastCommandKey = key;
    }

    return { success: true, simulated: true };
  }

  getCapabilities() {
    return {
      continuousMove: true,
      absoluteMove: false,
      relativeMove: false,
      zoom: false,
      presets: false,
      positionFeedback: false,
      simulated: true,
    };
  }

  async disconnect() {
    if (this.connected) {
      logger.info('[CAMERA] ConsoleCameraDriver отключён.');
    }
    await super.disconnect();
  }
}

module.exports = ConsoleCameraDriver;
