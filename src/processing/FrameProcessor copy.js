const cv = require('@u4/opencv4nodejs');
const PtzTrackingController = require('../tracking/PtzTrackingController');

/**
 * Обрабатывает видеокадры с помощью OpenCV.
 *
 * На текущем этапе модуль:
 * - преобразует BGR24 Buffer в cv.Mat;
 * - рисует тестовую рамку;
 * - добавляет номер кадра;
 * - возвращает обработанный BGR24 Buffer.
 *
 * Позже здесь появятся детекция объектов и трекинг.
 */
class FrameProcessor {
  /**
   * @param {object} options
   * @param {number} options.width Ширина кадра.
   * @param {number} options.height Высота кадра.
   */
  constructor({ width, height }) {
    this.width = width;
    this.height = height;
    this.channels = 3;
    this.frameSize = width * height * this.channels;

    this.trackingController = new PtzTrackingController({
      frameWidth: this.width,
      frameHeight: this.height,

      // Для кадра 1280×720 объект должен войти
      // в окружность радиусом 180 пикселей возле центра.
      captureRadius: 180,

      // Пока объект находится внутри этой зоны,
      // камера получает команду STOP.
      deadZoneX: 100,
      deadZoneY: 70,

      // Насколько далеко цель может переместиться
      // между соседними обработанными кадрами.
      maxMatchDistance: 250,

      // При 30 FPS это примерно половина секунды.
      lostFrameLimit: 15,

      // Не печатаем одну команду чаще трёх раз в секунду.
      commandIntervalMs: 300,
    });
  }

  /**
   * Обрабатывает один кадр.
   *
   * @param {Buffer} frameBuffer Исходный BGR24-кадр.
   * @param {object} metadata Метаданные кадра.
   * @returns {Buffer} Обработанный BGR24-кадр.
   */
  process(frameBuffer, metadata = {}) {
    if (!Buffer.isBuffer(frameBuffer)) {
      throw new TypeError('FrameProcessor ожидает Buffer');
    }

    if (frameBuffer.length !== this.frameSize) {
      throw new Error(
        `Неверный размер кадра: ${frameBuffer.length}. ` +
          `Ожидалось: ${this.frameSize}`,
      );
    }

    /*
     * Создаём матрицу OpenCV из сырого BGR24-буфера.
     */
    const frame = new cv.Mat(frameBuffer, this.height, this.width, cv.CV_8UC3);

    const boxWidth = Math.round(this.width * 0.4);
    const boxHeight = Math.round(this.height * 0.4);

    const x = Math.round((this.width - boxWidth) / 2);
    const y = Math.round((this.height - boxHeight) / 2);

    const topLeft = new cv.Point2(x, y);
    const bottomRight = new cv.Point2(x + boxWidth, y + boxHeight);

    // Цвета задаются в формате BGR.
    const green = new cv.Vec3(0, 255, 0);
    const white = new cv.Vec3(255, 255, 255);

    frame.drawRectangle(topLeft, bottomRight, green, 3, cv.LINE_8);

    frame.putText(
      'OpenCV processing',
      new cv.Point2(x, Math.max(30, y - 15)),
      cv.FONT_HERSHEY_SIMPLEX,
      0.8,
      green,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `Frame: ${metadata.number ?? 0}`,
      new cv.Point2(20, 40),
      cv.FONT_HERSHEY_SIMPLEX,
      0.8,
      white,
      2,
      cv.LINE_AA,
    );

    /*
     * Получаем сырой BGR24-буфер обратно.
     * Позже этот Buffer будет передаваться во второй FFmpeg.
     */
    return Buffer.from(frame.getData());
  }
}

module.exports = FrameProcessor;
