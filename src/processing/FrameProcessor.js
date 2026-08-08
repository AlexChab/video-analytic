'use strict';


const logger = require('../utils/Logger');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const cv = require('@u4/opencv4nodejs');
const TrackingManager = require('../tracking/TrackingManager');
const FrameRenderer = require('../rendering/FrameRenderer');
const RoiTrackingDiagnostics = require('../tracking/RoiTrackingDiagnostics');
const ObservationEnhancer = require('./ObservationEnhancer');
const MotionInspector = require('../detection/MotionInspector');


/** Объединяет плоские секции конфигурации, не изменяя исходные объекты. */
function mergeConfiguration(base, override) {
  return {
    ...(base && typeof base === 'object' ? base : {}),
    ...(override && typeof override === 'object' ? override : {}),
  };
}

/**
 * Преобразует Buffer в cv.Mat, запускает TrackingManager и Renderer,
 * затем возвращает обработанный кадр обратно в виде Buffer.
 */
class FrameProcessor {
  constructor({
    width,
    height,
    trackingConfig,
    profileManager,
    manualControl = null,
    cameraCommandDispatcher = null,
    cameraControlConfig = {},
    observationConfig = {},
  }) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error('Ширина кадра должна быть положительным целым числом');
    }
    if (!Number.isInteger(height) || height <= 0) {
      throw new Error('Высота кадра должна быть положительным целым числом');
    }
    if (!trackingConfig || typeof trackingConfig !== 'object') {
      throw new Error('FrameProcessor требует trackingConfig');
    }
    if (!profileManager || typeof profileManager.getMotionConfig !== 'function') {
      throw new Error('FrameProcessor требует инициализированный ProfileManager');
    }

    this.width = width;
    this.height = height;
    this.channels = 3;
    this.frameSize = width * height * this.channels;
    this.profileManager = profileManager;
    this.baseTrackingConfig = { ...trackingConfig };

    const initialTrackingConfig = mergeConfiguration(
      this.baseTrackingConfig,
      profileManager.getTrackingConfig(),
    );
    const initialRendererConfig = this.#buildRendererConfiguration(
      initialTrackingConfig,
      profileManager.getRendererConfig(),
    );

    this.trackingConfig = initialTrackingConfig;
    this.trackingManager = new TrackingManager({
      width,
      height,
      config: initialTrackingConfig,
      motionConfig: profileManager.getMotionConfig(),
      manualControl,
      cameraCommandDispatcher,
      cameraControlConfig,
    });

    this.renderer = new FrameRenderer({
      frameWidth: width,
      frameHeight: height,
      ...initialRendererConfig,
    });

    const initialMotionConfig = profileManager.getMotionConfig();
    this.motionInspector = new MotionInspector(
      initialMotionConfig?.diagnostics?.inspector ?? {},
    );

    /**
     * Отдельная ветка визуального улучшения для оператора.
     * Она получает исходный кадр только после завершения аналитики.
     */
    this.observationEnhancer = new ObservationEnhancer(observationConfig);

    /**
     * Независимый диагностический контур ROI.
     * По умолчанию выключен и не изменяет поведение рабочего KCF.
     */
    this.roiDiagnostics = new RoiTrackingDiagnostics({
      enabled: process.env.TRACKING_ROI_DIAGNOSTICS_ENABLED === '1',
      showWindows: process.env.TRACKING_ROI_SHOW_WINDOWS === '1',
      intervalMs: Number(process.env.TRACKING_ROI_INTERVAL_MS ?? 250),
      paddingX: Number(process.env.TRACKING_ROI_PADDING_X ?? 0.60),
      paddingY: Number(process.env.TRACKING_ROI_PADDING_Y ?? 0.80),
      minWidth: Number(process.env.TRACKING_ROI_MIN_WIDTH ?? 240),
      minHeight: Number(process.env.TRACKING_ROI_MIN_HEIGHT ?? 160),
      claheEnabled: process.env.TRACKING_ROI_CLAHE_ENABLED !== '0',
      claheClipLimit: Number(
        process.env.TRACKING_ROI_CLAHE_CLIP_LIMIT ?? 2.0,
      ),
      claheTileSize: Number(
        process.env.TRACKING_ROI_CLAHE_TILE_SIZE ?? 8,
      ),
      gamma: Number(process.env.TRACKING_ROI_GAMMA ?? 1.10),
      sharpen: Number(process.env.TRACKING_ROI_SHARPEN ?? 0.20),
      upscale: Number(process.env.TRACKING_ROI_UPSCALE ?? 2),
    });

    /**
     * Один подписчик централизованно раздаёт новые секции всем компонентам.
     * Сохраняем ссылку на функцию, чтобы её можно было снять в dispose().
     */
    this.configurationChangedHandler = (effectiveConfig = {}) => {
      this.updateConfiguration(effectiveConfig);
    };
    this.profileManager.on(
      'configuration-changed',
      this.configurationChangedHandler,
    );

    this.performanceStats = {};
  }

  /**
   * Применяет полное дерево effectiveConfig, полученное от ProfileManager.
   * Неуказанные tracking-параметры дополняются legacy tracking.config.js.
   */
  updateConfiguration(effectiveConfig = {}) {
    if (!effectiveConfig || typeof effectiveConfig !== 'object') {
      throw new TypeError('FrameProcessor.updateConfiguration ожидает объект');
    }

    const trackingConfig = mergeConfiguration(
      this.baseTrackingConfig,
      effectiveConfig.tracking,
    );
    const rendererConfig = this.#buildRendererConfiguration(
      trackingConfig,
      effectiveConfig.renderer ?? effectiveConfig.render,
    );

    this.trackingConfig = trackingConfig;
    this.trackingManager.updateConfiguration({
      tracking: trackingConfig,
      motion: effectiveConfig.motion ?? this.profileManager.getMotionConfig(),
    });
    this.renderer.updateConfiguration(rendererConfig);
    this.motionInspector.updateConfiguration(
      (effectiveConfig.motion ?? this.profileManager.getMotionConfig())
        ?.diagnostics?.inspector ?? {},
    );

    logger.info('[FrameProcessor] ✓ Runtime-конфигурация применена');

    return {
      tracking: this.trackingManager.getConfiguration(),
      renderer: this.renderer.getConfiguration(),
    };
  }

  /**
   * Снимает подписку с ProfileManager при штатном завершении или в тестах.
   */
  /**
   * Передаёт клавиатурное событие инженерным инструментам.
   * Возвращает true, если событие обработано.
   */
  handleKey(keyCode) {
    const key = Number(keyCode);

    /*
     * OpenCV waitKeyEx() на Windows возвращает F1 как VK_F1 << 16:
     *   0x70 << 16 = 0x00700000 = 7340032.
     *
     * Qt HighGUI может вернуть Qt::Key_F1 = 0x01000030.
     * Поддерживаем оба варианта, чтобы hotkey не зависел от backend.
     */
    const isF1 =
      key === 0x00700000 ||
      key === 0x01000030;

    if (isF1) {
      const visible = this.renderer.toggleDebugHud();
      logger.info(
        `[HUD] Technical HUD: ${visible ? 'ON' : 'OFF'} (F1)`,
      );
      return true;
    }

    return Boolean(this.motionInspector?.handleKey?.(keyCode));
  }

  dispose() {
    this.roiDiagnostics?.dispose();
    this.motionInspector?.dispose();
    this.trackingManager?.dispose?.();

    if (this.configurationChangedHandler) {
      this.profileManager.off(
        'configuration-changed',
        this.configurationChangedHandler,
      );
      this.configurationChangedHandler = null;
    }
  }

  process(frameBuffer, metadata = {}) {
    this.validateFrame(frameBuffer);
    const totalStartedAt = performance.now();
    // Хэш кадра для отладки. SHA1 занимает 20 байт, но мы обрезаем до 12 символов.

    // const frameHash = crypto
    //   .createHash('sha1')
    //   .update(frameBuffer)
    //   .digest('hex')
    //   .slice(0, 12);

    // logger.info(`[Кадр ${metadata.number ?? '?'}] SHA1=${frameHash}`);

    const frame = new cv.Mat(frameBuffer, this.height, this.width, cv.CV_8UC3);
    // const p = frame.atRaw(100, 100);

    // logger.info(metadata.number, p[0], p[1], p[2]);

    const trackingResult = this.trackingManager.process(frame);

    let startedAt = performance.now();
    this.motionInspector.process(
      frame,
      trackingResult.motionDiagnostics,
      trackingResult.detections,
    );
    this.#record('motionInspector', performance.now() - startedAt);

    /**
     * Диагностика получает исходный кадр до отрисовки служебных рамок.
     * Она создаёт копию только небольшого ROI и никак не меняет frame.
     */
    startedAt = performance.now();
    this.roiDiagnostics.process(frame, trackingResult.trackedRect);
    this.#record('roiDiagnostics', performance.now() - startedAt);

    /*
     * Создаём отдельный кадр наблюдения только после завершения всей аналитики.
     * MotionDetector, KCF и PTZ уже использовали исходный `frame`.
     */
    startedAt = performance.now();
    const displayFrame = this.observationEnhancer.process(frame);
    this.#record(
      'observationEnhancement',
      performance.now() - startedAt,
    );

    startedAt = performance.now();
    this.renderer.render({
      frame: displayFrame,
      detections: trackingResult.detections,
      selection: trackingResult.tracking,
      trackedRect: trackingResult.trackedRect,
      ptzCommand: trackingResult.ptzCommand,
      motionDiagnostics: trackingResult.motionDiagnostics,
      metadata,
    });
    this.#record('renderer', performance.now() - startedAt);

    startedAt = performance.now();
    const processedFrameBuffer = Buffer.from(displayFrame.getData());
    this.#record('frameBufferCopy', performance.now() - startedAt);
    this.#record('total', performance.now() - totalStartedAt);

    return {
      frame: displayFrame,
      sourceFrame: frame,
      frameBuffer: processedFrameBuffer,
      observation: this.observationEnhancer.getStatus(),
      ...trackingResult,
    };
  }

  validateFrame(frameBuffer) {
    if (!Buffer.isBuffer(frameBuffer))
      throw new TypeError('FrameProcessor ожидает Buffer');
    if (frameBuffer.length !== this.frameSize) {
      throw new Error(
        `Неверный размер кадра: ${frameBuffer.length}. Ожидалось: ${this.frameSize}`,
      );
    }
  }

  reset() {
    this.trackingManager.reset();
  }

  /** Возвращает общий экземпляр для Observation API. */
  getObservationEnhancer() {
    return this.observationEnhancer;
  }

  getPerformanceStats() {
    const result = {
      ...this.#consumeStats(),
      ...this.trackingManager.getPerformanceStats(),
    };
    for (const metric of Object.values(result)) {
      metric.averageMs = metric.calls > 0 ? metric.totalMs / metric.calls : 0;
    }
    return result;
  }

  /** Собирает renderer-секцию из tracking.config и профиля. */
  #buildRendererConfiguration(trackingConfig, rendererOverrides = {}) {
    const legacyRendererConfig = {
      captureRadius: trackingConfig.captureRadius,
      deadZoneX: trackingConfig.deadZoneX,
      deadZoneY: trackingConfig.deadZoneY,
      showCenterCross: trackingConfig.showCenterCross,
      showCaptureZone: trackingConfig.showCaptureZone,
      showDeadZone: trackingConfig.showDeadZone,
      showObjectIds: trackingConfig.showObjectIds,
      captureDiagnosticsHudEnabled:
        trackingConfig.captureDiagnosticsHudEnabled,
    };

    return mergeConfiguration(legacyRendererConfig, rendererOverrides);
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

  #consumeStats() {
    const result = this.performanceStats;
    this.performanceStats = {};
    return result;
  }
}

module.exports = FrameProcessor;
