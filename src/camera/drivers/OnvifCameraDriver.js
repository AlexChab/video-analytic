'use strict';

const onvif = require('onvif');
const BaseCameraDriver = require('./BaseCameraDriver');
const logger = require('../../utils/Logger');

/**
 * Реальный драйвер управления камерой через ONVIF PTZ ContinuousMove.
 *
 * Проверен для FLIR M364C (M300 Series):
 * - Device / Media / PTZ доступны;
 * - профиль MP0 принимает ContinuousMove и Stop;
 * - GetStatus возвращает текущую позицию платформы.
 *
 * Драйвер не рассчитывает направление наведения. Он только переводит
 * универсальную команду CameraController в нормализованный ONVIF-вектор.
 */
class OnvifCameraDriver extends BaseCameraDriver {
  constructor(options = {}) {
    super(options);

    this.host = String(options.host ?? '').trim();
    this.port = this.#positiveInteger(options.port, 80);
    this.username = String(options.username ?? '').trim();
    this.password = String(options.password ?? '');
    this.profileToken = String(options.profileToken ?? 'MP0').trim() || 'MP0';
    this.connectTimeoutMs = this.#positiveInteger(options.connectTimeoutMs, 8000);
    this.moveTimeoutMs = this.#positiveInteger(options.moveTimeoutMs, 1500);
    this.allowMotion = this.#toBoolean(options.allowMotion, false);
    this.logCommands = this.#toBoolean(options.logCommands, true);

    this.camera = null;
    this.connectPromise = null;
    this.lastCommandKey = null;
  }

