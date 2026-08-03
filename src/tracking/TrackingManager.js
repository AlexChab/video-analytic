'use strict';


const logger = require('../utils/Logger');
const { performance } = require('node:perf_hooks');
const MotionDetector = require('../detection/MotionDetector');
const DetectionStabilizer = require('../detection/DetectionStabilizer');
const ObjectTracker = require('../analytics/ObjectTracker');
const CameraController = require('../camera/CameraController');
const ObjectIdManager = require('./ObjectIdManager');

/**
 * Управляет детекцией и ручным сопровождением цели.
 * В режиме MANUAL_TRACKING система постоянно обновляет скрытый список объектов,
 * но не рисует рамки, пока API не передаст ID объекта или точку изображения.
 */
class TrackingManager {
  constructor({
    width,
    height,
    config,
    motionConfig,
    manualControl = null,
    cameraCommandDispatcher = null,
    cameraControlConfig = {},
  }) {
    this.width = width;
    this.height = height;
    this.config = config;
    this.manualControl = manualControl;
    this.mode = String(config.mode).trim().toUpperCase();
    this.captureType = String(config.captureType).trim().toUpperCase();

    if (
      !['DETECTION_ONLY', 'AUTO_TRACKING', 'MANUAL_TRACKING'].includes(
        this.mode,
      )
    ) {
      throw new Error(`Неизвестный режим сопровождения: ${this.mode}`);
    }
    if (this.mode === 'MANUAL_TRACKING' && !this.manualControl) {
      throw new Error('MANUAL_TRACKING требует manualControl');
    }

    if (!motionConfig || typeof motionConfig !== 'object') {
      throw new Error('TrackingManager требует motionConfig от ProfileManager');
    }

    this.motionDetector = new MotionDetector(motionConfig);
    this.detectionStabilizer = new DetectionStabilizer(
      motionConfig.stabilizer ?? {},
    );
    this.objectIdManager = new ObjectIdManager({
      maxMatchDistance: config.objectIdMaxDistance ?? 120,
      lostFrameLimit: config.objectIdLostFrameLimit ?? 12,
    });
    this.objectTracker = new ObjectTracker({
      // CSRT на Full HD может занимать 150–400 мс на один update().
      // KCF заметно быстрее и поэтому используется как базовый режим реального времени.
      // При необходимости алгоритм можно вернуть через tracking.trackerType.
      type: config.trackerType ?? 'KCF',
      minWidth: config.trackerMinWidth ?? 8,
      minHeight: config.trackerMinHeight ?? 8,
      maxConsecutiveErrors: config.trackerMaxConsecutiveErrors ?? 3,
      debug: Boolean(config.trackerDebug ?? false),
    });
    this.cameraController = new CameraController({
      frameWidth: width,
      frameHeight: height,
      deadZoneX: config.deadZoneX,
      deadZoneY: config.deadZoneY,
      commandDispatcher: cameraCommandDispatcher,
      kalmanEnabled: config.kalmanEnabled ?? true,
      kalmanProcessNoise: config.kalmanProcessNoise ?? 35,
      kalmanMeasurementNoise: config.kalmanMeasurementNoise ?? 90,
      predictionLeadMs: config.ptzPredictionLeadMs ?? 120,
      minPanSpeed: cameraControlConfig.minPanSpeed ?? 0.15,
      maxPanSpeed: cameraControlConfig.maxPanSpeed ?? 1,
      minTiltSpeed: cameraControlConfig.minTiltSpeed ?? 0.15,
      maxTiltSpeed: cameraControlConfig.maxTiltSpeed ?? 1,
      invertPan: cameraControlConfig.invertPan ?? false,
      invertTilt: cameraControlConfig.invertTilt ?? false,
    });

    this.previousState = 'WAITING_COMMAND';
    this.activeTargetId = null;
    this.performanceStats = {};
  }

