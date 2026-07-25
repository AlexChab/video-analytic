const cv = require('@u4/opencv4nodejs');

/**
 * Детектор движения на основе разницы между соседними кадрами.
 *
 * Алгоритм:
 * 1. Переводит кадр в оттенки серого.
 * 2. Размывает изображение для уменьшения шумов.
 * 3. Сравнивает текущий кадр с предыдущим.
 * 4. Создаёт бинарную маску изменений.
 * 5. Находит контуры движущихся областей.
 * 6. Отбрасывает слишком маленькие области.
 */
class MotionDetector {
  /**
   * @param {object} options
   * @param {number} [options.minArea=3000]
   * Минимальная площадь области движения в пикселях.
   *
   * @param {number} [options.threshold=25]
   * Минимальная разница яркости, считающаяся движением.
   *
   * @param {number} [options.blurSize=21]
   * Размер ядра GaussianBlur.
   * Значение должно быть нечётным.
   */
  constructor({ minArea = 3000, threshold = 25, blurSize = 21 } = {}) {
    this.minArea = minArea;
    this.threshold = threshold;

    /**
     * GaussianBlur требует нечётный размер ядра.
     * Если передано чётное значение, увеличиваем его на единицу.
     */
    this.blurSize = blurSize % 2 === 0 ? blurSize + 1 : blurSize;

    /**
     * Предыдущий обработанный кадр.
     *
     * На первом кадре сравнивать ещё не с чем,
     * поэтому детектор просто сохраняет его.
     */
    this.previousFrame = null;
  }

  /**
   * Выполняет поиск движущихся объектов.
   *
   * @param {import('@u4/opencv4nodejs').Mat} frame
   * Цветной кадр OpenCV в формате BGR.
   *
   * @returns {Array<{
   *   x: number,
   *   y: number,
   *   width: number,
   *   height: number,
   *   area: number
   * }>}
   */
  detect(frame) {
    if (!frame) {
      throw new TypeError('MotionDetector.detect ожидает объект cv.Mat');
    }

    /**
     * Преобразуем цветной BGR-кадр в оттенки серого.
     */
    const grayFrame = frame.bgrToGray();

    /**
     * Размываем изображение.
     *
     * Это уменьшает влияние:
     * - цифрового шума;
     * - бликов;
     * - небольших изменений отдельных пикселей.
     */
    const preparedFrame = grayFrame.gaussianBlur(
      new cv.Size(this.blurSize, this.blurSize),
      0,
    );

    /**
     * Первый кадр используется только как исходная база.
     */
    if (!this.previousFrame) {
      this.previousFrame = preparedFrame.copy();

      return [];
    }

    /**
     * Вычисляем абсолютную разницу между
     * текущим и предыдущим кадрами.
     */
    const frameDifference = preparedFrame.absdiff(this.previousFrame);

    /**
     * Создаём бинарную маску.
     *
     * Пиксели с недостаточной разницей становятся чёрными.
     * Пиксели со значительной разницей становятся белыми.
     */
    let motionMask = frameDifference.threshold(
      this.threshold,
      255,
      cv.THRESH_BINARY,
    );

    /**
     * Расширяем белые области.
     *
     * Это помогает объединить близкие части
     * одного движущегося объекта.
     */
    motionMask = motionMask.dilate(new cv.Mat(), new cv.Point2(-1, -1), 2);

    /**
     * Находим внешние контуры движущихся областей.
     */
    const contours = motionMask.findContours(
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const detections = [];

    for (const contour of contours) {
      const area = contour.area;

      /**
       * Отбрасываем слишком маленькие области,
       * которые чаще всего являются шумом.
       */
      if (area < this.minArea) {
        continue;
      }

      const rectangle = contour.boundingRect();

      detections.push({
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
        area,
      });
    }

    /**
     * Сохраняем текущий кадр для следующего сравнения.
     */
    this.previousFrame = preparedFrame.copy();

    return detections;
  }

  /**
   * Сбрасывает историю детектора.
   *
   * После вызова reset() следующий кадр снова
   * станет базовым и не вернёт обнаружений.
   */
  reset() {
    this.previousFrame = null;
  }
}

module.exports = MotionDetector;
