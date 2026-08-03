'use strict';

/**
 * Планировщик обработки видеокадров в реальном времени.
 *
 * Главный принцип класса: никогда не создавать очередь кадров.
 * LatestFrameBuffer хранит только самый свежий необработанный кадр,
 * а FrameScheduler запускает обработчик сразу после появления кадра
 * или сразу после завершения предыдущей обработки.
 *
 * Если во время обработки поступает несколько новых кадров,
 * LatestFrameBuffer оставляет только последний из них. После освобождения
 * обработчика планировщик немедленно забирает именно этот свежий кадр.
 */
class FrameScheduler {
  /**
   * @param {object} options
   * @param {object} options.frameBuffer Буфер с методами take() и hasFrame().
   * @param {(frame: object) => Promise<void>|void} options.processFrame
   *   Функция обработки одного кадра.
   * @param {(error: Error) => void} [options.onError]
   *   Обработчик ошибок цикла.
   */
  constructor({ frameBuffer, processFrame, onError = null }) {
    if (!frameBuffer || typeof frameBuffer.take !== 'function') {
      throw new TypeError('FrameScheduler ожидает frameBuffer с методом take()');
    }

    if (typeof processFrame !== 'function') {
      throw new TypeError('FrameScheduler ожидает функцию processFrame');
    }

    this.frameBuffer = frameBuffer;
    this.processFrame = processFrame;
    this.onError = typeof onError === 'function' ? onError : null;

    /** Планировщик разрешён к работе. */
    this.running = false;

    /** В данный момент выполняется обработка кадра. */
    this.processing = false;

    /** Уже запланирован ближайший запуск drain(). */
    this.drainScheduled = false;

    /** Диагностические счётчики. */
    this.notifications = 0;
    this.processedFrames = 0;
    this.processingErrors = 0;
  }

  /** Запускает планировщик. */
  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.#scheduleDrain();
  }

  /**
   * Сообщает планировщику, что в LatestFrameBuffer появился новый кадр.
   * Метод очень лёгкий и безопасен для вызова прямо из события parser.on('frame').
   */
  notifyFrameAvailable() {
    this.notifications += 1;

    if (!this.running || this.processing) {
      return;
    }

    this.#scheduleDrain();
  }

  /** Останавливает новые запуски обработки. */
  stop() {
    this.running = false;
  }

  /** Возвращает состояние для диагностики. */
  getStats() {
    return {
      running: this.running,
      processing: this.processing,
      notifications: this.notifications,
      processedFrames: this.processedFrames,
      processingErrors: this.processingErrors,
      hasPendingFrame: this.frameBuffer.hasFrame(),
    };
  }

  /** Планирует запуск без рекурсивного роста стека вызовов. */
  #scheduleDrain() {
    if (!this.running || this.processing || this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;

    setImmediate(() => {
      this.drainScheduled = false;
      this.#drain().catch((error) => this.#handleError(error));
    });
  }

  /**
   * Забирает самый свежий кадр и запускает его обработку.
   * После завершения немедленно проверяет, появился ли новый кадр.
   */
  async #drain() {
    if (!this.running || this.processing) {
      return;
    }

    const frame = this.frameBuffer.take();

    if (!frame) {
      return;
    }

    this.processing = true;

    try {
      await this.processFrame(frame);
      this.processedFrames += 1;
    } catch (error) {
      this.processingErrors += 1;
      this.#handleError(error);
    } finally {
      /**
       * FrameParser v2 передаёт кадры из пула. После завершения всей
       * асинхронной обработки возвращаем память кадра парсеру.
       */
      const release = frame?.metadata?.release;

      if (typeof release === 'function') {
        release();
      }

      this.processing = false;
    }

    /**
     * За время обработки мог поступить новый кадр.
     * Не ждём таймер — сразу планируем обработку последнего кадра.
     */
    if (this.running && this.frameBuffer.hasFrame()) {
      this.#scheduleDrain();
    }
  }

  #handleError(error) {
    if (this.onError) {
      this.onError(error);
      return;
    }

    // Не скрываем ошибку, если вызывающая сторона не передала обработчик.
    setImmediate(() => {
      throw error;
    });
  }
}

module.exports = FrameScheduler;
