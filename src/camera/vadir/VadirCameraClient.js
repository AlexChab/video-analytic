'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const VadirProtocol = require('./VadirProtocol');

/** Небольшая вспомогательная задержка с поддержкой AbortSignal. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Операция отменена'));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Операция отменена'));
    }, { once: true });
  });
}

/**
 * TCP-клиент управления камерой VADIR.
 *
 * События:
 *   connected                 — TCP-соединение установлено;
 *   disconnected              — соединение закрыто;
 *   telemetry, telemetry      — получена обновлённая телеметрия;
 *   tx, command               — команда отправлена;
 *   rx, response              — пакет получен;
 *   warning, message          — некритичная проблема;
 *   error, error              — ошибка клиента.
 */
class VadirCameraClient extends EventEmitter {
  constructor(options = {}) {
    super();

    this.host = options.host ?? '192.168.1.106';
    this.port = options.port ?? 10930;
    this.pollIntervalMs = options.pollIntervalMs ?? 120;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 2000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;

    this.socket = null;
    this.connected = false;
    this.receiveBuffer = '';
    this.pendingResponse = null;
    this.operationQueue = Promise.resolve();
    this.pollAbortController = null;
    this.pollTask = null;

    this.telemetry = {
      panRaw: null,
      tiltRaw: null,
      panDegrees: null,
      tiltDegrees: null,
      dayZoom: null,
      nightZoom: null,
      receivedAt: null,
    };
  }

