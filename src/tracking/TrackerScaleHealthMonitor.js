'use strict';

/**
 * Диагностирует расхождение масштаба между зелёной рамкой KCF и ближайшей
 * устойчивой красной рамкой MotionDetector.
 *
 * В версии v1 монитор ничего не исправляет и не переинициализирует KCF.
 */
class TrackerScaleHealthMonitor {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.confirmFrames = TrackerScaleHealthMonitor.#integer(
      options.confirmFrames,
      4,
      1,
      120,
    );
    this.maxCenterDistanceRatio = TrackerScaleHealthMonitor.#number(
      options.maxCenterDistanceRatio,
      0.35,
      0.01,
      3,
    );
    this.minIou = TrackerScaleHealthMonitor.#number(
      options.minIou,
      0.20,
      0,
      1,
    );
    this.minTrackedCoverage = TrackerScaleHealthMonitor.#number(
      options.minTrackedCoverage,
      0.55,
      0,
      1,
    );
    this.growThresholdRatio = TrackerScaleHealthMonitor.#number(
      options.growThresholdRatio,
      1.35,
      1.01,
      10,
    );
    this.shrinkThresholdRatio = TrackerScaleHealthMonitor.#number(
      options.shrinkThresholdRatio,
      0.65,
      0.01,
      0.99,
    );
    this.reset();
  }

  reset() {
    this.state = 'NO_DATA';
    this.matchFrames = 0;
    this.missFrames = 0;
    this.candidate = null;
    this.areaRatio = null;
    this.widthRatio = null;
    this.heightRatio = null;
    this.iou = null;
    this.trackedCoverage = null;
    this.centerDistanceRatio = null;
  }

  update(trackedRect, detections = []) {
    if (!this.enabled || !trackedRect) {
      this.reset();
      return this.getState();
    }

    const candidates = Array.isArray(detections) ? detections : [];
    const best = this.#findBestMatch(trackedRect, candidates);

    if (!best) {
      this.matchFrames = 0;
      this.missFrames += 1;
      this.candidate = null;
      this.state = 'NO_MATCH';
      this.areaRatio = null;
      this.widthRatio = null;
      this.heightRatio = null;
      this.iou = null;
      this.trackedCoverage = null;
      this.centerDistanceRatio = null;
      return this.getState();
    }

    this.missFrames = 0;
    this.matchFrames += 1;
    this.candidate = { ...best.detection };
    this.areaRatio = best.areaRatio;
    this.widthRatio = best.widthRatio;
    this.heightRatio = best.heightRatio;
    this.iou = best.iou;
    this.trackedCoverage = best.trackedCoverage;
    this.centerDistanceRatio = best.centerDistanceRatio;

    if (this.matchFrames < this.confirmFrames) {
      this.state = 'CONFIRMING';
    } else if (this.areaRatio >= this.growThresholdRatio) {
      this.state = 'GROWING';
    } else if (this.areaRatio <= this.shrinkThresholdRatio) {
      this.state = 'SHRINKING';
    } else {
      this.state = 'STABLE';
    }

    return this.getState();
  }

  getState() {
    return {
      enabled: this.enabled,
      state: this.state,
      matchFrames: this.matchFrames,
      confirmFrames: this.confirmFrames,
      missFrames: this.missFrames,
      candidate: this.candidate ? { ...this.candidate } : null,
      areaRatio: TrackerScaleHealthMonitor.#rounded(this.areaRatio),
      widthRatio: TrackerScaleHealthMonitor.#rounded(this.widthRatio),
      heightRatio: TrackerScaleHealthMonitor.#rounded(this.heightRatio),
      iou: TrackerScaleHealthMonitor.#rounded(this.iou),
      trackedCoverage:
        TrackerScaleHealthMonitor.#rounded(this.trackedCoverage),
      centerDistanceRatio:
        TrackerScaleHealthMonitor.#rounded(this.centerDistanceRatio),
      autoCorrect: false,
    };
  }

  #findBestMatch(trackedRect, detections) {
    let best = null;

    for (const detection of detections) {
      if (!TrackerScaleHealthMonitor.#validRect(detection)) continue;

      const metrics = this.#metrics(trackedRect, detection);

      const geometricallyCompatible =
        metrics.centerDistanceRatio <= this.maxCenterDistanceRatio &&
        (
          metrics.iou >= this.minIou ||
          metrics.trackedCoverage >= this.minTrackedCoverage
        );

      if (!geometricallyCompatible) continue;

      /*
       * Приоритет: объект должен покрывать KCF и иметь близкий центр.
       * IoU используется дополнительно, но не доминирует: при приближении
       * реальная рамка может стать значительно больше зелёной.
       */
      const score =
        metrics.trackedCoverage * 2 +
        metrics.iou -
        metrics.centerDistanceRatio;

      if (!best || score > best.score) {
        best = {
          score,
          detection,
          ...metrics,
        };
      }
    }

    return best;
  }

  #metrics(trackedRect, detection) {
    const intersection = TrackerScaleHealthMonitor.#intersection(
      trackedRect,
      detection,
    );

    const trackedArea = Math.max(
      1,
      Number(trackedRect.width) * Number(trackedRect.height),
    );
    const detectionArea = Math.max(
      1,
      Number(detection.width) * Number(detection.height),
    );
    const unionArea = trackedArea + detectionArea - intersection.area;

    const trackedCenter = TrackerScaleHealthMonitor.#center(trackedRect);
    const detectionCenter = TrackerScaleHealthMonitor.#center(detection);
    const centerDistance = Math.hypot(
      trackedCenter.x - detectionCenter.x,
      trackedCenter.y - detectionCenter.y,
    );
    const trackedDiagonal = Math.max(
      1,
      Math.hypot(Number(trackedRect.width), Number(trackedRect.height)),
    );

    return {
      areaRatio: detectionArea / trackedArea,
      widthRatio:
        Number(detection.width) / Math.max(1, Number(trackedRect.width)),
      heightRatio:
        Number(detection.height) / Math.max(1, Number(trackedRect.height)),
      iou: intersection.area / Math.max(1, unionArea),
      trackedCoverage: intersection.area / trackedArea,
      centerDistanceRatio: centerDistance / trackedDiagonal,
    };
  }

  static #intersection(first, second) {
    const left = Math.max(Number(first.x), Number(second.x));
    const top = Math.max(Number(first.y), Number(second.y));
    const right = Math.min(
      Number(first.x) + Number(first.width),
      Number(second.x) + Number(second.width),
    );
    const bottom = Math.min(
      Number(first.y) + Number(first.height),
      Number(second.y) + Number(second.height),
    );

    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    return {
      width,
      height,
      area: width * height,
    };
  }

  static #center(rect) {
    return {
      x: Number(rect.x) + Number(rect.width) / 2,
      y: Number(rect.y) + Number(rect.height) / 2,
    };
  }

  static #validRect(rect) {
    return Boolean(
      rect &&
      Number.isFinite(Number(rect.x)) &&
      Number.isFinite(Number(rect.y)) &&
      Number.isFinite(Number(rect.width)) &&
      Number.isFinite(Number(rect.height)) &&
      Number(rect.width) > 0 &&
      Number(rect.height) > 0
    );
  }

  static #rounded(value) {
    return Number.isFinite(value)
      ? Number(value.toFixed(3))
      : null;
  }

  static #number(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  static #integer(value, fallback, min, max) {
    return Math.round(
      TrackerScaleHealthMonitor.#number(value, fallback, min, max),
    );
  }
}

module.exports = TrackerScaleHealthMonitor;
