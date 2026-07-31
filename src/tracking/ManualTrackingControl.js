'use strict';


const logger = require('../utils/Logger');
/**
 * Потокобезопасное для однопоточного Node.js хранилище команд ручного выбора.
 * HTTP API записывает сюда намерение оператора, а TrackingManager применяет
 * его на ближайшем видеокадре.
 */
class ManualTrackingControl {
  constructor() {
    this.enabled = true;
    this.pendingCommand = null;
    this.lastObjects = [];
    this.status = {
      mode: 'MANUAL_TRACKING',
      state: 'WAITING_COMMAND',
      enabled: true,
      targetId: null,
      targetCenter: null,
      trackedRect: null,
      frame: null,
      message: 'Ожидание команды API',
    };
  }

  selectById(id) {
    if (!Number.isInteger(id) || id <= 0)
      throw new Error('id должен быть положительным целым числом');
    this.enabled = true;
    this.pendingCommand = { type: 'SELECT_ID', id, createdAt: Date.now() };
  }

  selectByPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error('x и y должны быть числами');
    this.enabled = true;
    this.pendingCommand = {
      type: 'SELECT_POINT',
      x: Math.round(x),
      y: Math.round(y),
      createdAt: Date.now(),
    };
  }

  reset() {
    this.pendingCommand = { type: 'RESET', createdAt: Date.now() };
  }

  disable() {
    this.enabled = false;
    this.pendingCommand = { type: 'DISABLE', createdAt: Date.now() };
  }

  enable() {
    this.enabled = true;
    this.pendingCommand = { type: 'ENABLE', createdAt: Date.now() };
  }

  consumeCommand() {
    const command = this.pendingCommand;
    this.pendingCommand = null;
    return command;
  }

  setObjects(objects) {
    // logger.info('[ManualControl] setObjects', objects.length);

    this.lastObjects = objects.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      centerX: Math.round(item.x + item.width / 2),
      centerY: Math.round(item.y + item.height / 2),
    }));
    // logger.info('[ManualControl] stored', this.lastObjects.length);
  }

  setStatus(status) {
    this.status = { ...this.status, ...status, enabled: this.enabled };
  }

  getStatus() {
    // logger.info('[ManualControl] getStatus', this.lastObjects.length);
    return {
      ...this.status,
      pendingCommand: this.pendingCommand,
      objects: this.lastObjects,
    };
  }
}

module.exports = ManualTrackingControl;
