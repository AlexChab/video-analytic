'use strict';

const cv = require('@u4/opencv4nodejs');
const TrackingRoiExtractor = require('./TrackingRoiExtractor');

/**
 * Управляет фиксированным ROI режима LOW_CONTRAST.
 *
 * Важная логика:
 *
 * 1. При приближении зелёной рамки к краю ROI включается WARNING.
 * 2. В режиме TIME_BASED устойчивый WARNING сам запускает recenter.
 * 3. В режиме LOSS_BASED сохраняется прежнее поведение: recenter только
 *    после временной ошибки KCF.
 *
 * TIME_BASED нужен для плавного движения камеры: ROI успевает перестроиться
 * до того, как цель фактически выйдет из рабочей области KCF.
 */
class TrackingRoiSession {
  constructor(options = {}) {
    this.extractor = new TrackingRoiExtractor(options);

    this.warningEdgeRatioX = TrackingRoiSession.#number(
      options.warningEdgeRatioX ??
        options.recenterEdgeRatioX ??
        options.recenterMargin,
      0.15,
      0.01,
      0.45,
    );

    this.warningEdgeRatioY = TrackingRoiSession.#number(
      options.warningEdgeRatioY ??
        options.recenterEdgeRatioY ??
        options.recenterMargin,
      0.10,
      0.01,
      0.45,
    );

    this.warningHysteresisRatio = TrackingRoiSession.#number(
      options.warningHysteresisRatio ??
        options.recenterHysteresisRatio,
      0.03,
      0,
      0.20,
    );

    /**
     * Сколько последовательных кадров рамка должна находиться в зоне края,
     * прежде чем WARNING считается подтверждённым.
     */
    this.warningConfirmFrames = Math.max(
      1,
      Math.round(Number(options.warningConfirmFrames ?? 3)),
    );

    /**
     * Режим переноса ROI:
     * - TIME_BASED: после устойчивого WARNING;
     * - LOSS_BASED: только после временной ошибки KCF.
     */
    this.recenterMode = TrackingRoiSession.#normalizeRecenterMode(
      options.recenterMode ?? 'TIME_BASED',
    );

    /**
     * Сколько кадров WARNING должно накопиться до переноса в TIME_BASED.
     * Значение не может быть меньше warningConfirmFrames.
     */
    this.recenterAfterWarningFrames = Math.max(
      this.warningConfirmFrames,
      Math.round(Number(options.recenterAfterWarningFrames ?? 8)),
    );

    /**
     * Максимальное число recenter в одной tracking-сессии.
     * Ноль означает отсутствие лимита.
     */
    this.maxRecenters = Math.max(
      0,
      Math.round(Number(
        options.maxRecenters ??
        options.maxRecentersOnLoss ??
        0
      )),
    );

    // Старое имя сохранено для совместимости с debug-кодом.
    this.maxRecentersOnLoss = this.maxRecenters;

    this.recenterCooldownFrames = Math.max(
      0,
      Math.round(Number(options.recenterCooldownFrames ?? 8)),
    );

    // Совместимость с существующим debug-кодом.
    this.recenterEdgeRatioX = this.warningEdgeRatioX;
    this.recenterEdgeRatioY = this.warningEdgeRatioY;
    this.recenterHysteresisRatio = this.warningHysteresisRatio;
    this.recenterMargin = this.warningEdgeRatioX;

    this.rect = null;
    this.recenterCount = 0;
    this.cooldownRemaining = 0;

    this.warning = false;
    this.warningFrames = 0;
    this.warningSide = null;
    this.lastEdgeRatios = null;
    this.lastLocalRect = null;
  }

  /** Создаёт ROI вокруг подтверждённой глобальной рамки цели. */
  start(frame, globalTargetRect) {
    const extracted = this.extractor.extract(frame, globalTargetRect);

    if (!extracted) {
      throw new Error('Не удалось создать tracking ROI');
    }

    this.rect = { ...extracted.rect };
    this.cooldownRemaining = 0;
    this.warning = false;
    this.warningFrames = 0;
    this.warningSide = null;
    this.lastLocalRect = extracted.localTargetRect
      ? {
        x: Number(extracted.localTargetRect.x),
        y: Number(extracted.localTargetRect.y),
        width: Number(extracted.localTargetRect.width),
        height: Number(extracted.localTargetRect.height),
      }
      : null;
    this.lastEdgeRatios = this.lastLocalRect
      ? this.#calculateEdgeRatios(this.lastLocalRect)
      : null;

    return extracted;
  }

  extractCurrent(frame) {
    if (!this.rect) return null;

    const rect = new cv.Rect(
      this.rect.x,
      this.rect.y,
      this.rect.width,
      this.rect.height,
    );

    return frame.getRegion(rect).copy();
  }

  toGlobal(localRect) {
    if (!this.rect || !localRect) return null;

    return new cv.Rect(
      Math.round(this.rect.x + Number(localRect.x)),
      Math.round(this.rect.y + Number(localRect.y)),
      Math.round(Number(localRect.width)),
      Math.round(Number(localRect.height)),
    );
  }

  toLocal(globalRect) {
    if (!this.rect || !globalRect) return null;

    return new cv.Rect(
      Math.round(Number(globalRect.x) - this.rect.x),
      Math.round(Number(globalRect.y) - this.rect.y),
      Math.round(Number(globalRect.width)),
      Math.round(Number(globalRect.height)),
    );
  }

  /**
   * Обновляет состояние WARNING по текущей зелёной рамке.
   *
   * Метод ничего не переносит и возвращает только состояние предупреждения.
   */
  updateWarning(localRect) {
    if (!this.rect || !localRect) {
      return this.warning;
    }

    const edgeRatios = this.#calculateEdgeRatios(localRect);
    if (!edgeRatios) {
      return this.warning;
    }

    this.lastLocalRect = {
      x: Number(localRect.x),
      y: Number(localRect.y),
      width: Number(localRect.width),
      height: Number(localRect.height),
    };
    this.lastEdgeRatios = edgeRatios;

    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= 1;
    }

    const warningSide = this.#findWarningSide(edgeRatios);

    if (warningSide) {
      this.warningFrames += 1;
      this.warningSide = warningSide;

      if (this.warningFrames >= this.warningConfirmFrames) {
        this.warning = true;
      }

      return this.warning;
    }

    const clearX =
      edgeRatios.left >= (
        this.warningEdgeRatioX + this.warningHysteresisRatio
      ) &&
      edgeRatios.right >= (
        this.warningEdgeRatioX + this.warningHysteresisRatio
      );

    const clearY =
      edgeRatios.top >= (
        this.warningEdgeRatioY + this.warningHysteresisRatio
      ) &&
      edgeRatios.bottom >= (
        this.warningEdgeRatioY + this.warningHysteresisRatio
      );

    if (clearX && clearY) {
      this.clearWarning();
    } else {
      this.warningFrames = 0;
    }

    return this.warning;
  }

  /**
   * Разрешает плановый перенос после устойчивого WARNING.
   */
  canRecenterByWarning() {
    return (
      this.recenterMode === 'TIME_BASED' &&
      this.warning &&
      this.warningFrames >= this.recenterAfterWarningFrames &&
      this.cooldownRemaining <= 0 &&
      this.#hasRecenterBudget()
    );
  }

  /**
   * Аварийный recenter после временной ошибки KCF остаётся доступным
   * в обоих режимах, если перед потерей уже был подтверждён WARNING.
   */
  canRecenterOnLoss() {
    return (
      this.warning &&
      this.cooldownRemaining <= 0 &&
      this.#hasRecenterBudget()
    );
  }

  markRecenter() {
    this.recenterCount += 1;
    this.cooldownRemaining = this.recenterCooldownFrames;
    this.clearWarning();
  }

  clearWarning() {
    this.warning = false;
    this.warningFrames = 0;
    this.warningSide = null;
  }

  reset() {
    this.rect = null;
    this.recenterCount = 0;
    this.cooldownRemaining = 0;
    this.clearWarning();
    this.lastEdgeRatios = null;
    this.lastLocalRect = null;
  }

  /**
   * Возвращает геометрию внутренней безопасной зоны.
   * Голубая рамка debug-окна — именно SAFE AREA, а не граница ROI.
   */
  getSafeAreaState(localRect = this.lastLocalRect) {
    if (!this.rect || !localRect) return null;

    const roiWidth = Number(this.rect.width);
    const roiHeight = Number(this.rect.height);
    const x = Number(localRect.x);
    const y = Number(localRect.y);
    const width = Number(localRect.width);
    const height = Number(localRect.height);

    if (![roiWidth, roiHeight, x, y, width, height].every(Number.isFinite)) {
      return null;
    }

    const safeLeft = roiWidth * this.warningEdgeRatioX;
    const safeRight = roiWidth * (1 - this.warningEdgeRatioX);
    const safeTop = roiHeight * this.warningEdgeRatioY;
    const safeBottom = roiHeight * (1 - this.warningEdgeRatioY);

    const objectRight = x + width;
    const objectBottom = y + height;

    const overflow = {
      left: Math.max(0, safeLeft - x),
      right: Math.max(0, objectRight - safeRight),
      top: Math.max(0, safeTop - y),
      bottom: Math.max(0, objectBottom - safeBottom),
    };

    const candidates = Object.entries(overflow)
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);

    const side = candidates.length > 0
      ? String(candidates[0][0]).toUpperCase()
      : null;
    const maxOverflowPx = candidates.length > 0
      ? Number(candidates[0][1])
      : 0;

    return {
      outsideSafeArea: maxOverflowPx > 0,
      side,
      maxOverflowPx: Number(maxOverflowPx.toFixed(1)),
      overflowPx: {
        left: Number(overflow.left.toFixed(1)),
        right: Number(overflow.right.toFixed(1)),
        top: Number(overflow.top.toFixed(1)),
        bottom: Number(overflow.bottom.toFixed(1)),
      },
      safeRect: {
        x: Number(safeLeft.toFixed(1)),
        y: Number(safeTop.toFixed(1)),
        width: Number((safeRight - safeLeft).toFixed(1)),
        height: Number((safeBottom - safeTop).toFixed(1)),
      },
      localRect: {
        x, y, width, height,
      },
    };
  }

  getState() {
    return {
      rect: this.rect ? { ...this.rect } : null,

      warning: this.warning,
      warningFrames: this.warningFrames,
      warningSide: this.warningSide,
      warningConfirmFrames: this.warningConfirmFrames,

      warningEdgeRatioX: this.warningEdgeRatioX,
      warningEdgeRatioY: this.warningEdgeRatioY,
      warningHysteresisRatio: this.warningHysteresisRatio,

      recenterMode: this.recenterMode,
      recenterAfterWarningFrames: this.recenterAfterWarningFrames,
      recenterCount: this.recenterCount,
      maxRecenters: this.maxRecenters,
      maxRecentersOnLoss: this.maxRecentersOnLoss,
      cooldownRemaining: this.cooldownRemaining,
      recenterCooldownFrames: this.recenterCooldownFrames,

      edgeRatios: this.lastEdgeRatios
        ? { ...this.lastEdgeRatios }
        : null,
      safeArea: this.getSafeAreaState(),

      // Поля совместимости с предыдущей версией.
      recenterEdgeRatioX: this.recenterEdgeRatioX,
      recenterEdgeRatioY: this.recenterEdgeRatioY,
      recenterHysteresisRatio: this.recenterHysteresisRatio,
      recenterMargin: this.recenterMargin,
      recenterArmed: this.warning,
    };
  }

  #hasRecenterBudget() {
    return (
      this.maxRecenters === 0 ||
      this.recenterCount < this.maxRecenters
    );
  }

  #findWarningSide(edgeRatios) {
    const candidates = [];

    if (edgeRatios.left <= this.warningEdgeRatioX) {
      candidates.push(['LEFT', edgeRatios.left]);
    }

    if (edgeRatios.right <= this.warningEdgeRatioX) {
      candidates.push(['RIGHT', edgeRatios.right]);
    }

    if (edgeRatios.top <= this.warningEdgeRatioY) {
      candidates.push(['TOP', edgeRatios.top]);
    }

    if (edgeRatios.bottom <= this.warningEdgeRatioY) {
      candidates.push(['BOTTOM', edgeRatios.bottom]);
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((first, second) => first[1] - second[1]);
    return candidates[0][0];
  }

  #calculateEdgeRatios(localRect) {
    const roiWidth = Number(this.rect.width);
    const roiHeight = Number(this.rect.height);

    const x = Number(localRect.x);
    const y = Number(localRect.y);
    const width = Number(localRect.width);
    const height = Number(localRect.height);

    if (
      ![roiWidth, roiHeight, x, y, width, height].every(Number.isFinite) ||
      roiWidth <= 0 ||
      roiHeight <= 0 ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }

    return {
      left: x / roiWidth,
      right: (roiWidth - (x + width)) / roiWidth,
      top: y / roiHeight,
      bottom: (roiHeight - (y + height)) / roiHeight,
    };
  }

  static #normalizeRecenterMode(value) {
    const mode = String(value ?? 'TIME_BASED')
      .trim()
      .toUpperCase();

    if (!['TIME_BASED', 'LOSS_BASED'].includes(mode)) {
      throw new Error(
        `Неизвестный режим ROI recenter: ${mode}. ` +
        'Допустимые значения: TIME_BASED, LOSS_BASED.',
      );
    }

    return mode;
  }

  static #number(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }
}

module.exports = TrackingRoiSession;
