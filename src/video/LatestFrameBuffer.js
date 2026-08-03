'use strict';

/**
 * Буфер последнего видеокадра.
 *
 * Хранит только один — самый свежий — необработанный кадр. Если новый кадр
 * вытесняет предыдущий, буфер предыдущего кадра немедленно освобождается через
 * metadata.release(). Это позволяет FrameParser повторно использовать память.
 */
class LatestFrameBuffer {
  constructor() {
    this.latestFrame = null;
    this.receivedFrames = 0;
    this.droppedFrames = 0;
    this.consumedFrames = 0;
    this.releasedFrames = 0;
  }

  push(frameBuffer, metadata = {}) {
    if (!Buffer.isBuffer(frameBuffer)) {
      throw new TypeError('LatestFrameBuffer ожидает frameBuffer типа Buffer');
    }

    this.receivedFrames += 1;

    if (this.latestFrame !== null) {
      this.droppedFrames += 1;
      this.#releaseFrame(this.latestFrame);
    }

    this.latestFrame = {
      frameBuffer,
      metadata,
      receivedAt: performance.now(),
    };
  }

  take() {
    if (this.latestFrame === null) {
      return null;
    }

    const frame = this.latestFrame;
    this.latestFrame = null;
    this.consumedFrames += 1;
    return frame;
  }

  hasFrame() {
    return this.latestFrame !== null;
  }

  clear() {
    if (this.latestFrame !== null) {
      this.#releaseFrame(this.latestFrame);
      this.latestFrame = null;
    }
  }

  getStats() {
    return {
      receivedFrames: this.receivedFrames,
      consumedFrames: this.consumedFrames,
      droppedFrames: this.droppedFrames,
      releasedFrames: this.releasedFrames,
      hasPendingFrame: this.latestFrame !== null,
    };
  }

  #releaseFrame(frame) {
    const release = frame?.metadata?.release;

    if (typeof release === 'function') {
      release();
      this.releasedFrames += 1;
    }
  }
}

module.exports = LatestFrameBuffer;
