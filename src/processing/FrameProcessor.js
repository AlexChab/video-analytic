'use strict';


const logger = require('../utils/Logger');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const cv = require('@u4/opencv4nodejs');
const TrackingManager = require('../tracking/TrackingManager');
const FrameRenderer = require('../rendering/FrameRenderer');


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
    });

    this.renderer = new FrameRenderer({
      frameWidth: width,
      frameHeight: height,
      ...initialRendererConfig,
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

    logger.info('[FrameProcessor] ✓ Runtime-конфигурация применена');

    return {
      tracking: this.trackingManager.getConfiguration(),
      renderer: this.renderer.getConfiguration(),
    };
  }

  /**
   * Снимает подписку с ProfileManager при штатном завершении или в тестах.
   */
  dispose() {
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
    this.renderer.render({
      frame,
      detections: trackingResult.detections,
      selection: trackingResult.tracking,
      trackedRect: trackingResult.trackedRect,
      ptzCommand: trackingResult.ptzCommand,
      metadata,
    });
    this.#record('renderer', performance.now() - startedAt);

    startedAt = performance.now();
    const processedFrameBuffer = Buffer.from(frame.getData());
    this.#record('frameBufferCopy', performance.now() - startedAt);
    this.#record('total', performance.now() - totalStartedAt);

    return {
      frame,
      frameBuffer: processedFrameBuffer,
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
