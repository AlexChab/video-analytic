'use strict';

const { EventEmitter } = require('node:events');

/**
 * FrameParser v2 собирает rawvideo-кадры фиксированного размера
 * без Buffer.concat() и без накопления массива чанков.
 *
 * FFmpeg передаёт stdout произвольными частями. Парсер последовательно
 * копирует эти части в заранее выделенный буфер кадра. Когда кадр собран,
 * сам буфер передаётся дальше без дополнительной копии.
 *
 * Переданный буфер возвращается в небольшой внутренний пул только после того,
 * как LatestFrameBuffer или FrameScheduler вызовет metadata.release().
 */
class FrameParser extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.width Ширина выходного кадра.
   * @param {number} options.height Высота выходного кадра.
   * @param {number} [options.channels=3] Количество каналов BGR.
   * @param {number} [options.poolSize=3] Начальное число буферов кадров.
   */
  constructor({ width, height, channels = 3, poolSize = 3 }) {
    super();

    if (!Number.isInteger(width) || width <= 0) {
      throw new Error('Ширина кадра должна быть положительным целым числом');
    }
    if (!Number.isInteger(height) || height <= 0) {
      throw new Error('Высота кадра должна быть положительным целым числом');
    }
    if (!Number.isInteger(channels) || channels <= 0) {
      throw new Error('Количество каналов должно быть положительным целым числом');
    }
    if (!Number.isInteger(poolSize) || poolSize < 2) {
      throw new Error('Размер пула FrameParser должен быть не меньше 2');
    }

    this.width = width;
    this.height = height;
    this.channels = channels;
    this.frameSize = width * height * channels;

    /** Свободные буферы, готовые для сборки следующих кадров. */
    this.freeBuffers = [];
    for (let index = 0; index < poolSize; index += 1) {
      this.freeBuffers.push(Buffer.allocUnsafe(this.frameSize));
    }

    /** Буфер, который сейчас заполняется данными stdout FFmpeg. */
    this.currentBuffer = this.#acquireBuffer();
    this.currentOffset = 0;

    /** Диагностические счётчики. */
    this.frameNumber = 0;
    this.totalBytes = 0;
    this.partialChunks = 0;
    this.multiFrameChunks = 0;
    this.poolAllocations = 0;
    this.inUseBuffers = 0;
    this.peakInUseBuffers = 0;
  }

  /**
   * Добавляет очередной бинарный chunk из stdout FFmpeg.
   * Один chunk может содержать часть кадра или несколько кадров.
   *
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError('FrameParser принимает только Buffer');
    }
    if (chunk.length === 0) {
      return;
    }

    this.totalBytes += chunk.length;

    let chunkOffset = 0;
    let completedInThisChunk = 0;

    while (chunkOffset < chunk.length) {
      const bytesNeeded = this.frameSize - this.currentOffset;
      const bytesAvailable = chunk.length - chunkOffset;
      const bytesToCopy = Math.min(bytesNeeded, bytesAvailable);

      chunk.copy(
        this.currentBuffer,
        this.currentOffset,
        chunkOffset,
        chunkOffset + bytesToCopy,
      );

      this.currentOffset += bytesToCopy;
      chunkOffset += bytesToCopy;

      if (this.currentOffset < this.frameSize) {
        this.partialChunks += 1;
        continue;
      }

      completedInThisChunk += 1;
      this.#emitCompletedFrame(this.currentBuffer);

      this.currentBuffer = this.#acquireBuffer();
      this.currentOffset = 0;
    }

    if (completedInThisChunk > 1) {
      this.multiFrameChunks += 1;
    }
  }

  /** Передаёт полностью собранный кадр и функцию возврата буфера в пул. */
  #emitCompletedFrame(frameBuffer) {
    this.frameNumber += 1;
    this.inUseBuffers += 1;
    this.peakInUseBuffers = Math.max(this.peakInUseBuffers, this.inUseBuffers);

    let released = false;

    const release = () => {
      if (released) {
        return;
      }

      released = true;
      this.inUseBuffers = Math.max(0, this.inUseBuffers - 1);
      this.freeBuffers.push(frameBuffer);
    };

    this.emit('frame', frameBuffer, {
      number: this.frameNumber,
      width: this.width,
      height: this.height,
      channels: this.channels,
      size: this.frameSize,
      bufferedBytes: this.currentOffset,

      /**
       * Получатель обязан вызвать release(), когда кадр больше не используется.
       * LatestFrameBuffer и FrameScheduler v2 делают это автоматически.
       */
      release,
    });
  }

  /** Берёт свободный буфер или создаёт новый только при исчерпании пула. */
  #acquireBuffer() {
    const buffer = this.freeBuffers.pop();

    if (buffer) {
      return buffer;
    }

    this.poolAllocations += 1;
    return Buffer.allocUnsafe(this.frameSize);
  }

  /** Возвращает статистику текущего состояния парсера. */
  getStats() {
    return {
      emittedFrames: this.frameNumber,
      droppedFrames: 0,
      bufferedBytes: this.currentOffset,
      frameSize: this.frameSize,
      fillRatio: this.currentOffset / this.frameSize,
      totalBytes: this.totalBytes,
      partialChunks: this.partialChunks,
      multiFrameChunks: this.multiFrameChunks,
      freeBuffers: this.freeBuffers.length,
      inUseBuffers: this.inUseBuffers,
      peakInUseBuffers: this.peakInUseBuffers,
      poolAllocations: this.poolAllocations,
    };
  }

  /**
   * Сбрасывает незавершённый кадр и статистику.
   * Уже переданные кадры остаются валидными и вернутся в пул через release().
   */
  reset() {
    this.currentOffset = 0;
    this.frameNumber = 0;
    this.totalBytes = 0;
    this.partialChunks = 0;
    this.multiFrameChunks = 0;
    this.poolAllocations = 0;
    this.peakInUseBuffers = this.inUseBuffers;
  }
}

module.exports = FrameParser;