  /** Устанавливает TCP-соединение. Повторный вызов безопасен. */
  async connect() {
    if (this.connected && this.socket && !this.socket.destroyed) return;

    await new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.setNoDelay(true);
      socket.once('error', fail);
      socket.connect(this.port, this.host, () => {
        if (settled) return;
        settled = true;
        socket.off('error', fail);

        this.socket = socket;
        this.connected = true;
        this.receiveBuffer = '';
        this.#attachSocketHandlers(socket);
        this.emit('connected', { host: this.host, port: this.port });
        resolve();
      });
    });
  }

  /** Запускает фоновый опрос положения и зума. */
  startPolling() {
    if (this.pollTask) return this.pollTask;

    this.pollAbortController = new AbortController();
    this.pollTask = this.#pollLoop(this.pollAbortController.signal)
      .catch((error) => {
        if (!this.pollAbortController?.signal.aborted) this.emit('error', error);
      })
      .finally(() => {
        this.pollTask = null;
        this.pollAbortController = null;
      });

    return this.pollTask;
  }

  /** Останавливает фоновый опрос, не закрывая TCP-соединение. */
  async stopPolling() {
    this.pollAbortController?.abort();
    if (this.pollTask) {
      try { await this.pollTask; } catch { /* задача уже сообщила об ошибке */ }
    }
  }

  /** Скорость панорамы и наклона. Значение 0 останавливает соответствующую ось. */
  async setMotion(panRate, tiltRate) {
    const pan = this.#clamp(panRate, -15.70, 15.70);
    const tilt = this.#clamp(tiltRate, -10.46, 10.46);

    await this.#enqueue(() => this.#sendWithoutResponse(VadirProtocol.set('20PR', pan)));
    await this.#enqueue(() => this.#sendWithoutResponse(VadirProtocol.set('20TR', tilt)));
  }

  async moveLeft(speedPercent = 100) {
    return this.setMotion(-15.70 * this.#percent(speedPercent), 0);
  }

  async moveRight(speedPercent = 100) {
    return this.setMotion(15.70 * this.#percent(speedPercent), 0);
  }

  async moveUp(speedPercent = 100) {
    return this.setMotion(0, 10.46 * this.#percent(speedPercent));
  }

  async moveDown(speedPercent = 100) {
    return this.setMotion(0, -10.46 * this.#percent(speedPercent));
  }

  /** Немедленно останавливает панораму и наклон. */
  async stopMotion() {
    return this.setMotion(0, 0);
  }

  /** Управляет скоростью дневного оптического зума: -50…50. */
  async setDayZoomRate(rate) {
    const normalizedRate = this.#clamp(rate, -50, 50);
    return this.#enqueue(() =>
      this.#sendWithoutResponse(VadirProtocol.set('40ZR', normalizedRate)));
  }

  async zoomIn() {
    return this.setDayZoomRate(50);
  }

  async zoomOut() {
    return this.setDayZoomRate(-50);
  }

  async stopZoom() {
    return this.setDayZoomRate(0);
  }

  /** Запрашивает один параметр камеры и возвращает разобранный ответ. */
  async query(address) {
    return this.#enqueue(() => this.#sendAndReceive(VadirProtocol.query(address)));
  }

  /** Останавливает движение, опрос и закрывает TCP-соединение. */
  async close() {
    await this.stopPolling();

    if (this.connected) {
      try {
        await this.stopMotion();
        await this.stopZoom();
      } catch {
        // При разрыве соединения стоп-команды уже невозможно доставить.
      }
    }

    this.#destroySocket();
  }

  async #pollLoop(signal) {
    const addresses = ['20PP', '20TP', '40ZP', 'A0ZP'];

    while (!signal.aborted) {
      for (const address of addresses) {
        if (signal.aborted) return;

        try {
          const response = await this.query(address);
          this.#processTelemetry(response);
        } catch (error) {
          if (signal.aborted) return;

          this.emit('warning', `Опрос ${address}: ${error.message}`);
          this.#destroySocket();

          try {
            await delay(this.reconnectDelayMs, signal);
            await this.connect();
          } catch (reconnectError) {
            if (!signal.aborted) {
              this.emit('warning', `Переподключение: ${reconnectError.message}`);
            }
          }
          break;
        }

        await delay(this.pollIntervalMs, signal);
      }
    }
  }

  #processTelemetry(response) {
    const numericValue = Number(response.value);
    if (!Number.isFinite(numericValue)) {
      this.emit('warning', `Некорректное значение ${response.address}: ${response.value}`);
      return;
    }

    switch (response.address) {
      case '20PP':
        this.telemetry.panRaw = Math.trunc(numericValue);
        this.telemetry.panDegrees =
          -(this.telemetry.panRaw / 1_000_000 * 180 / Math.PI) + 1.20;
        break;
      case '20TP':
        this.telemetry.tiltRaw = Math.trunc(numericValue);
        this.telemetry.tiltDegrees =
          this.telemetry.tiltRaw / 1_000_000 * 180 / Math.PI + 0.155;
        break;
      case '40ZP':
        this.telemetry.dayZoom = numericValue;
        break;
      case 'A0ZP':
        this.telemetry.nightZoom = numericValue;
        break;
      default:
        return;
    }

    this.telemetry.receivedAt = new Date();
    this.emit('telemetry', { ...this.telemetry });
  }

  #attachSocketHandlers(socket) {
    socket.on('data', (chunk) => this.#handleData(chunk));
    socket.on('error', (error) => {
      this.#rejectPendingResponse(error);
      this.emit('error', error);
    });
    socket.on('close', () => {
      const wasConnected = this.connected;
      if (this.socket === socket) {
        this.socket = null;
        this.connected = false;
      }
      this.#rejectPendingResponse(new Error('TCP-соединение с камерой закрыто'));
      if (wasConnected) this.emit('disconnected');
    });
  }

  #handleData(chunk) {
    this.receiveBuffer += chunk.toString('ascii').replace(/\0/g, '');

    let packetEnd;
    while ((packetEnd = this.receiveBuffer.indexOf('>')) !== -1) {
      const packet = this.receiveBuffer.slice(0, packetEnd + 1);
      this.receiveBuffer = this.receiveBuffer.slice(packetEnd + 1);
      this.emit('rx', packet);

      if (this.pendingResponse) {
        const pending = this.pendingResponse;
        this.pendingResponse = null;
        clearTimeout(pending.timer);

        const parsed = VadirProtocol.parseResponse(packet);
        if (parsed) pending.resolve(parsed);
        else pending.reject(new Error(`Некорректный ответ камеры: ${packet}`));
      }
    }
  }

  async #sendWithoutResponse(command) {
    await this.connect();
    await this.#write(command);
  }

  async #sendAndReceive(command) {
    await this.connect();

    if (this.pendingResponse) {
      throw new Error('Внутренняя ошибка: предыдущий запрос ещё не завершён');
    }

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingResponse?.timer === timer) this.pendingResponse = null;
        reject(new Error(`Тайм-аут ответа камеры (${this.responseTimeoutMs} мс)`));
      }, this.responseTimeoutMs);

      this.pendingResponse = { resolve, reject, timer };
    });

    try {
      await this.#write(command);
      return await responsePromise;
    } catch (error) {
      this.#rejectPendingResponse(error);
      throw error;
    }
  }

  #write(command) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed || !this.connected) {
        reject(new Error('Нет TCP-соединения с камерой'));
        return;
      }

      this.socket.write(Buffer.from(command, 'ascii'), (error) => {
        if (error) reject(error);
        else {
          this.emit('tx', command);
          resolve();
        }
      });
    });
  }

  #enqueue(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  #rejectPendingResponse(error) {
    if (!this.pendingResponse) return;
    const pending = this.pendingResponse;
    this.pendingResponse = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #destroySocket() {
    this.#rejectPendingResponse(new Error('TCP-соединение закрыто'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.receiveBuffer = '';
  }

  #clamp(value, min, max) {
    if (!Number.isFinite(value)) throw new TypeError('Скорость должна быть числом');
    return Math.min(max, Math.max(min, value));
  }

  #percent(value) {
    return this.#clamp(value, 0, 100) / 100;
  }
}

module.exports = VadirCameraClient;
