'use strict';

const DetectionBoxMerger = require('./DetectionBoxMerger');

/**
 * Расширяемый конвейер постобработки результатов MotionDetector.
 *
 * Сейчас содержит только DetectionBoxMerger. Позже сюда можно добавить
 * фильтр вложенных рамок, фильтр горизонта и другие независимые этапы.
 */
class DetectionPostProcessor {
  constructor(options = {}) {
    this.boxMerger = new DetectionBoxMerger(
      DetectionPostProcessor.#buildMergeConfiguration(options),
    );
  }

  updateConfiguration(options = {}) {
    this.boxMerger.updateConfiguration(
      DetectionPostProcessor.#buildMergeConfiguration(options),
    );

    return this.getConfiguration();
  }

  process(boxes) {
    return this.boxMerger.process(boxes);
  }

  getConfiguration() {
    return {
      merge: this.boxMerger.getConfiguration(),
    };
  }

  static #buildMergeConfiguration(options = {}) {
    /*
     * Поддерживаем старый mergePadding, чтобы существующие профили не
     * перестали работать после появления раздельных X/Y параметров.
     */
    const legacyPadding = Number(options.mergePadding);

    return {
      enabled: options.mergeEnabled !== false,
      mode: options.mergeMode ?? 'HYBRID',
      paddingX:
        options.mergePaddingX
        ?? (Number.isFinite(legacyPadding) ? legacyPadding : 40),
      paddingY:
        options.mergePaddingY
        ?? (Number.isFinite(legacyPadding) ? legacyPadding : 25),
      maxVerticalOffset:
        options.mergeMaxVerticalOffset ?? 35,
      minOverlap:
        options.mergeMinOverlap ?? 0.10,
      iterations:
        options.mergeIterations ?? 2,
      debug:
        options.mergeDebug ?? false,
    };
  }
}

module.exports = DetectionPostProcessor;
