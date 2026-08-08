'use strict';

/**
 * Настройки отдельного визуального канала оператора.
 *
 * Важно: улучшение применяется только к копии кадра для отображения.
 * MotionDetector, KCF, PTZ и остальные алгоритмы получают исходный кадр.
 */
module.exports = {
  enabled: false,

  // ORIGINAL | CLAHE | CLAHE_SHARPEN
  mode: 'ORIGINAL',

  claheClipLimit: 1.7,
  claheTileSize: 8,

  sharpenAmount: 0.10,

  /** Показывать небольшой HUD активного режима на улучшенном кадре. */
  showHud: true,
};
