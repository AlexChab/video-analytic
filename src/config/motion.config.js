'use strict';

// Based on the provided snippets, it seems that the `motion.config.js` file is a configuration file for motion detection in a video analytics project. The file defines various parameters related to image processing, object detection, and tracking.
// NOT CHANGED Please note that the actual implementation of the motion detection logic is not provided in the snippets, but the configuration values are used in the `MotionDetector` class to control its behavior.
module.exports = {
  // ---------- Обработка изображения ----------

  threshold: 20,
  blurSize: 7,
  dilateIterations: 1,
  closeIterations: 1,

  // ---------- История ----------

  comparisonInterval: 5,
  longComparisonInterval: 20,

  // ---------- Размер объекта ----------

  minContourArea: 400,
  minBoxArea: 1400,

  minWidth: 28,
  minHeight: 18,

  maxWidth: 400,
  maxHeight: 250,

  // ---------- Геометрия ----------

  minAspectRatio: 0.25,
  maxAspectRatio: 6,

  // ---------- Объединение ----------

  mergePadding: 12,

  // ---------- Стабилизация красных рамок ----------

  stabilizer: {
    enabled: true,

    // Новая рамка появляется только после двух последовательных обнаружений.
    confirmFrames: 2,

    // Удерживать подтверждённую рамку до 600 мс после пропуска детектором.
    holdTimeMs: 600,

    // Дополнительный предел удержания по числу обработанных кадров.
    maxLostFrames: 15,

    // Условия сопоставления рамки с объектом на следующем кадре.
    maxCenterDistance: 120,
    minIou: 0.05,

    // 0 — сильная инерция, 1 — координаты без сглаживания.
    smoothingFactor: 0.35,
  },

  // ---------- Морская сцена ----------

  ignoreSky: true,
  horizonOffset: 5,
  ignoreBottom: false,
  maxAreaRatio: 0.2,
  ignoreEdgeObjects: true,
};
