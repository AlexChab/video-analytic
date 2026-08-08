'use strict';

const logger = require('../utils/Logger');

/**
 * Диагностика конвейера MotionDetector.
 *
 * Модуль ничего не меняет в детекции. Он только считает, на каком этапе
 * кандидаты были отброшены, и хранит краткий снимок для HUD/API/логов.
 */
class MotionDiagnostics {
  constructor(options = {}) {
    this.lastLogAt = 0;
    this.reset();
    this.updateConfiguration(options);
  }

  updateConfiguration(options = {}) {
    const config = options && typeof options === 'object'
      ? options
      : {};

    this.enabled = config.enabled !== false;
    this.hudEnabled = config.hudEnabled !== false;
    this.logEnabled = Boolean(config.logEnabled ?? false);
    this.logIntervalMs = Math.max(
      100,
      Number(config.logIntervalMs) || 1000,
    );
    this.keepLastRejects = Math.max(
      0,
      Math.min(20, Math.trunc(Number(config.keepLastRejects) || 5)),
    );

    const inspector = config.inspector && typeof config.inspector === 'object'
      ? config.inspector
      : {};

    this.inspectorEnabled = inspector.enabled !== false;
    this.maxInspectorBoxes = Math.max(
      1,
      Math.min(200, Math.trunc(Number(inspector.maxBoxesPerStage) || 50)),
    );

    return this.getConfiguration();
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      hudEnabled: this.hudEnabled,
      logEnabled: this.logEnabled,
      logIntervalMs: this.logIntervalMs,
      keepLastRejects: this.keepLastRejects,
      inspector: {
        enabled: this.inspectorEnabled,
        maxBoxesPerStage: this.maxInspectorBoxes,
      },
    };
  }

  reset() {
    this.frame = this.#emptyFrame();
    this.window = this.#emptyWindow();
    this.lastRejects = [];
    this.inspectorFrame = this.#emptyInspectorFrame();
    this.thresholds = {};
    this.pipeline = {
      rawAccepted: 0,
      stableAccepted: 0,
      objectsWithId: 0,
    };
  }

  /** Начинает сбор статистики для нового обработанного кадра. */
  beginFrame(contours = 0) {
    if (!this.enabled) return;

    this.frame = this.#emptyFrame();
    this.inspectorFrame = this.#emptyInspectorFrame();
    this.frame.contours = Math.max(0, Number(contours) || 0);
    this.window.frames += 1;
    this.window.contours += this.frame.contours;
  }

  reject(reason, details = {}) {
    if (!this.enabled) return;

    const key = MotionDiagnostics.#normalizeReason(reason);
    this.frame.rejected[key] += 1;
    this.window.rejected[key] += 1;

    if (this.keepLastRejects <= 0) return;

    const item = {
      reason: key,
      x: Number(details.x ?? 0),
      y: Number(details.y ?? 0),
      width: Number(details.width ?? 0),
      height: Number(details.height ?? 0),
      area: Number(details.area ?? 0),
      contourArea: Number(details.contourArea ?? 0),
      aspectRatio: Number(details.aspectRatio ?? 0),
      stage: String(details.stage ?? 'PRE_MERGE'),
      at: Date.now(),
    };

    if (
      this.inspectorEnabled &&
      item.width > 0 &&
      item.height > 0 &&
      this.inspectorFrame.rejects.length < this.maxInspectorBoxes
    ) {
      this.inspectorFrame.rejects.push({ ...item });
    }

    this.lastRejects.unshift(item);
    if (this.lastRejects.length > this.keepLastRejects) {
      this.lastRejects.length = this.keepLastRejects;
    }
  }

  /**
   * Пороговые значения сохраняются отдельно от счётчиков кадра.
   * Inspector показывает рядом "факт / порог / PASS|FAIL".
   */
  setThresholds(thresholds = {}) {
    if (!this.enabled) return;
    this.thresholds = {
      ...this.thresholds,
      ...(thresholds && typeof thresholds === 'object'
        ? thresholds
        : {}),
    };
  }

  setPreMergeBoxes(boxes = []) {
    if (!this.enabled || !this.inspectorEnabled) return;
    this.inspectorFrame.preMerge = this.#copyBoxes(boxes);
  }

  setPostMergeBoxes(boxes = []) {
    if (!this.enabled || !this.inspectorEnabled) return;
    this.inspectorFrame.postMerge = this.#copyBoxes(boxes);
  }

  setFinalBoxes(boxes = []) {
    if (!this.enabled || !this.inspectorEnabled) return;
    this.inspectorFrame.finalAccepted = this.#copyBoxes(boxes);
  }

  setPreMergeAccepted(count) {
    if (!this.enabled) return;
    this.frame.preMergeAccepted = Math.max(0, Number(count) || 0);
    this.window.preMergeAccepted += this.frame.preMergeAccepted;
  }

  setPostMergeCount(count) {
    if (!this.enabled) return;
    this.frame.postMerge = Math.max(0, Number(count) || 0);
    this.window.postMerge += this.frame.postMerge;
  }

  setFinalAccepted(count) {
    if (!this.enabled) return;
    this.frame.finalAccepted = Math.max(0, Number(count) || 0);
    this.window.finalAccepted += this.frame.finalAccepted;
    this.#maybeLog();
  }

  /** Дополняет снимок результатом Stabilizer и ObjectIdManager. */
  setPipelineCounts({ rawAccepted, stableAccepted, objectsWithId } = {}) {
    if (!this.enabled) return;

    this.pipeline = {
      rawAccepted: Math.max(0, Number(rawAccepted) || 0),
      stableAccepted: Math.max(0, Number(stableAccepted) || 0),
      objectsWithId: Math.max(0, Number(objectsWithId) || 0),
    };
  }

  getSnapshot() {
    return {
      enabled: this.enabled,
      hudEnabled: this.hudEnabled,
      frame: {
        ...this.frame,
        rejected: { ...this.frame.rejected },
      },
      pipeline: { ...this.pipeline },
      thresholds: { ...this.thresholds },
      lastReject: this.lastRejects[0]
        ? { ...this.lastRejects[0] }
        : null,
      lastRejects: this.lastRejects.map((item) => ({ ...item })),
      inspector: {
        enabled: this.inspectorEnabled,
        maxBoxesPerStage: this.maxInspectorBoxes,
        rejects: this.inspectorFrame.rejects.map((item) => ({ ...item })),
        preMerge: this.inspectorFrame.preMerge.map((item) => ({ ...item })),
        postMerge: this.inspectorFrame.postMerge.map((item) => ({ ...item })),
        finalAccepted: this.inspectorFrame.finalAccepted.map((item) => ({ ...item })),
      },
    };
  }

  #maybeLog() {
    if (!this.logEnabled) return;

    const now = Date.now();
    if (now - this.lastLogAt < this.logIntervalMs) return;

    const r = this.window.rejected;

    logger.info(
      '[MOTION] DIAG: ' +
      `frames=${this.window.frames}; ` +
      `contours=${this.window.contours}; ` +
      `reject=contourArea:${r.CONTOUR_AREA},` +
      `boxArea:${r.BOX_AREA},width:${r.WIDTH},height:${r.HEIGHT},` +
      `aspect:${r.ASPECT},maxArea:${r.MAX_AREA}; ` +
      `preMerge=${this.window.preMergeAccepted}; ` +
      `postMerge=${this.window.postMerge}; ` +
      `accepted=${this.window.finalAccepted}`,
    );

    this.lastLogAt = now;
    this.window = this.#emptyWindow();
  }

  #copyBoxes(boxes) {
    if (!Array.isArray(boxes)) return [];

    return boxes
      .slice(0, this.maxInspectorBoxes)
      .map((box) => ({
        x: Number(box.x ?? 0),
        y: Number(box.y ?? 0),
        width: Number(box.width ?? 0),
        height: Number(box.height ?? 0),
        area: Number(box.area ?? (Number(box.width ?? 0) * Number(box.height ?? 0))),
      }));
  }

  #emptyInspectorFrame() {
    return {
      rejects: [],
      preMerge: [],
      postMerge: [],
      finalAccepted: [],
    };
  }

  #emptyFrame() {
    return {
      contours: 0,
      preMergeAccepted: 0,
      postMerge: 0,
      finalAccepted: 0,
      rejected: MotionDiagnostics.#emptyReasons(),
    };
  }

  #emptyWindow() {
    return {
      frames: 0,
      contours: 0,
      preMergeAccepted: 0,
      postMerge: 0,
      finalAccepted: 0,
      rejected: MotionDiagnostics.#emptyReasons(),
    };
  }

  static #emptyReasons() {
    return {
      CONTOUR_AREA: 0,
      BOX_AREA: 0,
      WIDTH: 0,
      HEIGHT: 0,
      ASPECT: 0,
      MAX_AREA: 0,
    };
  }

  static #normalizeReason(reason) {
    const normalized = String(reason || '').trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(
      MotionDiagnostics.#emptyReasons(),
      normalized,
    )
      ? normalized
      : 'BOX_AREA';
  }
}

module.exports = MotionDiagnostics;
