'use strict';

/**
 * Встроенный профиль обработки.
 *
 * Эти значения используются как последний безопасный резерв, если:
 * - отсутствует motion.config.js;
 * - отсутствует активный профиль;
 * - конфигурационный файл повреждён;
 * - отдельный параметр не задан ни на одном внешнем уровне.
 */
const DEFAULT_PROCESSING_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'built-in-default',
  name: 'Встроенные безопасные значения',
  scope: 'built-in',
  readOnly: true,
  description: 'Резервная конфигурация, встроенная в приложение.',
  parameters: Object.freeze({
    motion: Object.freeze({
      threshold: 12,
      blurSize: 7,
      dilateIterations: 1,
      closeIterations: 1,
      comparisonInterval: 5,
      longComparisonInterval: 20,
      minContourArea: 400,
      minArea: 1400,
      minBoxArea: 1400,
      minWidth: 28,
      minHeight: 18,
      maxWidth: 400,
      maxHeight: 250,
      minAspectRatio: 0.25,
      maxAspectRatio: 6,
      mergeEnabled: true,
      mergeMode: 'HYBRID',
      mergePaddingX: 40,
      mergePaddingY: 25,
      mergeMaxVerticalOffset: 35,
      mergeMinOverlap: 0.10,
      mergeIterations: 2,
      mergeDebug: false,
      mergePadding: 12,
      boxPaddingX: 6,
      boxPaddingTop: 4,
      boxPaddingBottom: 16,
      ignoreTopRatio: 0,
      ignoreBottomRatio: 0,
      maxAreaRatio: 0.2,
    }),
  }),
});

module.exports = DEFAULT_PROCESSING_PROFILE;
