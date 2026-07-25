'use strict';

/**
 * Буфер последнего видеокадра.
 *
 * В отличие от обычной очереди этот буфер хранит только один кадр —
 * самый новый из полученных.
 *
 * Когда приходит очередной кадр:
 *
 * - если буфер пуст, кадр сохраняется;
 * - если в буфере уже есть кадр, старый кадр заменяется новым;
 * - заменённый кадр считается пропущенным.
 *
 * Благодаря этому задержка видеоаналитики не накапливается.
 */
class LatestFrameBuffer {
  constructor() {
    /**
     * Последний необработанный кадр.
     *
     * @type {{
     *   frameBuffer: Buffer,
     *   metadata: object,
     *   receivedAt: number
     * } | null}
     */
    this.latestFrame = null;

    /**
     * Общее количество кадров, переданных в буфер.
     */
    this.receivedFrames = 0;

    /**
     * Количество кадров, заменённых более свежими кадрами.
     */
    this.droppedFrames = 0;

    /**
     * Количество кадров, забранных на обработку.
     */
    this.consumedFrames = 0;
  }

  /**
   * Сохраняет новый кадр.
   *
   * Если предыдущий кадр ещё не был обработан,
   * он удаляется и заменяется новым.
   *
   * @param {Buffer} frameBuffer Сырой BGR24-кадр.
   * @param {object} metadata Метаданные кадра.
   */
  push(frameBuffer, metadata = {}) {
    if (!Buffer.isBuffer(frameBuffer)) {
      throw new TypeError('LatestFrameBuffer ожидает frameBuffer типа Buffer');
    }

    this.receivedFrames += 1;

    /**
     * Если кадр уже ожидал обработки, значит обработчик не успел
     * забрать его до поступления следующего кадра.
     *
     * Такой кадр больше не актуален и должен быть пропущен.
     */
    if (this.latestFrame !== null) {
      this.droppedFrames += 1;
    }

    this.latestFrame = {
      frameBuffer,
      metadata,

      /**
       * performance.now() использует монотонные часы.
       *
       * Они не зависят от ручной коррекции системного времени.
       */
      receivedAt: performance.now(),
    };
  }

  /**
   * Возвращает самый свежий кадр и сразу очищает буфер.
   *
   * После take() новый поступивший кадр снова может быть сохранён
   * в качестве следующего кадра для обработки.
   *
   * @returns {{
   *   frameBuffer: Buffer,
   *   metadata: object,
   *   receivedAt: number
   * } | null}
   */
  take() {
    if (this.latestFrame === null) {
      return null;
    }

    const frame = this.latestFrame;

    this.latestFrame = null;
    this.consumedFrames += 1;

    return frame;
  }

  /**
   * Показывает, есть ли в буфере необработанный кадр.
   *
   * @returns {boolean}
   */
  hasFrame() {
    return this.latestFrame !== null;
  }

  /**
   * Очищает ожидающий кадр.
   */
  clear() {
    this.latestFrame = null;
  }

  /**
   * Возвращает диагностическое состояние буфера.
   */
  getStats() {
    return {
      receivedFrames: this.receivedFrames,
      consumedFrames: this.consumedFrames,
      droppedFrames: this.droppedFrames,
      hasPendingFrame: this.latestFrame !== null,
    };
  }
}

module.exports = LatestFrameBuffer;
