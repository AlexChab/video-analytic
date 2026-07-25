'use strict';

const { EventEmitter } = require('node:events');

/**
 * FrameParser разделяет непрерывный бинарный поток FFmpeg
 * на отдельные кадры фиксированного размера.
 *
 * Событие stdout "data" не соответствует одному кадру:
 * один chunk может содержать часть кадра, один кадр
 * или сразу несколько кадров.
 *
 * Особенность этого варианта:
 * если внутри парсера накопилось несколько полных кадров,
 * устаревшие кадры отбрасываются, а наружу передаётся
 * только самый свежий полный кадр.
 *
 * Это помогает не накапливать многосекундное отставание,
 * когда аналитика временно работает медленнее входного потока.
 */
class FrameParser extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.width Ширина выходного кадра.
   * @param {number} options.height Высота выходного кадра.
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
     * Здесь хранится незавершённый хвост следующего кадра.
     *
     * После каждого вызова push() все полные кадры удаляются,
     * поэтому размер этого буфера в норме всегда меньше frameSize.
     */
    this.buffer = Buffer.alloc(0);

    /**
     * Номер реально переданного наружу кадра.
     */
    this.frameNumber = 0;

    /**
     * Общее количество полных кадров,
     * отброшенных из-за накопившейся очереди.
     */
    this.droppedFrameNumber = 0;
  }

  /**
   * Добавляет очередную часть бинарных данных из stdout FFmpeg.
   *
   * @param {Buffer} chunk Часть потока rawvideo.
   */
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError('FrameParser принимает только Buffer');
    }

    if (chunk.length === 0) {
      return;
    }

    /**
     * Добавляем новый chunk к незавершённому хвосту
     * предыдущего кадра.
     */
    this.buffer = Buffer.concat([this.buffer, chunk]);

    /**
     * Определяем, сколько полных кадров сейчас находится
     * внутри накопленного буфера.
     */
    const completeFrameCount = Math.floor(this.buffer.length / this.frameSize);

    /**
     * Полного кадра пока нет.
     * Оставляем данные в буфере и ждём следующий chunk.
     */
    if (completeFrameCount === 0) {
      return;
    }

    /**
     * Если накопилось несколько кадров, выбираем последний.
     *
     * Например:
     * completeFrameCount = 4
     *
     * Кадры 1, 2 и 3 уже устарели.
     * Для аналитики и PTZ нужен кадр 4.
     */
    const latestFrameOffset = (completeFrameCount - 1) * this.frameSize;

    const latestFrameEnd = latestFrameOffset + this.frameSize;

    /**
     * Создаём независимую копию самого свежего полного кадра.
     *
     * Это важно, потому что this.buffer ниже будет заменён.
     */
    const latestFrame = Buffer.from(
      this.buffer.subarray(latestFrameOffset, latestFrameEnd),
    );

    /**
     * Все полные кадры считаются потреблёнными.
     *
     * После них может оставаться начало следующего,
     * ещё не полностью полученного кадра.
     */
    const consumedBytes = completeFrameCount * this.frameSize;

    /**
     * Сохраняем только незавершённый хвост.
     *
     * Buffer.from() здесь создаёт независимый маленький буфер,
     * чтобы не удерживать в памяти весь старый большой Buffer.
     */
    this.buffer = Buffer.from(this.buffer.subarray(consumedBytes));

    /**
     * Все полные кадры, кроме последнего,
     * считаются отброшенными.
     */
    const droppedFrameCount = completeFrameCount - 1;

    if (droppedFrameCount > 0) {
      this.droppedFrameNumber += droppedFrameCount;

      /**
       * Отдельное событие удобно использовать
       * для статистики и диагностики.
       */
      this.emit('drop', {
        count: droppedFrameCount,
        total: this.droppedFrameNumber,
      });
    }

    this.frameNumber += 1;

    /**
     * Наружу передаём только самый свежий полный кадр.
     */
    this.emit('frame', latestFrame, {
      number: this.frameNumber,
      width: this.width,
      height: this.height,
      channels: this.channels,
      size: this.frameSize,

      /**
       * Количество кадров, отброшенных именно
       * при текущем вызове push().
       */
      dropped: droppedFrameCount,

      /**
       * Общее количество отброшенных кадров
       * с момента запуска или reset().
       */
      droppedTotal: this.droppedFrameNumber,

      /**
       * Размер оставшегося незавершённого хвоста.
       *
       * В норме он должен быть меньше frameSize.
       */
      bufferedBytes: this.buffer.length,
    });
  }

  /**
   * Возвращает статистику текущего состояния парсера.
   *
   * @returns {{
   *   emittedFrames: number,
   *   droppedFrames: number,
   *   bufferedBytes: number,
   *   frameSize: number
   * }}
   */
  getStats() {
    return {
      emittedFrames: this.frameNumber,
      droppedFrames: this.droppedFrameNumber,
      bufferedBytes: this.buffer.length,
      frameSize: this.frameSize,
    };
  }

  /**
   * Очищает накопленные данные и статистику.
   */
  reset() {
    this.buffer = Buffer.alloc(0);
    this.frameNumber = 0;
    this.droppedFrameNumber = 0;
  }
}

module.exports = FrameParser;
