const { EventEmitter } = require('node:events');

/**
 * FrameParser разделяет непрерывный бинарный поток FFmpeg
 * на отдельные кадры фиксированного размера.
 *
 * Важно: событие stdout "data" не соответствует одному кадру.
 * Один chunk может содержать часть кадра, один кадр или несколько кадров.
 */
class FrameParser extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.width Ширина кадра.
   * @param {number} options.height Высота кадра.
   * @param {number} [options.channels=3] Количество каналов BGR.
   */
  constructor({ width, height, channels = 3 }) {
    super();

    if (!Number.isInteger(width) || width <= 0) {
      throw new Error('Ширина кадра должна быть положительным целым числом');
    }

    if (!Number.isInteger(height) || height <= 0) {
      throw new Error('Высота кадра должна быть положительным целым числом');
    }

    if (!Number.isInteger(channels) || channels <= 0) {
      throw new Error(
        'Количество каналов должно быть положительным целым числом',
      );
    }

    this.width = width;
    this.height = height;
    this.channels = channels;

    /**
     * BGR24 использует три байта на каждый пиксель.
     *
     * Для 1280 × 720:
     * 1280 × 720 × 3 = 2 764 800 байт.
     */
    this.frameSize = width * height * channels;

    /**
     * Буфер хранит неполные данные между событиями stdout.
     */
    this.buffer = Buffer.alloc(0);

    this.frameNumber = 0;
  }

  /**
   * Добавляет очередную часть бинарных данных.
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

    this.buffer = Buffer.concat([this.buffer, chunk]);

    /**
     * В буфере может находиться сразу несколько полных кадров.
     */
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.subarray(0, this.frameSize);

      /**
       * Создаем отдельный Buffer кадра.
       * Это защищает данные кадра от изменений при дальнейшей работе буфера.
       */
      const completeFrame = Buffer.from(frame);

      this.buffer = this.buffer.subarray(this.frameSize);
      this.frameNumber += 1;

      this.emit('frame', completeFrame, {
        number: this.frameNumber,
        width: this.width,
        height: this.height,
        channels: this.channels,
        size: this.frameSize,
      });
    }
  }

  /**
   * Очищает накопленные данные.
   */
  reset() {
    this.buffer = Buffer.alloc(0);
    this.frameNumber = 0;
  }
}

module.exports = FrameParser;
