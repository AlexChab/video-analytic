'use strict';

// Based on the provided snippets, it seems that the `motion.config.js` file is a configuration file for motion detection in a video analytics project. The file defines various parameters related to image processing, object detection, and tracking.
// NOT CHANGED Please note that the actual implementation of the motion detection logic is not provided in the snippets, but the configuration values are used in the `MotionDetector` class to control its behavior.
module.exports = {
  // ---------- Обработка изображения ----------

  threshold: 3,
  blurSize: 7,
  dilateIterations: 1,
  closeIterations: 1,

  // ---------- Motion Diagnostics ----------

  /**
   * Диагностика причин, по которым контур не дошёл до красной рамки.
   * На сам алгоритм детекции не влияет.
   */
  diagnostics: {
    enabled: true,

    // Краткие строки прямо в техническом OpenCV HUD.
    hudEnabled: true,

    // Лог раз в секунду. На первом этапе оставляем выключенным, чтобы
    // не засорять консоль; включается при необходимости.
    logEnabled: false,
    logIntervalMs: 1000,

    // Сколько последних отказов хранить для диагностики/HUD/API.
    keepLastRejects: 5,

    /**
     * Отдельное инженерное окно Motion Inspector.
     * Никак не влияет на алгоритм детекции.
     */
    inspector: {
      enabled: true,
      showWindow: true,
      windowName: 'MOTION INSPECTOR',

      // Размер отдельного окна относительно исходного кадра.
      scale: 0.65,

      // Защита от перегрузки окна сотнями рамок.
      maxBoxesPerStage: 50,
      maxRejectBoxes: 30,

      showRejects: true,
      showPreMerge: true,
      showPostMerge: true,
      showFinalAccepted: true,

      // Внутренние track DetectionStabilizer, включая WAIT 1/2.
      showStabilizerTracks: true,

      // Красные Object ID после подтверждения стабилизатором.
      showStableDetections: true,
      showLegend: true,

      // Ширина паспорта выбранной рамки в FREEZE.
      passportWidth: 470,

      /*
       * F9/F — FREEZE/LIVE
       * TAB  — следующий объект
       * B    — предыдущий объект
       * 0    — все стадии
       * 1    — REJECT
       * 2    — PRE
       * 3    — MERGE
       * 4    — RAW
       * 5    — STAB
       * 6    — ID
       * S    — сохранить frozen snapshot (.jpg + .json)
       */

      // По умолчанию: <project>/output/motion-inspector
      // snapshotDirectory: 'C:/Project/video-analytic/output/motion-inspector',
    },
  },

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

  // ---------- Объединение прямоугольников ----------

  /** Можно полностью отключить без изменения остального конвейера. */
  mergeEnabled: true,

  /** INTERSECTION | DISTANCE | HYBRID */
  mergeMode: 'HYBRID',

  /** Допустимый горизонтальный и вертикальный разрыв между частями цели. */
  mergePaddingX: 40,
  mergePaddingY: 25,

  /** Ограничение объединения разнесённых по высоте объектов. */
  mergeMaxVerticalOffset: 35,

  /** Минимальное перекрытие относительно площади меньшей рамки. */
  mergeMinOverlap: 0.1,

  /** Позволяет последовательно объединить A+B, затем AB+C. */
  mergeIterations: 2,

  /** Краткая статистика merge в консоли. */
  mergeDebug: false,

  /**
   * Старый совместимый параметр. Используется только если не заданы
   * mergePaddingX/mergePaddingY.
   */
  mergePadding: 12,

  // ---------- Padding итоговой красной рамки ----------

  boxPaddingX: 6,
  boxPaddingTop: 4,
  boxPaddingBottom: 16,

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
