'use strict';

/**
 * Единая конфигурация режимов детекции и сопровождения.
 *
 * Менять режим работы проекта теперь нужно только в этом файле.
 */
module.exports = {
  /**
   * Доступные режимы:
   * - DETECTION_ONLY — только красные рамки найденных объектов;
   * - AUTO_TRACKING — автоматический захват цели в центральном круге.
   * - MANUAL_TRACKING — ручное сопровождение цели.
   */

  mode: 'MANUAL_TRACKING',

  /**
   * Тип автоматического захвата.
   * ALL_OBJECTS — в выборе участвуют все объекты детектора.
   */
  captureType: 'ALL_OBJECTS',

  /** Радиус красного круга автоматического захвата, пикселей. */
  captureRadius: 180,

  /**
   * Алгоритм сопровождения одиночной зелёной цели.
   *
   * KCF — основной режим реального времени для Full HD.
   * CSRT — точнее, но на CPU может занимать сотни миллисекунд на кадр.
   * MIL — резервный вариант.
   */
  /**
   * Режим подготовки изображения для сопровождения:
   * - STANDARD — KCF работает по полному исходному кадру;
   * - LOW_CONTRAST — KCF работает в фиксированном усиленном ROI.
   */
  trackingMode: 'LOW_CONTRAST',

  trackerType: 'KCF',
  trackerMinWidth: 8,
  trackerMinHeight: 8,
  trackerMaxConsecutiveErrors: 3,
  trackerDebug: false,

  /**
   * Adaptive Tracker Box.
   *
   * MotionDetector отдаёт плотную рамку объекта. Для малой цели KCF получает
   * увеличенную стартовую рамку с окружающим контекстом.
   *
   * Этот слой изменяет только рамку инициализации трекера.
   * Размер голубого LOW_CONTRAST ROI рассчитывается уже после него.
   */
  adaptiveTrackerBoxEnabled: true,

  /** Минимальный размер стартовой зелёной рамки KCF. */
  adaptiveTrackerBoxMinWidth: 64,
  adaptiveTrackerBoxMinHeight: 64,

  /** Границы профилей по максимальной стороне исходной детекции. */
  adaptiveTrackerBoxSmallTargetMaxSize: 64,
  adaptiveTrackerBoxMediumTargetMaxSize: 120,
  adaptiveTrackerBoxLargeTargetMaxSize: 240,

  /**
   * Дополнительный padding с каждой стороны относительно размера детекции.
   *
   * SMALL  = 60%
   * MEDIUM = 35%
   * LARGE  = 15%
   * HUGE   = 5%
   */
  adaptiveTrackerBoxSmallPaddingRatio: 0.6,
  adaptiveTrackerBoxMediumPaddingRatio: 0.35,
  adaptiveTrackerBoxLargePaddingRatio: 0.15,
  adaptiveTrackerBoxHugePaddingRatio: 0.05,

  /** Абсолютный предел padding с каждой стороны, пикселей. */
  adaptiveTrackerBoxMaxPaddingX: 32,
  adaptiveTrackerBoxMaxPaddingY: 32,

  /**
   * Защита от чрезмерного расширения очень маленькой/ошибочной детекции.
   * Итоговая сторона не может превышать исходную более чем в 3.5 раза.
   */
  adaptiveTrackerBoxMaxExpansionRatio: 3.5,

  /** Настройки специализированного режима LOW_CONTRAST. */
  lowContrastRoiPaddingX: 1.0,
  lowContrastRoiPaddingY: 1.2,
  lowContrastRoiMinWidth: 320,
  lowContrastRoiMinHeight: 220,

  /**
   * Recenter по проценту свободного места между зелёной рамкой и краями ROI.
   *
   * X=0.15: перенос при остатке 15% ширины ROI слева или справа.
   * Y=0.10: перенос при остатке 10% высоты ROI сверху или снизу.
   */
  /**
   * Зона WARNING по свободному проценту до края ROI.
   * WARNING не переносит ROI, а только разрешает аварийный recenter при
   * следующей временной ошибке KCF.
   */
  lowContrastRoiWarningEdgeRatioX: 0.15,
  lowContrastRoiWarningEdgeRatioY: 0.1,

  /** WARNING должен сохраняться несколько кадров, а не один скачок KCF. */
  lowContrastRoiWarningConfirmFrames: 3,

  /**
   * TIME_BASED — переносить ROI до потери KCF после устойчивого WARNING.
   * LOSS_BASED — старое поведение: перенос только после ошибки KCF.
   */
  lowContrastRoiRecenterMode: 'TIME_BASED',

  /**
   * В TIME_BASED перенос выполняется после 8 последовательных кадров
   * нахождения рамки в зоне WARNING.
   */
  lowContrastRoiRecenterAfterWarningFrames: 8,

  /**
   * Максимум переносов в tracking-сессии.
   * Ноль означает отсутствие лимита.
   */
  lowContrastRoiMaxRecenters: 0,

  /** Выход из WARNING требует дополнительного запаса в 3% размера ROI. */
  lowContrastRoiWarningHysteresisRatio: 0.03,

  /**
   * Старый параметр оставлен для совместимости.
   * Используется только если lowContrastRoiMaxRecenters не задан.
   */
  lowContrastRoiMaxRecentersOnLoss: 2,

  /** Пауза после успешного аварийного переноса ROI. */
  lowContrastRoiRecenterCooldownFrames: 8,

  /**
   * Старые параметры сохранены для обратной совместимости.
   * Новая логика использует WarningEdgeRatioX/Y.
   */
  lowContrastRoiRecenterEdgeRatioX: 0.15,
  lowContrastRoiRecenterEdgeRatioY: 0.1,
  lowContrastRoiRecenterHysteresisRatio: 0.03,

  /**
   * Старый совместимый параметр. Новая логика использует EdgeRatioX/Y.
   */
  lowContrastRoiRecenterMargin: 0.25,

  lowContrastClaheEnabled: true,
  lowContrastClaheClipLimit: 1.7,
  lowContrastClaheTileSize: 8,
  lowContrastGamma: 1.08,
  lowContrastSharpen: 0.1,

  /**
   * Отдельное диагностическое окно фактического enhanced ROI,
   * который передаётся в локальный KCF.
   *
   * Дополнительная copy() выполняется только при включённом debug-окне.
   */
  lowContrastDebugWindowEnabled: true,
  lowContrastDebugWindowWidth: 640,
  lowContrastDebugWindowHeight: 440,
  lowContrastDebugShowSafeArea: true,
  lowContrastDebugShowStats: true,

  /**
   * Scale Health Monitor.
   *
   * Сравнивает зелёную KCF-рамку с ближайшей красной Motion-рамкой.
   * Версия v1 только диагностирует изменение масштаба и не вмешивается
   * в сопровождение.
   */
  trackerScaleHealthEnabled: true,
  trackerScaleConfirmFrames: 4,
  trackerScaleMaxCenterDistanceRatio: 0.35,
  trackerScaleMinIou: 0.2,

  /**
   * Полезно при приближении: большая красная рамка может иметь низкий IoU,
   * но всё ещё надёжно покрывать зелёную рамку.
   */
  trackerScaleMinTrackedCoverage: 0.55,

  /** Motion-рамка больше KCF минимум на 35% площади. */
  trackerScaleGrowThresholdRatio: 1.35,

  /** Motion-рамка меньше KCF минимум на 35% площади. */
  trackerScaleShrinkThresholdRatio: 0.65,

  /**
   * Автокоррекция намеренно отсутствует в v1.
   * Сначала проверяем достоверность MATCH / RATIO на реальном потоке.
   */
  trackerScaleAutoCorrect: false,

  /**
   * Capture Debugger HUD. Только наблюдение, алгоритм сопровождения не меняет.
   * Показывает: ID, состояние KCF, выход за голубую SAFE AREA, recenter
   * и последнюю причину перехода TRACKING -> LOST/WAITING.
   */
  captureDiagnosticsEnabled: true,
  captureDiagnosticsHudEnabled: true,
  captureDiagnosticsHistoryLength: 20,

  /** Размеры мёртвой зоны будущего PTZ-управления. */
  deadZoneX: 100,
  deadZoneY: 70,

  /**
   * Сглаживание центра цели перед формированием PTZ-команды.
   * processNoise выше — фильтр быстрее реагирует на манёвр цели.
   * measurementNoise выше — сильнее подавляется дрожание измерений.
   */

  kalmanEnabled: true,
  kalmanProcessNoise: 35,
  kalmanMeasurementNoise: 90,

  /** Упреждение PTZ-команды для компенсации задержки видеопотока, мс. */
  ptzPredictionLeadMs: 120,

  /**
   * PTZ Stability Layer.
   *
   * PAN оставляем быстрее, а TILT намеренно ограничиваем сильнее:
   * вертикальное перемещение сильнее меняет фон и чаще срывает KCF.
   */
  ptzMinPanSpeed: 0.001,
  ptzMaxPanSpeed: 0.01,

  ptzMinTiltSpeed: 0.001,
  ptzMaxTiltSpeed: 0.01,

  /**
   * Максимальное изменение нормализованной скорости за одну команду.
   * Уменьшает резкий старт/ускорение камеры.
   */
  ptzPanSpeedSlewLimit: 0.04,
  ptzTiltSpeedSlewLimit: 0.02,

  /**
   * Автоматический контур сопровождения не формирует команды ZOOM.
   * Ручной интеллектуальный zoom добавим отдельным этапом с повторным
   * захватом цели после стабилизации изображения.
   */
  ptzZoomLockedDuringTracking: true,

  /**
   * Fine Centering — точная доводка цели в центр кадра.
   *
   * Общая dead zone остаётся для грубого режима. Когда обе ошибки становятся
   * меньше ENTER, контроллер переходит в FINE и доводит каждую ось отдельно
   * до STOP-предела.
   */
  fineCenteringEnabled: true,

  /** Вход в режим точной доводки, пикселей. */
  fineCenteringEnterErrorX: 24,
  fineCenteringEnterErrorY: 24,

  /** Требуемая точность остановки по каждой оси, пикселей. */
  fineCenteringStopErrorX: 5,
  fineCenteringStopErrorY: 5,

  /**
   * Выход из FINE произойдёт только после ENTER + hysteresis.
   * Это предотвращает переключение COARSE/FINE на границе.
   */
  fineCenteringHysteresis: 4,

  /** Очень малые нормализованные скорости точной доводки. */
  fineCenteringMinPanSpeed: 0.006,
  fineCenteringMaxPanSpeed: 0.02,
  fineCenteringMinTiltSpeed: 0.005,
  fineCenteringMaxTiltSpeed: 0.015,

  /**
   * Компенсацию механической инерции пока не включаем без измерений.
   * После настройки конкретной камеры можно включить и задать lead pixels.
   */
  fineCenteringBrakingEnabled: false,
  fineCenteringPanLeadPixels: 0,
  fineCenteringTiltLeadPixels: 0,

  /**
   * Сквозная диагностика PTZ.
   */
  ptzDebugHudEnabled: true,

  /**
   * Очень подробный лог на каждый расчёт PTZ.
   * Включать кратковременно.
   */
  ptzDebugLogEnabled: true,

  /** Период сводной PTZ-строки, чтобы не засорять консоль. */
  ptzDebugLogIntervalMs: 500,

  /** Минимальный интервал повторной отправки одинаковой PTZ-команды. */
  ptzCommandIntervalMs: 300,

  /** Визуальные элементы. */
  showCenterCross: true,
  showCaptureZone: true,
  showDeadZone: true,
  showObjectIds: true,

  /** Максимальное перемещение объекта между кадрами для сохранения его ID. */
  objectIdMaxDistance: 120,

  /** Сколько кадров хранить ID временно исчезнувшего объекта. */
  objectIdLostFrameLimit: 12,

  /** В ручном режиме красные рамки детектора не выводятся. */
  showDetectionsInManualMode: true,

  /** HTTP API для выбора цели. */
  // apiHost: '127.0.0.1',
  apiHost: '0.0.0.0',
  apiPort: 8081,

  /** Радиус поиска ближайшего объекта при выборе по точке. */
  manualPointMaxDistance: 120,

  /** Автоматический захват отключён: ждём команду API. */
  autoLock: false,
};