  async connect() {
    if (this.connected && this.camera) return;
    if (this.connectPromise) return this.connectPromise;

    if (!this.host) {
      throw new Error('OnvifCameraDriver: не указан host камеры');
    }

    this.connectPromise = new Promise((resolve, reject) => {
      let completed = false;

      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        reject(
          new Error(
            `ONVIF: тайм-аут подключения к ${this.host}:${this.port} ` +
            `через ${this.connectTimeoutMs} мс`,
          ),
        );
      }, this.connectTimeoutMs);
      timer.unref?.();

      try {
        const instance = new onvif.Cam(
          {
            hostname: this.host,
            port: this.port,
            username: this.username,
            password: this.password,
            timeout: this.connectTimeoutMs,
            preserveAddress: true,
          },
          (error) => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);

            if (error) {
              reject(error);
              return;
            }

            this.camera = instance;
            this.connected = true;

            const model = instance.deviceInformation?.model ?? 'неизвестная модель';
            logger.info(
              `[CAMERA] ONVIF подключён: ${this.host}:${this.port}; ` +
              `model=${model}; profile=${this.profileToken}; ` +
              `motion=${this.allowMotion ? 'разрешено' : 'заблокировано'}`,
            );

            resolve();
          },
        );
      } catch (error) {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        reject(error);
      }
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async move(command = {}) {
    if (!this.connected || !this.camera) await this.connect();

    const vector = this.#commandToVector(command);
    const key = [
      vector.x.toFixed(3),
      vector.y.toFixed(3),
      vector.zoom.toFixed(3),
      command.reason ?? 'UNKNOWN',
    ].join(':');

    if (!command.moving || this.#isZeroVector(vector)) {
      return this.stop(command.reason ?? 'STOP');
    }

    if (!this.allowMotion) {
      if (this.logCommands && key !== this.lastCommandKey) {
        logger.info(
          `[CAMERA:ONVIF:DRY] x=${vector.x.toFixed(3)}; ` +
          `y=${vector.y.toFixed(3)}; z=${vector.zoom.toFixed(3)}; ` +
          `reason=${command.reason ?? 'UNKNOWN'}`,
        );
      }
      this.lastCommandKey = key;
      return { success: true, dryRun: true, vector };
    }

    await this.#call('continuousMove', {
      profileToken: this.profileToken,
      x: vector.x,
      y: vector.y,
      zoom: vector.zoom,
      timeout: this.moveTimeoutMs,
    });

    if (this.logCommands && key !== this.lastCommandKey) {
      logger.info(
        `[CAMERA:ONVIF] MOVE x=${vector.x.toFixed(3)}; ` +
        `y=${vector.y.toFixed(3)}; z=${vector.zoom.toFixed(3)}; ` +
        `PAN=${command.pan ?? 'STOP'}; TILT=${command.tilt ?? 'STOP'}; ` +
        `reason=${command.reason ?? 'UNKNOWN'}`,
      );
    }

    this.lastCommandKey = key;
    return { success: true, dryRun: false, vector };
  }

  async stop(reason = 'STOP') {
    if (!this.connected || !this.camera) {
      // При завершении до первого подключения нечего останавливать.
      return { success: true, skipped: true, reason };
    }

    if (!this.allowMotion) {
      this.lastCommandKey = null;
      return { success: true, dryRun: true, reason };
    }

    await this.#call('stop', {
      profileToken: this.profileToken,
      panTilt: true,
      zoom: true,
    });

    logger.info(`[CAMERA:ONVIF] STOP; reason=${reason}`);
    this.lastCommandKey = null;
    return { success: true, reason };
  }

  async getStatus() {
    if (!this.connected || !this.camera) await this.connect();

    const { result } = await this.#call('getStatus', {
      profileToken: this.profileToken,
    });

    return {
      connected: this.connected,
      driver: this.constructor.name,
      host: this.host,
      port: this.port,
      profileToken: this.profileToken,
      allowMotion: this.allowMotion,
      ptz: result,
    };
  }

  getCapabilities() {
    return {
      continuousMove: true,
      absoluteMove: false,
      relativeMove: false,
      zoom: true,
      presets: false,
      positionFeedback: true,
      dryRun: !this.allowMotion,
    };
  }

  async disconnect() {
    if (this.connected && this.camera && this.allowMotion) {
      try {
        await this.stop('DISCONNECT');
      } catch (error) {
        logger.warn(`[CAMERA] ONVIF STOP при отключении не выполнен: ${error.message}`);
      }
    }

    this.camera = null;
    this.connected = false;
    this.lastCommandKey = null;
    logger.info('[CAMERA] OnvifCameraDriver отключён.');
  }

  #commandToVector(command) {
    const panSpeed = this.#speed(command.panSpeed);
    const tiltSpeed = this.#speed(command.tiltSpeed);
    const zoomSpeed = this.#speed(command.zoomSpeed);

    return {
      x: command.pan === 'LEFT' ? -panSpeed : command.pan === 'RIGHT' ? panSpeed : 0,
      // В ONVIF для проверенной FLIR M364C положительный Y соответствует UP.
      y: command.tilt === 'UP' ? tiltSpeed : command.tilt === 'DOWN' ? -tiltSpeed : 0,
      zoom: command.zoom === 'IN' ? zoomSpeed : command.zoom === 'OUT' ? -zoomSpeed : 0,
    };
  }

  #isZeroVector(vector) {
    return vector.x === 0 && vector.y === 0 && vector.zoom === 0;
  }

  #call(methodName, ...args) {
    return new Promise((resolve, reject) => {
      const method = this.camera?.[methodName];
      if (typeof method !== 'function') {
        reject(new Error(`ONVIF-метод ${methodName} не поддерживается`));
        return;
      }

      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        reject(new Error(`ONVIF ${methodName}: тайм-аут ${this.moveTimeoutMs} мс`));
      }, this.moveTimeoutMs);
      timer.unref?.();

      const callback = (error, result, xml) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        if (error) {
          reject(error);
          return;
        }
        resolve({ result, xml });
      };

      try {
        method.call(this.camera, ...args, callback);
      } catch (error) {
        completed = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #speed(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
  }

  #positiveInteger(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  #toBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
  }
}

module.exports = OnvifCameraDriver;
