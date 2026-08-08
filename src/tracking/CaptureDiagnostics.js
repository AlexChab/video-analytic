'use strict';

/**
 * Диагностика цепочки удержания выбранной цели.
 *
 * Класс НИЧЕГО не меняет в Motion/KCF/PTZ. Он только собирает факты:
 * - присутствует ли выбранный Object ID среди текущих детекций;
 * - жив ли KCF;
 * - вернул ли KCF рамку на текущем кадре;
 * - находится ли рамка в безопасной зоне LOW_CONTRAST ROI;
 * - был ли последний recenter эффективным;
 * - почему состояние сопровождения изменилось.
 */
class CaptureDiagnostics {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.historyLength = CaptureDiagnostics.#integer(
      options.historyLength,
      20,
      1,
      300,
    );
    this.reset();
  }

  updateConfiguration(options = {}) {
    if (!options || typeof options !== 'object') return this.getConfiguration();

    if (options.enabled !== undefined) {
      this.enabled = Boolean(options.enabled);
    }
    if (options.historyLength !== undefined) {
      this.historyLength = CaptureDiagnostics.#integer(
        options.historyLength,
        this.historyLength,
        1,
        300,
      );
      this.history = this.history.slice(0, this.historyLength);
    }

    return this.getConfiguration();
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      historyLength: this.historyLength,
    };
  }

  reset() {
    this.frameNumber = 0;
    this.previousState = null;
    this.lastEvent = null;
    this.lastSnapshot = this.#emptySnapshot();
    this.history = [];
  }

  update({
    state,
    targetId,
    detections = [],
    trackedRect = null,
    trackerState = null,
  } = {}) {
    if (!this.enabled) {
      this.lastSnapshot = this.#emptySnapshot();
      return this.getSnapshot();
    }

    this.frameNumber += 1;

    const normalizedState = String(state ?? 'UNKNOWN');
    const targetPresent =
      targetId != null &&
      Array.isArray(detections) &&
      detections.some((item) => item?.id === targetId);

    const trackerActive = Boolean(
      trackerState?.active ?? trackerState?.localTracker?.active,
    );
    const trackerRectPresent = Boolean(trackedRect);

    const roi = trackerState?.roi ?? null;
    const safe = roi?.safeArea ?? null;
    const lastRecenter = trackerState?.lastRecenter ?? null;

    const attention = this.#resolveAttention({
      normalizedState,
      targetId,
      targetPresent,
      trackerActive,
      trackerRectPresent,
      trackerState,
      safe,
      lastRecenter,
    });

    if (
      this.previousState &&
      this.previousState !== normalizedState
    ) {
      this.lastEvent = {
        frame: this.frameNumber,
        from: this.previousState,
        to: normalizedState,
        reason: attention.reason,
      };
    }

    this.previousState = normalizedState;

    const snapshot = {
      enabled: true,
      frame: this.frameNumber,
      state: normalizedState,
      targetId: targetId ?? null,
      targetPresent,
      trackerActive,
      trackerRectPresent,
      trackerLastStopReason: this.#normalizeReason(
        trackerState?.lastStopReason ??
        trackerState?.localTracker?.lastStopReason ??
        null,
      ),
      roi: roi
        ? {
          warning: Boolean(roi.warning),
          warningSide: roi.warningSide ?? null,
          warningFrames: Number(roi.warningFrames ?? 0),
          recenterAfterWarningFrames:
            Number(roi.recenterAfterWarningFrames ?? 0),
          recenterCount: Number(roi.recenterCount ?? 0),
          maxRecenters: Number(roi.maxRecenters ?? 0),
          cooldownRemaining: Number(roi.cooldownRemaining ?? 0),
          safeArea: safe ? { ...safe } : null,
        }
        : null,
      lastRecenter: lastRecenter ? { ...lastRecenter } : null,
      attention,
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
    };

    this.lastSnapshot = snapshot;
    this.history.unshift({
      frame: snapshot.frame,
      state: snapshot.state,
      targetPresent: snapshot.targetPresent,
      trackerActive: snapshot.trackerActive,
      trackerRectPresent: snapshot.trackerRectPresent,
      warning: snapshot.roi?.warning ?? false,
      safeOverflowPx: snapshot.roi?.safeArea?.maxOverflowPx ?? 0,
      reason: snapshot.attention.reason,
    });

    if (this.history.length > this.historyLength) {
      this.history.length = this.historyLength;
    }

    return this.getSnapshot();
  }

  getSnapshot() {
    return {
      ...this.lastSnapshot,
      history: this.history.map((item) => ({ ...item })),
    };
  }

  #resolveAttention({
    normalizedState,
    targetId,
    targetPresent,
    trackerActive,
    trackerRectPresent,
    trackerState,
    safe,
    lastRecenter,
  }) {
    if (!trackerActive && targetId != null) {
      return {
        level: 'ERROR',
        reason: this.#normalizeReason(
          trackerState?.lastStopReason ??
          trackerState?.localTracker?.lastStopReason ??
          'TRACKER_INACTIVE',
        ),
      };
    }

    if (normalizedState === 'TEMPORARILY_LOST' || (trackerActive && !trackerRectPresent)) {
      return {
        level: 'ERROR',
        reason: 'KCF_UPDATE_NO_RECT',
      };
    }

    if (
      lastRecenter?.effective === false &&
      Number(lastRecenter.afterOverflowPx ?? 0) > 0
    ) {
      return {
        level: 'WARN',
        reason: 'RECENTER_INEFFECTIVE',
      };
    }

    if (safe?.outsideSafeArea) {
      return {
        level: 'WARN',
        reason: `ROI_SAFE_AREA_${safe.side ?? 'EDGE'}`,
      };
    }

    if (targetId != null && !targetPresent) {
      return {
        level: 'INFO',
        reason: 'TARGET_ID_NOT_VISIBLE_BUT_KCF_ALIVE',
      };
    }

    if (normalizedState === 'TRACKING') {
      return {
        level: 'OK',
        reason: 'TRACKING_OK',
      };
    }

    return {
      level: 'INFO',
      reason: normalizedState,
    };
  }

  /**
   * OpenCV putText() не умеет нормально отображать Unicode.
   * Внутренний tracker пока может хранить старые русские stop-reason строки,
   * поэтому для технического HUD переводим их в стабильные ASCII codes.
   */
  #normalizeReason(reason) {
    if (reason == null) return null;

    const text = String(reason);
    const upper = text.toUpperCase();

    if (upper.includes('ENHANCED ROI')) {
      return 'KCF_LOST_IN_ENHANCED_ROI';
    }
    if (
      upper.includes('UPDATE') ||
      upper.includes('ОБНОВ')
    ) {
      return 'KCF_UPDATE_FAILED';
    }
    if (
      upper.includes('ROI') &&
      (upper.includes('ПОТЕР') || upper.includes('LOST'))
    ) {
      return 'KCF_LOST_IN_ROI';
    }
    if (
      upper.includes('СБРОС') ||
      upper.includes('RESET')
    ) {
      return 'TRACKER_RESET';
    }
    if (
      upper.includes('РУЧ') ||
      upper.includes('MANUAL')
    ) {
      return 'MANUAL_STOP';
    }
    if (
      upper.includes('ПОТЕР') ||
      upper.includes('LOST')
    ) {
      return 'KCF_LOST';
    }

    /*
     * ASCII строки уже безопасны для HUD. Любую Unicode-строку, которую пока
     * не классифицировали, не выводим как ??????, а заменяем общим кодом.
     */
    return /^[\x20-\x7E]+$/.test(text)
      ? text
      : 'TRACKER_STOP';
  }

  #emptySnapshot() {
    return {
      enabled: this.enabled,
      frame: 0,
      state: 'NO_DATA',
      targetId: null,
      targetPresent: false,
      trackerActive: false,
      trackerRectPresent: false,
      trackerLastStopReason: null,
      roi: null,
      lastRecenter: null,
      attention: {
        level: 'INFO',
        reason: 'NO_DATA',
      },
      lastEvent: null,
    };
  }

  static #integer(value, fallback, min, max) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}

module.exports = CaptureDiagnostics;
