'use strict';

/**
 * Объединяет прямоугольники, относящиеся к одному движущемуся объекту.
 *
 * Модуль не знает ничего о MotionDetector, ObjectId, KCF или PTZ.
 * Он получает массив прямоугольников и возвращает новый массив.
 */
class DetectionBoxMerger {
  constructor(options = {}) {
    this.updateConfiguration(options);
  }

  /**
   * Обновляет параметры без пересоздания модуля.
   */
  updateConfiguration(options = {}) {
    this.enabled = options.enabled !== false;

    this.mode = DetectionBoxMerger.#normalizeMode(
      options.mode ?? 'HYBRID',
    );

    this.paddingX = DetectionBoxMerger.#nonNegativeInteger(
      options.paddingX,
      40,
    );

    this.paddingY = DetectionBoxMerger.#nonNegativeInteger(
      options.paddingY,
      25,
    );

    this.maxVerticalOffset = DetectionBoxMerger.#nonNegativeInteger(
      options.maxVerticalOffset,
      35,
    );

    this.minOverlap = DetectionBoxMerger.#ratio(
      options.minOverlap,
      0.10,
    );

    this.iterations = Math.max(
      1,
      DetectionBoxMerger.#nonNegativeInteger(
        options.iterations,
        2,
      ),
    );

    this.debug = Boolean(options.debug);
  }

  /**
   * @param {Array<object>} boxes
   * @returns {Array<object>}
   */
  process(boxes) {
    if (!Array.isArray(boxes)) {
      throw new TypeError(
        'DetectionBoxMerger.process ожидает массив прямоугольников',
      );
    }

    const normalized = boxes
      .map((box) => DetectionBoxMerger.#normalizeBox(box))
      .filter(Boolean);

    if (!this.enabled || normalized.length < 2) {
      return normalized.map((box) => ({ ...box }));
    }

    let current = normalized.map((box) => ({ ...box }));
    const inputCount = current.length;
    let mergedPairs = 0;

    for (
      let iteration = 0;
      iteration < this.iterations;
      iteration += 1
    ) {
      const result = this.#mergeSinglePass(current);

      current = result.boxes;
      mergedPairs += result.mergedPairs;

      if (!result.changed) {
        break;
      }
    }

    if (this.debug && mergedPairs > 0) {
      console.log(
        '[DetectionBoxMerger] ' +
        `вход=${inputCount}; объединено пар=${mergedPairs}; ` +
        `выход=${current.length}`,
      );
    }

    return current;
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      paddingX: this.paddingX,
      paddingY: this.paddingY,
      maxVerticalOffset: this.maxVerticalOffset,
      minOverlap: this.minOverlap,
      iterations: this.iterations,
      debug: this.debug,
    };
  }

  /**
   * За один проход каждая исходная рамка участвует максимум в одном merge.
   * Следующие проходы позволяют объединить цепочку A+B, затем AB+C.
   */
  #mergeSinglePass(boxes) {
    const consumed = new Set();
    const output = [];
    let mergedPairs = 0;

    for (let firstIndex = 0; firstIndex < boxes.length; firstIndex += 1) {
      if (consumed.has(firstIndex)) {
        continue;
      }

      let resultBox = { ...boxes[firstIndex] };
      let mergedInThisStep = false;

      for (
        let secondIndex = firstIndex + 1;
        secondIndex < boxes.length;
        secondIndex += 1
      ) {
        if (consumed.has(secondIndex)) {
          continue;
        }

        if (!this.#shouldMerge(resultBox, boxes[secondIndex])) {
          continue;
        }

        resultBox = DetectionBoxMerger.#union(
          resultBox,
          boxes[secondIndex],
        );

        consumed.add(secondIndex);
        mergedPairs += 1;
        mergedInThisStep = true;
      }

      consumed.add(firstIndex);
      output.push(resultBox);

      /*
       * mergedInThisStep сохраняется для понятности алгоритма и будущей
       * диагностики. В текущей версии отдельная обработка не требуется.
       */
      void mergedInThisStep;
    }

    return {
      boxes: output,
      mergedPairs,
      changed: mergedPairs > 0,
    };
  }

  #shouldMerge(first, second) {
    const intersects = DetectionBoxMerger.#intersects(first, second);
    const overlapRatio = DetectionBoxMerger.#overlapRatio(first, second);
    const closeByPadding = this.#closeByPadding(first, second);
    const verticalCompatible = this.#verticalCompatible(first, second);

    if (this.mode === 'INTERSECTION') {
      return intersects || overlapRatio >= this.minOverlap;
    }

    if (this.mode === 'DISTANCE') {
      return closeByPadding && verticalCompatible;
    }

    /*
     * HYBRID:
     * - реальные пересечения объединяются всегда;
     * - разнесённые части объединяются только при совместимой высоте.
     */
    return (
      intersects
      || overlapRatio >= this.minOverlap
      || (closeByPadding && verticalCompatible)
    );
  }

  #closeByPadding(first, second) {
    return !(
      first.x + first.width + this.paddingX < second.x
      || second.x + second.width + this.paddingX < first.x
      || first.y + first.height + this.paddingY < second.y
      || second.y + second.height + this.paddingY < first.y
    );
  }

  #verticalCompatible(first, second) {
    /*
     * Если рамки уже перекрываются по вертикали, они совместимы независимо
     * от разницы центров. Это важно для корпуса и надстройки одного судна.
     */
    const verticalOverlap = !(
      first.y + first.height < second.y
      || second.y + second.height < first.y
    );

    if (verticalOverlap) {
      return true;
    }

    const firstCenterY = first.y + first.height / 2;
    const secondCenterY = second.y + second.height / 2;

    return (
      Math.abs(firstCenterY - secondCenterY)
      <= this.maxVerticalOffset
    );
  }

  static #intersects(first, second) {
    return !(
      first.x + first.width <= second.x
      || second.x + second.width <= first.x
      || first.y + first.height <= second.y
      || second.y + second.height <= first.y
    );
  }

  /**
   * Отношение площади пересечения к площади меньшей рамки.
   */
  static #overlapRatio(first, second) {
    const x1 = Math.max(first.x, second.x);
    const y1 = Math.max(first.y, second.y);
    const x2 = Math.min(
      first.x + first.width,
      second.x + second.width,
    );
    const y2 = Math.min(
      first.y + first.height,
      second.y + second.height,
    );

    const width = Math.max(0, x2 - x1);
    const height = Math.max(0, y2 - y1);
    const intersectionArea = width * height;

    if (intersectionArea <= 0) {
      return 0;
    }

    const smallerArea = Math.min(
      first.width * first.height,
      second.width * second.height,
    );

    return intersectionArea / Math.max(1, smallerArea);
  }

  static #union(first, second) {
    const x1 = Math.min(first.x, second.x);
    const y1 = Math.min(first.y, second.y);
    const x2 = Math.max(
      first.x + first.width,
      second.x + second.width,
    );
    const y2 = Math.max(
      first.y + first.height,
      second.y + second.height,
    );

    const width = x2 - x1;
    const height = y2 - y1;

    return {
      x: x1,
      y: y1,
      width,
      height,
      area: width * height,
    };
  }

  static #normalizeBox(box) {
    if (!box || typeof box !== 'object') {
      return null;
    }

    const x = Math.round(Number(box.x));
    const y = Math.round(Number(box.y));
    const width = Math.round(Number(box.width));
    const height = Math.round(Number(box.height));

    if (
      ![x, y, width, height].every(Number.isFinite)
      || width <= 0
      || height <= 0
    ) {
      return null;
    }

    return {
      ...box,
      x,
      y,
      width,
      height,
      area: width * height,
    };
  }

  static #normalizeMode(value) {
    const mode = String(value ?? 'HYBRID')
      .trim()
      .toUpperCase();

    if (!['INTERSECTION', 'DISTANCE', 'HYBRID'].includes(mode)) {
      throw new Error(
        `Неизвестный mergeMode: ${mode}. ` +
        'Допустимые значения: INTERSECTION, DISTANCE, HYBRID.',
      );
    }

    return mode;
  }

  static #nonNegativeInteger(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return Math.max(0, Math.round(fallback));
    }

    return Math.max(0, Math.round(number));
  }

  static #ratio(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.max(0, Math.min(1, number));
  }
}

module.exports = DetectionBoxMerger;
