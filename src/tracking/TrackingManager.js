'use strict';


const logger = require('../utils/Logger');
const { performance } = require('node:perf_hooks');
const MotionDetector = require('../detection/MotionDetector');
const DetectionStabilizer = require('../detection/DetectionStabilizer');
const ObjectTracker = require('../analytics/ObjectTracker');
const LowContrastObjectTracker = require('./LowContrastObjectTracker');
const CameraController = require('../camera/CameraController');
const ObjectIdManager = require('./ObjectIdManager');
const AdaptiveTrackerBox = require('./AdaptiveTrackerBox');
const CaptureDiagnostics = require('./CaptureDiagnostics');

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
    this.trackingMode = this.#normalizeTrackingMode(
      config.trackingMode ?? 'STANDARD',
    );

    this.adaptiveTrackerBox = new AdaptiveTrackerBox({
      enabled: config.adaptiveTrackerBoxEnabled ?? true,
      minWidth: config.adaptiveTrackerBoxMinWidth ?? 64,
      minHeight: config.adaptiveTrackerBoxMinHeight ?? 64,
      smallTargetMaxSize:
        config.adaptiveTrackerBoxSmallTargetMaxSize ?? 64,
      mediumTargetMaxSize:
        config.adaptiveTrackerBoxMediumTargetMaxSize ?? 120,
      largeTargetMaxSize:
        config.adaptiveTrackerBoxLargeTargetMaxSize ?? 240,
      smallPaddingRatio:
        config.adaptiveTrackerBoxSmallPaddingRatio ?? 0.60,
      mediumPaddingRatio:
        config.adaptiveTrackerBoxMediumPaddingRatio ?? 0.35,
      largePaddingRatio:
        config.adaptiveTrackerBoxLargePaddingRatio ?? 0.15,
      hugePaddingRatio:
        config.adaptiveTrackerBoxHugePaddingRatio ?? 0.05,
      maxPaddingX:
        config.adaptiveTrackerBoxMaxPaddingX ?? 32,
      maxPaddingY:
        config.adaptiveTrackerBoxMaxPaddingY ?? 32,
      maxExpansionRatio:
        config.adaptiveTrackerBoxMaxExpansionRatio ?? 3.5,
    });

    this.objectTracker = this.#createObjectTracker(this.config);
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
      minPanSpeed:
        config.ptzMinPanSpeed ??
        cameraControlConfig.minPanSpeed ??
        0.04,
      maxPanSpeed:
        config.ptzMaxPanSpeed ??
        cameraControlConfig.maxPanSpeed ??
        0.30,
      minTiltSpeed:
        config.ptzMinTiltSpeed ??
        cameraControlConfig.minTiltSpeed ??
        0.02,
      maxTiltSpeed:
        config.ptzMaxTiltSpeed ??
        cameraControlConfig.maxTiltSpeed ??
        0.10,
      panSpeedSlewLimit:
        config.ptzPanSpeedSlewLimit ?? 0.04,
      tiltSpeedSlewLimit:
        config.ptzTiltSpeedSlewLimit ?? 0.02,
      zoomLockedDuringTracking:
        config.ptzZoomLockedDuringTracking ?? true,

      fineCentering: {
        enabled: config.fineCenteringEnabled ?? true,
        enterErrorX: config.fineCenteringEnterErrorX ?? 24,
        enterErrorY: config.fineCenteringEnterErrorY ?? 24,
        stopErrorX: config.fineCenteringStopErrorX ?? 5,
        stopErrorY: config.fineCenteringStopErrorY ?? 5,
        hysteresis: config.fineCenteringHysteresis ?? 4,
        minPanSpeed: config.fineCenteringMinPanSpeed ?? 0.006,
        maxPanSpeed: config.fineCenteringMaxPanSpeed ?? 0.020,
        minTiltSpeed: config.fineCenteringMinTiltSpeed ?? 0.005,
        maxTiltSpeed: config.fineCenteringMaxTiltSpeed ?? 0.015,
        brakingEnabled:
          config.fineCenteringBrakingEnabled ?? false,
        panLeadPixels:
          config.fineCenteringPanLeadPixels ?? 0,
        tiltLeadPixels:
          config.fineCenteringTiltLeadPixels ?? 0,
      },

      ptzDebugLogEnabled:
        config.ptzDebugLogEnabled ?? true,
      ptzDebugLogIntervalMs:
        config.ptzDebugLogIntervalMs ?? 500,

      invertPan: cameraControlConfig.invertPan ?? false,
      invertTilt: cameraControlConfig.invertTilt ?? false,
    });

    this.previousState = 'WAITING_COMMAND';
    this.activeTargetId = null;
    this.captureDiagnostics = new CaptureDiagnostics({
      enabled: config.captureDiagnosticsEnabled ?? true,
      historyLength: config.captureDiagnosticsHistoryLength ?? 20,
    });
    this.lastMotionDiagnostics = this.motionDetector.getDiagnosticsSnapshot();
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

    const nextTrackingMode = this.#normalizeTrackingMode(
      this.config.trackingMode ?? this.trackingMode,
    );

    if (nextTrackingMode !== this.trackingMode) {
      this.objectTracker.reset('Смена trackingMode');
      this.trackingMode = nextTrackingMode;
      this.objectTracker = this.#createObjectTracker(this.config);
      this.activeTargetId = null;
      this.previousState = 'WAITING_COMMAND';
    }

    this.motionDetector.updateConfiguration(motion);
    this.detectionStabilizer.updateConfiguration(motion.stabilizer ?? {});
    this.objectIdManager.updateConfiguration({
      maxMatchDistance: this.config.objectIdMaxDistance,
      lostFrameLimit: this.config.objectIdLostFrameLimit,
    });

    this.captureDiagnostics.updateConfiguration({
      enabled: this.config.captureDiagnosticsEnabled,
      historyLength: this.config.captureDiagnosticsHistoryLength,
    });

    this.adaptiveTrackerBox.updateConfiguration({
      enabled: this.config.adaptiveTrackerBoxEnabled,
      minWidth: this.config.adaptiveTrackerBoxMinWidth,
      minHeight: this.config.adaptiveTrackerBoxMinHeight,
      smallTargetMaxSize:
        this.config.adaptiveTrackerBoxSmallTargetMaxSize,
      mediumTargetMaxSize:
        this.config.adaptiveTrackerBoxMediumTargetMaxSize,
      largeTargetMaxSize:
        this.config.adaptiveTrackerBoxLargeTargetMaxSize,
      smallPaddingRatio:
        this.config.adaptiveTrackerBoxSmallPaddingRatio,
      mediumPaddingRatio:
        this.config.adaptiveTrackerBoxMediumPaddingRatio,
      largePaddingRatio:
        this.config.adaptiveTrackerBoxLargePaddingRatio,
      hugePaddingRatio:
        this.config.adaptiveTrackerBoxHugePaddingRatio,
      maxPaddingX: this.config.adaptiveTrackerBoxMaxPaddingX,
      maxPaddingY: this.config.adaptiveTrackerBoxMaxPaddingY,
      maxExpansionRatio:
        this.config.adaptiveTrackerBoxMaxExpansionRatio,
    });

    this.cameraController.updateConfiguration({
      deadZoneX: this.config.deadZoneX,
      deadZoneY: this.config.deadZoneY,
      kalmanEnabled: this.config.kalmanEnabled,
      kalmanProcessNoise: this.config.kalmanProcessNoise,
      kalmanMeasurementNoise: this.config.kalmanMeasurementNoise,
      predictionLeadMs: this.config.ptzPredictionLeadMs,

      minPanSpeed: this.config.ptzMinPanSpeed,
      maxPanSpeed: this.config.ptzMaxPanSpeed,
      minTiltSpeed: this.config.ptzMinTiltSpeed,
      maxTiltSpeed: this.config.ptzMaxTiltSpeed,
      panSpeedSlewLimit: this.config.ptzPanSpeedSlewLimit,
      tiltSpeedSlewLimit: this.config.ptzTiltSpeedSlewLimit,
      zoomLockedDuringTracking:
        this.config.ptzZoomLockedDuringTracking,

      fineCentering: {
        enabled: this.config.fineCenteringEnabled,
        enterErrorX: this.config.fineCenteringEnterErrorX,
        enterErrorY: this.config.fineCenteringEnterErrorY,
        stopErrorX: this.config.fineCenteringStopErrorX,
        stopErrorY: this.config.fineCenteringStopErrorY,
        hysteresis: this.config.fineCenteringHysteresis,
        minPanSpeed: this.config.fineCenteringMinPanSpeed,
        maxPanSpeed: this.config.fineCenteringMaxPanSpeed,
        minTiltSpeed: this.config.fineCenteringMinTiltSpeed,
        maxTiltSpeed: this.config.fineCenteringMaxTiltSpeed,
        brakingEnabled:
          this.config.fineCenteringBrakingEnabled,
        panLeadPixels:
          this.config.fineCenteringPanLeadPixels,
        tiltLeadPixels:
          this.config.fineCenteringTiltLeadPixels,
      },

      ptzDebugLogEnabled:
        this.config.ptzDebugLogEnabled,
      ptzDebugLogIntervalMs:
        this.config.ptzDebugLogIntervalMs,
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
      tracking: {
        ...this.config,
        mode: this.mode,
        captureType: this.captureType,
        trackingMode: this.trackingMode,
        adaptiveTrackerBox:
          this.adaptiveTrackerBox.getConfiguration(),
      },
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

    this.motionDetector.updatePipelineDiagnostics({
      rawAccepted: rawDetections.length,
      stableAccepted: stableDetections.length,
      objectsWithId: detections.length,
    });
    this.lastMotionDiagnostics =
      this.motionDetector.getDiagnosticsSnapshot();

    if (this.lastMotionDiagnostics?.inspector) {
      this.lastMotionDiagnostics.inspector.stabilizerTracks =
        this.detectionStabilizer.getDiagnosticsSnapshot();

      this.lastMotionDiagnostics.inspector.objectIds =
        detections.map((item) => ({ ...item }));
    }

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
    tracking.captureDiagnostics = this.captureDiagnostics.update({
      state: 'DETECTION_ONLY',
      targetId: null,
      detections,
      trackedRect: null,
      trackerState: this.objectTracker.getState(),
    });
    return {
      detections,
      tracking,
      trackedRect: null,
      ptzCommand: this.#stopCommand(),
      motionDiagnostics: this.lastMotionDiagnostics,
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
      trackedRect = this.objectTracker.update(frame, detections);
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

    const trackerStateForDiagnostics = this.objectTracker.getState();
    const captureDiagnostics = this.captureDiagnostics.update({
      state,
      targetId: this.activeTargetId,
      detections,
      trackedRect,
      trackerState: trackerStateForDiagnostics,
    });

    if (!this.objectTracker.isActive() && state !== 'TRACKING') {
      this.activeTargetId = null;
    }

    const tracking = this.#trackingState(
      state,
      trackedRect,
      targetCenter,
      this.objectTracker.isActive(),
    );
    tracking.captureDiagnostics = captureDiagnostics;

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
    return {
      detections: visibleDetections,
      tracking,
      trackedRect,
      ptzCommand,
      motionDiagnostics: this.lastMotionDiagnostics,
    };
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

      const trackerTarget = this.adaptiveTrackerBox.prepare(
        target,
        this.width,
        this.height,
      );

      this.objectTracker.start(frame, trackerTarget);
      this.activeTargetId = target.id ?? null;
      this.motionDetector.reset();
      const boxInfo = trackerTarget.adaptiveTrackerBox;

      logger.info(
        `[TRACKING] Ручной захват ID=${this.activeTargetId}; ` +
        `det=${Math.round(target.width)}x${Math.round(target.height)}; ` +
        `tracker=${trackerTarget.width}x${trackerTarget.height}; ` +
        `boxProfile=${boxInfo?.profile ?? 'UNKNOWN'}; ` +
        `boxApplied=${boxInfo?.applied ? 'YES' : 'NO'}; ` +
        `x=${trackerTarget.x}; y=${trackerTarget.y}`,
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
      trackingMode: this.trackingMode,
      targetId: this.activeTargetId,
      mode: this.mode,
      captureType: this.captureType,
      captureRadius: this.config.captureRadius,
    };
  }

  /**
   * Освобождает ресурсы активного трекера, включая диагностическое окно ROI.
   */
  dispose() {
    if (this.objectTracker && typeof this.objectTracker.dispose === 'function') {
      this.objectTracker.dispose();
      return;
    }

    this.objectTracker?.reset?.('Завершение TrackingManager');
  }

  #createObjectTracker(config) {
    const commonOptions = {
      type: config.trackerType ?? 'KCF',
      minWidth: config.trackerMinWidth ?? 8,
      minHeight: config.trackerMinHeight ?? 8,
      maxConsecutiveErrors: config.trackerMaxConsecutiveErrors ?? 3,
      debug: Boolean(config.trackerDebug ?? false),
    };

    if (this.trackingMode === 'LOW_CONTRAST') {
      return new LowContrastObjectTracker({
        ...commonOptions,
        paddingX: config.lowContrastRoiPaddingX ?? 1.0,
        paddingY: config.lowContrastRoiPaddingY ?? 1.2,
        roiMinWidth: config.lowContrastRoiMinWidth ?? 320,
        roiMinHeight: config.lowContrastRoiMinHeight ?? 220,

        warningEdgeRatioX:
          config.lowContrastRoiWarningEdgeRatioX ??
          config.lowContrastRoiRecenterEdgeRatioX ??
          0.15,
        warningEdgeRatioY:
          config.lowContrastRoiWarningEdgeRatioY ??
          config.lowContrastRoiRecenterEdgeRatioY ??
          0.10,
        warningHysteresisRatio:
          config.lowContrastRoiWarningHysteresisRatio ??
          config.lowContrastRoiRecenterHysteresisRatio ??
          0.03,
        warningConfirmFrames:
          config.lowContrastRoiWarningConfirmFrames ?? 3,

        recenterMode:
          config.lowContrastRoiRecenterMode ?? 'TIME_BASED',
        recenterAfterWarningFrames:
          config.lowContrastRoiRecenterAfterWarningFrames ?? 8,
        maxRecenters:
          config.lowContrastRoiMaxRecenters ??
          config.lowContrastRoiMaxRecentersOnLoss ??
          0,

        recenterCooldownFrames:
          config.lowContrastRoiRecenterCooldownFrames ?? 8,

        // Старый параметр используется только как fallback.
        recenterMargin:
          config.lowContrastRoiRecenterMargin,

        claheEnabled: config.lowContrastClaheEnabled ?? true,
        claheClipLimit: config.lowContrastClaheClipLimit ?? 1.7,
        claheTileSize: config.lowContrastClaheTileSize ?? 8,
        gamma: config.lowContrastGamma ?? 1.08,
        sharpen: config.lowContrastSharpen ?? 0.10,
        debugWindowEnabled:
          config.lowContrastDebugWindowEnabled ?? false,
        debugWindowWidth:
          config.lowContrastDebugWindowWidth ?? 640,
        debugWindowHeight:
          config.lowContrastDebugWindowHeight ?? 440,
        debugShowSafeArea:
          config.lowContrastDebugShowSafeArea ?? true,
        debugShowStats:
          config.lowContrastDebugShowStats ?? true,

        scaleHealthEnabled:
          config.trackerScaleHealthEnabled ?? true,
        scaleHealthConfirmFrames:
          config.trackerScaleConfirmFrames ?? 4,
        scaleHealthMaxCenterDistanceRatio:
          config.trackerScaleMaxCenterDistanceRatio ?? 0.35,
        scaleHealthMinIou:
          config.trackerScaleMinIou ?? 0.20,
        scaleHealthMinTrackedCoverage:
          config.trackerScaleMinTrackedCoverage ?? 0.55,
        scaleHealthGrowThresholdRatio:
          config.trackerScaleGrowThresholdRatio ?? 1.35,
        scaleHealthShrinkThresholdRatio:
          config.trackerScaleShrinkThresholdRatio ?? 0.65,
      });
    }

    return new ObjectTracker(commonOptions);
  }

  #normalizeTrackingMode(value) {
    const mode = String(value ?? 'STANDARD').trim().toUpperCase();

    if (!['STANDARD', 'LOW_CONTRAST'].includes(mode)) {
      throw new Error(
        `Неизвестный trackingMode: ${mode}. ` +
        'Допустимые значения: STANDARD, LOW_CONTRAST.',
      );
    }

    return mode;
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
    this.captureDiagnostics.reset();
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
