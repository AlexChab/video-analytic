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
  trackerType: 'CSRT',
  trackerMinWidth: 8,
  trackerMinHeight: 8,
  trackerMaxConsecutiveErrors: 3,
  trackerDebug: false,

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
  apiHost: '127.0.0.1',
  apiPort: 8081,

  /** Радиус поиска ближайшего объекта при выборе по точке. */
  manualPointMaxDistance: 120,

  /** Автоматический захват отключён: ждём команду API. */
  autoLock: false,
};
