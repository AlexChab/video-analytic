'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Детектор движения для близких и удалённых объектов.
 *
 * Текущий кадр одновременно сравнивается с двумя кадрами из истории:
 *  - короткий интервал замечает обычное быстрое движение;
 *  - длинный интервал помогает находить медленные удалённые суда.
 *
 * Маски двух сравнений объединяются, после чего шум подавляется
 * морфологическими операциями. Кандидаты дополнительно фильтруются
 * по площади, ширине, высоте и соотношению сторон.
 */
class MotionDetector {
  /**
   * @param {object} [options]
   * @param {object} options Эффективная конфигурация из ProfileManager.
   */
  constructor(options = {}) {
    /** История кадров создаётся один раз и сохраняется при смене параметров. */
    this.frameHistory = [];

    /** Ядро 3x3 для морфологических операций. */
    this.morphKernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(3, 3),
    );

    this.updateConfiguration(options, { initial: true });
  }

  /**
   * Применяет новую конфигурацию без пересоздания детектора.
   *
   * История кадров сохраняется, но при уменьшении длинного интервала
   * обрезается до нового допустимого размера. Если меняется blurSize,
   * история очищается: кадры, размытые разными ядрами, нельзя сравнивать.
   *
   * @param {object} options Новая секция motion из ProfileManager.
   * @param {object} [serviceOptions]
   * @param {boolean} [serviceOptions.initial=false] Первичная настройка.
   */
  updateConfiguration(options = {}, { initial = false } = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('MotionDetector требует объект конфигурации');
    }

    const config = { ...options };

    // Старые конфигурации используют имя minBoxArea.
    if (!Number.isFinite(Number(config.minArea))) {
      config.minArea = config.minBoxArea;
    }

    const previousConfiguration = initial ? null : this.getConfiguration();
    const previousBlurSize = this.blurSize;

    this.minArea = Math.max(1, Number(config.minArea) || 1);
    this.minContourArea = Math.max(1, Number(config.minContourArea) || 1);
    this.minWidth = Math.max(1, Math.trunc(Number(config.minWidth) || 1));
    this.minHeight = Math.max(1, Math.trunc(Number(config.minHeight) || 1));
    this.minAspectRatio = Math.max(0.01, Number(config.minAspectRatio) || 0.01);
    this.maxAspectRatio = Math.max(
      this.minAspectRatio,
      Number(config.maxAspectRatio) || this.minAspectRatio,
    );
    this.threshold = Math.max(1, Number(config.threshold) || 1);
    this.blurSize = this.#makeOddPositive(config.blurSize);
    this.comparisonInterval = Math.max(
      1,
      Math.trunc(Number(config.comparisonInterval) || 1),
    );
    this.longComparisonInterval = Math.max(
      this.comparisonInterval + 1,
      Math.trunc(Number(config.longComparisonInterval) || this.comparisonInterval + 1),
    );
    this.dilateIterations = Math.max(
      0,
      Math.trunc(Number(config.dilateIterations) || 0),
    );
    this.closeIterations = Math.max(
      0,
      Math.trunc(Number(config.closeIterations) || 0),
    );
    this.mergePadding = Math.max(
      0,
      Math.trunc(Number(config.mergePadding) || 0),
    );
    this.ignoreTopRatio = this.#normalizeRatio(config.ignoreTopRatio);
    this.ignoreBottomRatio = this.#normalizeRatio(config.ignoreBottomRatio);
    this.maxAreaRatio = Math.min(
      1,
      Math.max(0.01, Number(config.maxAreaRatio) || 0.01),
    );

    this.maxHistoryLength = this.longComparisonInterval + 1;

    if (!initial && previousBlurSize !== this.blurSize) {
      this.reset();
    } else if (this.frameHistory.length > this.maxHistoryLength) {
      this.frameHistory = this.frameHistory.slice(-this.maxHistoryLength);
    }

    const currentConfiguration = this.getConfiguration();

    if (!initial) {
      const changed = Object.keys(currentConfiguration).filter(
        (key) => previousConfiguration?.[key] !== currentConfiguration[key],
      );
      if (changed.length > 0) {
        const details = changed
          .map((key) => `${key}: ${previousConfiguration[key]} → ${currentConfiguration[key]}`)
          .join('; ');
        console.log(`[MotionDetector] Конфигурация обновлена: ${details}`);
      }
    }

    return currentConfiguration;
  }

  /** Возвращает текущие параметры для диагностики. */
  getConfiguration() {
    return {
      threshold: this.threshold,
      blurSize: this.blurSize,
      comparisonInterval: this.comparisonInterval,
      longComparisonInterval: this.longComparisonInterval,
      minContourArea: this.minContourArea,
      minArea: this.minArea,
      minWidth: this.minWidth,
      minHeight: this.minHeight,
      minAspectRatio: this.minAspectRatio,
      maxAspectRatio: this.maxAspectRatio,
      dilateIterations: this.dilateIterations,
      closeIterations: this.closeIterations,
      mergePadding: this.mergePadding,
      ignoreTopRatio: this.ignoreTopRatio,
      ignoreBottomRatio: this.ignoreBottomRatio,
      maxAreaRatio: this.maxAreaRatio,
    };
  }

  /**
   * Ищет движущиеся области на BGR-кадре.
   *
   * @param {import('@u4/opencv4nodejs').Mat} frame
   * @returns {Array<{x:number,y:number,width:number,height:number,area:number}>}
   */
  detect(frame) {
    if (!frame) {
      throw new TypeError('MotionDetector.detect ожидает объект cv.Mat');
    }

    const preparedFrame = frame
      .bgrToGray()
      .gaussianBlur(new cv.Size(this.blurSize, this.blurSize), 0);

    this.frameHistory.push(preparedFrame.copy());

    if (this.frameHistory.length > this.maxHistoryLength) {
      this.frameHistory.shift();
    }

    /*
     * Пока история не накоплена хотя бы для короткого интервала,
     * корректно сравнивать кадры ещё не с чем.
     */
    if (this.frameHistory.length <= this.comparisonInterval) {
      return [];
    }

    const masks = [];

    const shortReference = this.#getHistoricalFrame(this.comparisonInterval);
    if (shortReference) {
      masks.push(this.#createMotionMask(preparedFrame, shortReference));
    }

    const longReference = this.#getHistoricalFrame(
      this.longComparisonInterval,
    );

    if (longReference) {
      masks.push(this.#createMotionMask(preparedFrame, longReference));
    }

    if (masks.length === 0) {
      return [];
    }

    /** Объединяем короткую и длинную маски движения. */
    let motionMask = masks[0];

    for (let index = 1; index < masks.length; index += 1) {
      motionMask = motionMask.bitwiseOr(masks[index]);
    }

    /** Исключаем верхнюю и нижнюю служебные зоны, если они настроены. */
    this.#clearIgnoredZones(motionMask);

    /*
     * Закрытие заполняет небольшие разрывы внутри объекта,
     * а дилатация соединяет близкие движущиеся кромки.
     */
    if (this.closeIterations > 0) {
      motionMask = motionMask.morphologyEx(
        this.morphKernel,
        cv.MORPH_CLOSE,
        new cv.Point2(-1, -1),
        this.closeIterations,
      );
    }

    if (this.dilateIterations > 0) {
      motionMask = motionMask.dilate(
        this.morphKernel,
        new cv.Point2(-1, -1),
        this.dilateIterations,
      );
    }

    const contours = motionMask.findContours(
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const candidateBoxes = [];

    for (const contour of contours) {
      if (contour.area < this.minContourArea) {
        continue;
      }

      const rectangle = contour.boundingRect();
      const boxArea = rectangle.width * rectangle.height;

      if (boxArea < this.minArea) {
        continue;
      }

      if (rectangle.width < this.minWidth) {
        continue;
      }

      if (rectangle.height < this.minHeight) {
        continue;
      }

      const aspectRatio = rectangle.width / rectangle.height;

      if (
        aspectRatio < this.minAspectRatio
        || aspectRatio > this.maxAspectRatio
      ) {
        continue;
      }

      const frameArea = frame.cols * frame.rows;

      /*
       * Если движение заняло слишком большую часть кадра, это почти всегда
       * глобальное изменение изображения: дрожание камеры, автоэкспозиция,
       * смена освещения или морская рябь по всей поверхности.
       */
      if (boxArea / frameArea > this.maxAreaRatio) {
        continue;
      }

      candidateBoxes.push({
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
        area: boxArea,
      });
    }

    /*
     * После объединения повторно проверяем итоговые прямоугольники.
     * Это не позволяет нескольким близким полосам ряби превратиться
     * в один огромный ложный объект.
     */
    const frameArea = frame.cols * frame.rows;

    return this.#mergeNearbyBoxes(candidateBoxes)
      .filter((box) => this.#isValidBox(box, frameArea));
  }

  /** Создаёт бинарную маску движения между двумя серыми кадрами. */
  #createMotionMask(currentFrame, referenceFrame) {
    return currentFrame
      .absdiff(referenceFrame)
      .threshold(this.threshold, 255, cv.THRESH_BINARY);
  }

  /** Возвращает кадр, находящийся указанное количество кадров назад. */
  #getHistoricalFrame(interval) {
    const index = this.frameHistory.length - 1 - interval;
    return index >= 0 ? this.frameHistory[index] : null;
  }

  /** Очищает верхнюю и нижнюю зоны бинарной маски. */
  #clearIgnoredZones(mask) {
    const topHeight = Math.round(mask.rows * this.ignoreTopRatio);
    const bottomHeight = Math.round(mask.rows * this.ignoreBottomRatio);

    if (topHeight > 0) {
      mask.drawRectangle(
        new cv.Point2(0, 0),
        new cv.Point2(mask.cols - 1, topHeight - 1),
        new cv.Vec(0),
        -1,
      );
    }

    if (bottomHeight > 0) {
      const startY = Math.max(0, mask.rows - bottomHeight);

      mask.drawRectangle(
        new cv.Point2(0, startY),
        new cv.Point2(mask.cols - 1, mask.rows - 1),
        new cv.Vec(0),
        -1,
      );
    }
  }

  /** Проверяет итоговый прямоугольник по размеру и форме. */
  #isValidBox(box, frameArea) {
    if (box.area < this.minArea) {
      return false;
    }

    if (box.width < this.minWidth || box.height < this.minHeight) {
      return false;
    }

    if (box.area / frameArea > this.maxAreaRatio) {
      return false;
    }

    const aspectRatio = box.width / box.height;

    return (
      aspectRatio >= this.minAspectRatio
      && aspectRatio <= this.maxAspectRatio
    );
  }

  /** Объединяет пересекающиеся и близкие прямоугольники. */
  #mergeNearbyBoxes(boxes) {
    const merged = boxes.map((box) => ({ ...box }));
    let changed = true;

    while (changed) {
      changed = false;

      outer:
      for (let firstIndex = 0; firstIndex < merged.length; firstIndex += 1) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < merged.length;
          secondIndex += 1
        ) {
          if (!this.#areBoxesClose(merged[firstIndex], merged[secondIndex])) {
            continue;
          }

          merged[firstIndex] = this.#unionBoxes(
            merged[firstIndex],
            merged[secondIndex],
          );

          merged.splice(secondIndex, 1);
          changed = true;
          break outer;
        }
      }
    }

    return merged;
  }

  /** Проверяет близость прямоугольников с заданным запасом. */
  #areBoxesClose(first, second) {
    const padding = this.mergePadding;

    return !(
      first.x + first.width + padding < second.x
      || second.x + second.width + padding < first.x
      || first.y + first.height + padding < second.y
      || second.y + second.height + padding < first.y
    );
  }

  /** Возвращает общий прямоугольник для двух областей. */
  #unionBoxes(first, second) {
    const x1 = Math.min(first.x, second.x);
    const y1 = Math.min(first.y, second.y);
    const x2 = Math.max(first.x + first.width, second.x + second.width);
    const y2 = Math.max(first.y + first.height, second.y + second.height);

    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      area: (x2 - x1) * (y2 - y1),
    };
  }

  /** Приводит размер ядра размытия к положительному нечётному числу. */
  #makeOddPositive(value) {
    const normalized = Math.max(1, Math.trunc(Number(value) || 1));
    return normalized % 2 === 0 ? normalized + 1 : normalized;
  }

  /** Ограничивает долю кадра диапазоном от 0 до 0,95. */
  #normalizeRatio(value) {
    const normalized = Number(value);

    if (!Number.isFinite(normalized)) {
      return 0;
    }

    return Math.min(0.95, Math.max(0, normalized));
  }

  /** Полностью очищает историю детектора. */
  reset() {
    this.frameHistory = [];
  }
}

module.exports = MotionDetector;