  /**
   * Применяет новые tracking- и motion-параметры без пересоздания менеджера.
   * Текущий CSRT-трек сохраняется. Изменение режима во время активного
   * сопровождения разрешено, но при выходе из MANUAL_TRACKING трек сбрасывается.
   */
  updateConfiguration({ tracking = {}, motion = {} } = {}) {
    if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking)) {
      throw new TypeError('TrackingManager: tracking должен быть объектом');
    }
    if (!motion || typeof motion !== 'object' || Array.isArray(motion)) {
      throw new TypeError('TrackingManager: motion должен быть объектом');
    }

    const previousMode = this.mode;
    this.config = { ...this.config, ...tracking };

    const nextMode = String(this.config.mode ?? this.mode).trim().toUpperCase();
    const nextCaptureType = String(
      this.config.captureType ?? this.captureType,
    ).trim().toUpperCase();

    if (!['DETECTION_ONLY', 'AUTO_TRACKING', 'MANUAL_TRACKING'].includes(nextMode)) {
      throw new Error(`Неизвестный режим сопровождения: ${nextMode}`);
    }
    if (nextMode === 'MANUAL_TRACKING' && !this.manualControl) {
      throw new Error('MANUAL_TRACKING требует manualControl');
    }

    this.mode = nextMode;
    this.captureType = nextCaptureType;
    this.motionDetector.updateConfiguration(motion);
    this.detectionStabilizer.updateConfiguration(motion.stabilizer ?? {});
    this.objectIdManager.updateConfiguration({
      maxMatchDistance: this.config.objectIdMaxDistance,
      lostFrameLimit: this.config.objectIdLostFrameLimit,
    });
    this.cameraController.updateConfiguration({
      deadZoneX: this.config.deadZoneX,
      deadZoneY: this.config.deadZoneY,
      kalmanEnabled: this.config.kalmanEnabled,
      kalmanProcessNoise: this.config.kalmanProcessNoise,
      kalmanMeasurementNoise: this.config.kalmanMeasurementNoise,
      predictionLeadMs: this.config.ptzPredictionLeadMs,
    });

    if (previousMode === 'MANUAL_TRACKING' && nextMode !== 'MANUAL_TRACKING') {
      this.objectTracker.reset('Смена режима конфигурации');
      this.activeTargetId = null;
      this.previousState = 'WAITING_COMMAND';
    }

    return this.getConfiguration();
  }

  /** Возвращает текущую конфигурацию для диагностического вывода. */
  getConfiguration() {
    return {
      tracking: { ...this.config, mode: this.mode, captureType: this.captureType },
      motion: {
        ...this.motionDetector.getConfiguration(),
        stabilizer: this.detectionStabilizer.getConfiguration(),
      },
    };
  }

  process(frame) {
    if (this.mode === 'DETECTION_ONLY')
      return this.#processDetectionOnly(frame);
    if (this.mode === 'MANUAL_TRACKING')
      return this.#processManualTracking(frame);
    // AUTO_TRACKING временно ведём как ожидание ручной команды, чтобы случайный
    // автоматический захват не включился при ошибочной конфигурации.
    return this.#processDetectionOnly(frame);
  }

  #detect(frame) {
    let startedAt = performance.now();
    const rawDetections = this.motionDetector.detect(frame);
    this.#record('motionDetector', performance.now() - startedAt);

    startedAt = performance.now();
    const stableDetections = this.detectionStabilizer.update(rawDetections);
    this.#record('detectionStabilizer', performance.now() - startedAt);

    startedAt = performance.now();
    const detections = this.objectIdManager.update(stableDetections);
    this.#record('objectIdManager', performance.now() - startedAt);

    return detections;
  }

  #processDetectionOnly(frame) {
    if (this.objectTracker.isActive())
      this.objectTracker.reset('DETECTION_ONLY');
    const detections = this.#detect(frame);
    logger.info(
      '[DETECT]',
      detections.length,
      detections.map((o) => o.id),
    );

    const tracking = this.#trackingState('DETECTION_ONLY', null, null, false);
    return {
      detections,
      tracking,
      trackedRect: null,
      ptzCommand: this.#stopCommand(),
    };
  }

  #processManualTracking(frame) {
    const detections = this.#detect(frame);
    logger.info(
      '[DETECT]',
      detections.length,
      detections.map((o) => o.id),
    );
    this.manualControl.setObjects(detections);

    const command = this.manualControl.consumeCommand();
    if (command) this.#applyManualCommand(command, frame, detections);

    let trackedRect = null;
    let targetCenter = null;

    if (this.manualControl.enabled && this.objectTracker.isActive()) {
      const startedAt = performance.now();
      trackedRect = this.objectTracker.update(frame);
      this.#record('trackerUpdate', performance.now() - startedAt);
      if (trackedRect) targetCenter = this.objectTracker.getCenter();
    }

    let state = 'WAITING_COMMAND';
    let message = 'Ожидание команды API';
    if (!this.manualControl.enabled) {
      state = 'DISABLED';
      message = 'Слежение выключено';
    } else if (trackedRect && targetCenter) {
      state = 'TRACKING';
      message = 'Цель сопровождается';
    } else if (this.objectTracker.isActive()) {
      state = 'TEMPORARILY_LOST';
      message = 'Цель временно потеряна';
    }

    if (!this.objectTracker.isActive() && state !== 'TRACKING') {
      this.activeTargetId = null;
    }

    const tracking = this.#trackingState(
      state,
      trackedRect,
      targetCenter,
      this.objectTracker.isActive(),
    );
    const visibleDetections = this.config.showDetectionsInManualMode
      ? detections
      : [];
    let startedAt = performance.now();
    const ptzCommand =
      state === 'TRACKING'
        ? this.cameraController.calculate(targetCenter)
        : this.#stopCommand();
    this.#record('ptzCalculate', performance.now() - startedAt);

    // Реальная отправка PTZ пока остаётся в тестовом контроллере.
    // Отдельно измеряем execute(), чтобы будущий сетевой драйвер камеры
    // не мог незаметно заблокировать видеоконвейер.
    startedAt = performance.now();
    this.cameraController.execute(ptzCommand, state);
    this.#record('ptzExecute', performance.now() - startedAt);

    startedAt = performance.now();
    this.manualControl.setStatus({
      state,
      message,
      targetId: this.activeTargetId,
      targetCenter,
      trackedRect,
      frame: { width: this.width, height: this.height },
    });
    this.#record('manualStatus', performance.now() - startedAt);
    this.previousState = state;
    return { detections: visibleDetections, tracking, trackedRect, ptzCommand };
  }

  #applyManualCommand(command, frame, detections) {
    if (command.type === 'RESET' || command.type === 'DISABLE') {
      this.objectTracker.reset(
        command.type === 'DISABLE'
          ? 'API: слежение выключено'
          : 'API: сброс цели',
      );
      this.activeTargetId = null;
      this.cameraController.reset(command.type);
      return;
    }
    if (command.type === 'ENABLE') return;

    let target = null;
    if (command.type === 'SELECT_ID') {
      target = detections.find((item) => item.id === command.id) ?? null;
    } else if (command.type === 'SELECT_POINT') {
      target = this.#findByPoint(detections, command.x, command.y);
    }

    if (!target) {
      this.manualControl.setStatus({
        state: 'WAITING_COMMAND',
        message:
          command.type === 'SELECT_ID'
            ? `Объект ID ${command.id} не найден на текущем кадре`
            : `Объект возле X:${command.x} Y:${command.y} не найден`,
      });
      return;
    }

    try {
      this.objectTracker.reset('Новая команда ручного выбора');
      this.cameraController.reset('Новая цель');
      this.objectTracker.start(frame, target);
      this.activeTargetId = target.id ?? null;
      this.motionDetector.reset();
      logger.info(
        `[TRACKING] Ручной захват ID=${this.activeTargetId}, x=${target.x}, y=${target.y}`,
      );
    } catch (error) {
      this.activeTargetId = null;
      this.objectTracker.reset('Ошибка ручного захвата');
      this.manualControl.setStatus({
        state: 'WAITING_COMMAND',
        message: `Ошибка захвата: ${error.message}`,
      });
    }
  }

  #findByPoint(detections, x, y) {
    const inside = detections.filter(
      (d) => x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height,
    );
    if (inside.length)
      return inside.sort((a, b) => a.width * a.height - b.width * b.height)[0];
    const maxDistance = this.config.manualPointMaxDistance ?? 120;
    let best = null;
    let bestDistance = Infinity;
    for (const d of detections) {
      const cx = d.x + d.width / 2;
      const cy = d.y + d.height / 2;
      const distance = Math.hypot(cx - x, cy - y);
      if (distance < bestDistance && distance <= maxDistance) {
        best = d;
        bestDistance = distance;
      }
    }
    return best;
  }

  #trackingState(state, trackedRect, targetCenter, trackerActive) {
    return {
      state,
      target: null,
      targetCenter,
      trackedRect,
      trackerActive,
      justCaptured: state === 'TRACKING' && this.previousState !== 'TRACKING',
      justLost:
        state === 'WAITING_COMMAND' && this.previousState === 'TRACKING',
      trackerState: this.objectTracker.getState(),
      targetId: this.activeTargetId,
      mode: this.mode,
      captureType: this.captureType,
      captureRadius: this.config.captureRadius,
    };
  }

  #stopCommand() {
    return { pan: 'STOP', tilt: 'STOP', moving: false };
  }

  reset() {
    this.motionDetector.reset();
    this.detectionStabilizer.reset();
    this.objectIdManager.reset();
    this.objectTracker.reset('Сброс TrackingManager');
    this.cameraController.reset('Сброс TrackingManager');
    this.previousState = 'WAITING_COMMAND';
    this.activeTargetId = null;
  }

  getPerformanceStats() {
    const result = this.performanceStats;
    this.performanceStats = {};
    return result;
  }

  #record(name, durationMs) {
    if (!Number.isFinite(durationMs)) return;
    const metric = this.performanceStats[name] ?? {
      totalMs: 0,
      maxMs: 0,
      calls: 0,
    };
    metric.totalMs += durationMs;
    metric.maxMs = Math.max(metric.maxMs, durationMs);
    metric.calls += 1;
    this.performanceStats[name] = metric;
  }
}

module.exports = TrackingManager;
