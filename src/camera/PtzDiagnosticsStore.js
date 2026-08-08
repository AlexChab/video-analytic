'use strict';

class PtzDiagnosticsStore {
  constructor() {
    this.logEnabled = false;
    this.logIntervalMs = 500;
    this.lastLogAt = 0;
    this.reset();
  }

  configure(options = {}) {
    if (options.logEnabled !== undefined) {
      this.logEnabled = Boolean(options.logEnabled);
    }

    const interval = Number(options.logIntervalMs);
    if (Number.isFinite(interval) && interval >= 50) {
      this.logIntervalMs = Math.round(interval);
    }

    return {
      logEnabled: this.logEnabled,
      logIntervalMs: this.logIntervalMs,
    };
  }

  reset() {
    this.snapshot = {
      updatedAt: 0,
      controller: null,
      dispatcher: null,
      driver: null,
    };
  }

  updateController(data) {
    this.snapshot.controller = { ...data, updatedAt: Date.now() };
    this.snapshot.updatedAt = Date.now();
  }

  updateDispatcher(data) {
    this.snapshot.dispatcher = {
      ...(this.snapshot.dispatcher ?? {}),
      ...data,
      updatedAt: Date.now(),
    };
    this.snapshot.updatedAt = Date.now();
  }

  updateDriver(data) {
    this.snapshot.driver = {
      ...(this.snapshot.driver ?? {}),
      ...data,
      updatedAt: Date.now(),
    };
    this.snapshot.updatedAt = Date.now();
  }

  shouldWriteLog(now = Date.now()) {
    if (!this.logEnabled) return false;
    if (now - this.lastLogAt < this.logIntervalMs) return false;

    this.lastLogAt = now;
    return true;
  }

  formatSnapshot() {
    const snapshot = this.getSnapshot();
    const controller = snapshot.controller ?? {};
    const raw = controller.raw ?? {};
    const stable = controller.stable ?? {};
    const dispatcher = snapshot.dispatcher ?? {};
    const driver = snapshot.driver ?? {};

    const number = (value, digits = 3) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed.toFixed(digits) : '-';
    };

    return (
      `mode=${controller.mode ?? '-'}; ` +
      `err=${number(controller.errorX, 1)},${number(controller.errorY, 1)}; ` +
      `raw=${raw.pan ?? '-'}:${number(raw.requestedPanSpeed)} ` +
      `${raw.tilt ?? '-'}:${number(raw.requestedTiltSpeed)}; ` +
      `stable=${stable.pan ?? '-'}:${number(stable.panSpeed)} ` +
      `${stable.tilt ?? '-'}:${number(stable.tiltSpeed)}; ` +
      `dispatch=${dispatcher.stage ?? '-'} ` +
      `${dispatcher.pan ?? '-'}:${number(dispatcher.panSpeed)} ` +
      `${dispatcher.tilt ?? '-'}:${number(dispatcher.tiltSpeed)}; ` +
      `driver=${driver.stage ?? '-'} ` +
      `${driver.pan ?? '-'}:${number(driver.panRate)} ` +
      `${driver.tilt ?? '-'}:${number(driver.tiltRate)} ` +
      `${driver.dryRun ? 'DRY' : 'LIVE'}`
    );
  }

  getSnapshot() {
    return {
      updatedAt: this.snapshot.updatedAt,
      controller: this.snapshot.controller
        ? { ...this.snapshot.controller }
        : null,
      dispatcher: this.snapshot.dispatcher
        ? { ...this.snapshot.dispatcher }
        : null,
      driver: this.snapshot.driver
        ? { ...this.snapshot.driver }
        : null,
    };
  }
}

module.exports = new PtzDiagnosticsStore();
