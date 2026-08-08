'use strict';

const cv = require('@u4/opencv4nodejs');
const logger = require('../utils/Logger');
const ObjectTracker = require('../analytics/ObjectTracker');
const TrackingRoiSession = require('./TrackingRoiSession');
const TrackingRoiEnhancer = require('./TrackingRoiEnhancer');
const TrackerScaleHealthMonitor = require('./TrackerScaleHealthMonitor');

/**
 * Специализированный режим сопровождения слабоконтрастной цели.
 *
 * Полный кадр используется только для вырезания фиксированного ROI. KCF
 * получает локально усиленное изображение и возвращает локальную рамку,
 * которая переводится обратно в координаты полного кадра.
 */
class LowContrastObjectTracker {
  constructor(options = {}) {
    this.type = 'KCF';
    this.mode = 'LOW_CONTRAST';
    this.debug = Boolean(options.debug);

    /**
     * Окно показывает именно тот enhanced ROI, который получает KCF.
     * В рабочем режиме выключается одним параметром и не создаёт копий Mat.
     */
    this.debugWindowEnabled = Boolean(options.debugWindowEnabled);
    this.debugWindowName = 'LOW CONTRAST ROI - KCF INPUT';
    this.debugWindowWidth = Math.max(
      320,
      Number(options.debugWindowWidth ?? 640),
    );
    this.debugWindowHeight = Math.max(
      220,
      Number(options.debugWindowHeight ?? 440),
    );
    this.debugShowSafeArea = options.debugShowSafeArea !== false;
    this.debugShowStats = options.debugShowStats !== false;
    this.debugWindowCreated = false;

    this.localTrackerOptions = {
      type: options.type ?? 'KCF',
      minWidth: options.minWidth ?? 8,
      minHeight: options.minHeight ?? 8,
      maxConsecutiveErrors: options.maxConsecutiveErrors ?? 3,
      debug: Boolean(options.debug),
    };

    this.session = new TrackingRoiSession({
      paddingX: options.paddingX ?? 1.0,
      paddingY: options.paddingY ?? 1.2,
      minWidth: options.roiMinWidth ?? 320,
      minHeight: options.roiMinHeight ?? 220,

      warningEdgeRatioX:
        options.warningEdgeRatioX ??
        options.recenterEdgeRatioX ??
        0.15,
      warningEdgeRatioY:
        options.warningEdgeRatioY ??
        options.recenterEdgeRatioY ??
        0.10,
      warningHysteresisRatio:
        options.warningHysteresisRatio ??
        options.recenterHysteresisRatio ??
        0.03,
      warningConfirmFrames:
        options.warningConfirmFrames ?? 3,

      recenterMode:
        options.recenterMode ?? 'TIME_BASED',
      recenterAfterWarningFrames:
        options.recenterAfterWarningFrames ?? 8,
      maxRecenters:
        options.maxRecenters ??
        options.maxRecentersOnLoss ??
        0,

      recenterCooldownFrames:
        options.recenterCooldownFrames ?? 8,

      // Совместимость со старыми конфигурациями.
      recenterMargin: options.recenterMargin,
    });

    this.scaleHealthMonitor = new TrackerScaleHealthMonitor({
      enabled: options.scaleHealthEnabled ?? true,
      confirmFrames: options.scaleHealthConfirmFrames ?? 4,
      maxCenterDistanceRatio:
        options.scaleHealthMaxCenterDistanceRatio ?? 0.35,
      minIou: options.scaleHealthMinIou ?? 0.20,
      minTrackedCoverage:
        options.scaleHealthMinTrackedCoverage ?? 0.55,
      growThresholdRatio:
        options.scaleHealthGrowThresholdRatio ?? 1.35,
      shrinkThresholdRatio:
        options.scaleHealthShrinkThresholdRatio ?? 0.65,
    });

    this.enhancer = new TrackingRoiEnhancer({
      claheEnabled: options.claheEnabled ?? true,
      claheClipLimit: options.claheClipLimit ?? 1.7,
      claheTileSize: options.claheTileSize ?? 8,
      gamma: options.gamma ?? 1.08,
      sharpen: options.sharpen ?? 0.10,
      // Для KCF сохраняем исходный масштаб локального окна.
      upscale: 1,
    });

    this.localTracker = this.#createLocalTracker();
    this.rect = null;
    this.active = false;
    this.frameCount = 0;
    this.lastStopReason = null;
    this.reinitializations = 0;
    this.losses = 0;

    /** Последний факт переноса ROI. Только диагностика. */
    this.lastRecenter = null;
  }

  start(frame, globalTargetRect) {
    this.reset('Повторная инициализация LOW_CONTRAST');

    const extracted = this.session.start(frame, globalTargetRect);
    const enhanced = this.enhancer.enhance(extracted.roi);

    try {
      const localRect = new cv.Rect(
        Math.round(extracted.localTargetRect.x),
        Math.round(extracted.localTargetRect.y),
        Math.round(extracted.localTargetRect.width),
        Math.round(extracted.localTargetRect.height),
      );

      this.localTracker = this.#createLocalTracker();
      this.localTracker.start(enhanced, localRect);
      this.#showDebugWindow(enhanced, localRect, {
        phase: 'INIT',
        recentered: false,
      });
      this.rect = this.session.toGlobal(localRect);
      this.active = true;
      this.frameCount = 0;
      this.lastStopReason = null;

      this.#log('LOW_CONTRAST сопровождение запущено', this.getState());
      return this.#cloneRect(this.rect);
    } finally {
      LowContrastObjectTracker.#deleteMat(extracted.roi);
      LowContrastObjectTracker.#deleteMat(enhanced);
    }
  }

  update(frame, detections = []) {
    if (!this.active || !this.localTracker.isActive()) {
      return null;
    }

    this.frameCount += 1;
    const roi = this.session.extractCurrent(frame);

    if (!roi) {
      this.#registerLoss('Текущий tracking ROI недоступен');
      return null;
    }

    const enhanced = this.enhancer.enhance(roi);

    try {
      const localRect = this.localTracker.update(enhanced);

      if (!localRect) {
        /*
         * Край ROI сам по себе больше не вызывает переинициализацию.
         * Recenter выполняется только при ошибке KCF после подтверждённого
         * WARNING, используя последнюю успешную глобальную рамку.
         */
        if (
          this.rect &&
          this.session.canRecenterOnLoss()
        ) {
          this.#log(
            'KCF дал временную потерю после ROI WARNING; пробуем recenter',
            this.session.getState(),
          );

          const recovered = this.#recenter(frame, this.rect, {
            reason: 'LOSS_AFTER_WARNING',
          });

          if (recovered) {
            return this.rect ? this.#cloneRect(this.rect) : null;
          }
        }

        if (!this.localTracker.isActive()) {
          this.#registerLoss('KCF окончательно потерял цель в enhanced ROI');
        }

        return null;
      }

      this.session.updateWarning(localRect);
      this.rect = this.session.toGlobal(localRect);
      this.scaleHealthMonitor.update(this.rect, detections);

      /*
       * TIME_BASED:
       * если рамка устойчиво находится у края, перестраиваем ROI до потери
       * KCF. Текущая глобальная рамка уже подтверждена успешным update().
       */
      if (
        this.rect &&
        this.session.canRecenterByWarning()
      ) {
        this.#log(
          'Устойчивый ROI WARNING; выполняем плановый recenter',
          this.session.getState(),
        );

        const recentered = this.#recenter(frame, this.rect, {
          reason: 'WARNING_TIMEOUT',
        });

        if (recentered) {
          return this.rect ? this.#cloneRect(this.rect) : null;
        }
      }

      this.#showDebugWindow(enhanced, localRect, {
        phase: this.session.warning ? 'WARNING' : 'TRACKING',
        recentered: false,
      });

      return this.rect ? this.#cloneRect(this.rect) : null;
    } finally {
      LowContrastObjectTracker.#deleteMat(roi);
      LowContrastObjectTracker.#deleteMat(enhanced);
    }
  }

  /** Перестраивает фиксированный ROI вокруг подтверждённой позиции цели. */
  #recenter(frame, globalRect, {
    reason = 'TRACKING_LOSS',
  } = {}) {
    const beforeState = this.session.getState();
    const beforeSafe = beforeState.safeArea ?? null;
    const beforeRoi = beforeState.rect ?? null;

    const extracted = this.session.start(frame, globalRect);
    const enhanced = this.enhancer.enhance(extracted.roi);

    try {
      const localRect = new cv.Rect(
        Math.round(extracted.localTargetRect.x),
        Math.round(extracted.localTargetRect.y),
        Math.round(extracted.localTargetRect.width),
        Math.round(extracted.localTargetRect.height),
      );

      const nextTracker = this.#createLocalTracker();
      nextTracker.start(enhanced, localRect);
      this.#showDebugWindow(enhanced, localRect, {
        phase: 'RECENTER',
        recentered: true,
      });
      this.localTracker?.reset?.('Перестроение tracking ROI');
      this.localTracker = nextTracker;
      this.rect = this.session.toGlobal(localRect);
      this.session.markRecenter();
      this.reinitializations += 1;

      const afterState = this.session.getState();
      const afterSafe = afterState.safeArea ?? null;
      const afterRoi = afterState.rect ?? null;
      const beforeOverflowPx = Number(beforeSafe?.maxOverflowPx ?? 0);
      const afterOverflowPx = Number(afterSafe?.maxOverflowPx ?? 0);
      const roiMovedPx = beforeRoi && afterRoi
        ? Math.hypot(
          Number(afterRoi.x) - Number(beforeRoi.x),
          Number(afterRoi.y) - Number(beforeRoi.y),
        )
        : null;

      /*
       * Если после recenter цель всё ещё за голубой SAFE AREA и запас
       * практически не улучшился, перенос считается неэффективным.
       * Частый сценарий — ROI уже прижат к границе полного кадра.
       */
      const effective =
        afterOverflowPx <= 0 ||
        afterOverflowPx < Math.max(0, beforeOverflowPx - 2);

      this.lastRecenter = {
        reason,
        count: this.session.recenterCount,
        effective,
        beforeOverflowPx,
        afterOverflowPx,
        roiMovedPx: Number.isFinite(roiMovedPx)
          ? Number(roiMovedPx.toFixed(1))
          : null,
        beforeSide: beforeSafe?.side ?? null,
        afterSide: afterSafe?.side ?? null,
      };

      this.#log(
        `Tracking ROI перестроен: ${reason}; ` +
        `effective=${effective ? 'YES' : 'NO'}; ` +
        `overflow=${beforeOverflowPx.toFixed(1)}->${afterOverflowPx.toFixed(1)} px`,
        afterState,
      );

      return true;
    } catch (error) {
      this.#registerLoss(`Ошибка перестроения ROI: ${error.message}`);
      return false;
    } finally {
      LowContrastObjectTracker.#deleteMat(extracted.roi);
      LowContrastObjectTracker.#deleteMat(enhanced);
    }
  }

  reset(reason = 'Ручной сброс') {
    this.localTracker?.reset(reason);
    this.session.reset();
    this.scaleHealthMonitor.reset();
    this.rect = null;
    this.active = false;
    this.frameCount = 0;
    this.lastStopReason = reason;
    this.lastRecenter = null;
  }

  isActive() {
    return this.active && this.localTracker?.isActive();
  }

  getRect() {
    return this.rect ? this.#cloneRect(this.rect) : null;
  }

  getCenter() {
    if (!this.rect) return null;
    return {
      x: this.rect.x + this.rect.width / 2,
      y: this.rect.y + this.rect.height / 2,
    };
  }

  getState() {
    return {
      mode: this.mode,
      type: this.type,
      active: this.isActive(),
      frameCount: this.frameCount,
      lastStopReason: this.lastStopReason,
      rect: this.rect ? {
        x: this.rect.x,
        y: this.rect.y,
        width: this.rect.width,
        height: this.rect.height,
      } : null,
      center: this.getCenter(),
      roi: this.session.getState(),
      enhancement: this.enhancer.getConfiguration(),
      scaleHealth: this.scaleHealthMonitor.getState(),
      reinitializations: this.reinitializations,
      losses: this.losses,
      lastRecenter: this.lastRecenter ? { ...this.lastRecenter } : null,
      localTracker: this.localTracker?.getState() ?? null,
    };
  }

  /**
   * Закрывает нативное окно OpenCV при штатном завершении приложения.
   */
  dispose() {
    this.reset('Завершение LOW_CONTRAST tracker');

    if (!this.debugWindowCreated) return;

    try {
      cv.destroyWindow(this.debugWindowName);
    } catch {
      // Окно могло быть закрыто пользователем вручную.
    }

    this.debugWindowCreated = false;
  }

  /**
   * Показывает копию enhanced ROI с локальной рамкой KCF.
   *
   * Важно: рисуем только на preview-копии. Mat `enhanced`, который получает
   * KCF, не изменяется служебными линиями и текстом.
   */
  #showDebugWindow(enhanced, localRect, {
    phase = 'TRACKING',
    recentered = false,
  } = {}) {
    if (!this.debugWindowEnabled || !enhanced || !localRect) return;

    let preview = null;

    try {
      preview = enhanced.copy();

      const x = Math.max(0, Math.round(Number(localRect.x)));
      const y = Math.max(0, Math.round(Number(localRect.y)));
      const right = Math.min(
        preview.cols - 1,
        Math.round(Number(localRect.x) + Number(localRect.width)),
      );
      const bottom = Math.min(
        preview.rows - 1,
        Math.round(Number(localRect.y) + Number(localRect.height)),
      );

      if (this.debugShowSafeArea) {
        const marginX = Math.round(
          preview.cols * this.session.recenterEdgeRatioX,
        );
        const marginY = Math.round(
          preview.rows * this.session.recenterEdgeRatioY,
        );

        preview.drawRectangle(
          new cv.Point2(marginX, marginY),
          new cv.Point2(
            Math.max(marginX + 1, preview.cols - marginX),
            Math.max(marginY + 1, preview.rows - marginY),
          ),
          new cv.Vec3(255, 180, 0),
          1,
          cv.LINE_AA,
        );
      }

      preview.drawRectangle(
        new cv.Point2(x, y),
        new cv.Point2(right, bottom),
        recentered
          ? new cv.Vec3(0, 220, 255)
          : new cv.Vec3(0, 255, 0),
        2,
        cv.LINE_AA,
      );

      const centerX = Math.round((x + right) / 2);
      const centerY = Math.round((y + bottom) / 2);

      preview.drawLine(
        new cv.Point2(centerX - 8, centerY),
        new cv.Point2(centerX + 8, centerY),
        new cv.Vec3(0, 0, 255),
        1,
        cv.LINE_AA,
      );
      preview.drawLine(
        new cv.Point2(centerX, centerY - 8),
        new cv.Point2(centerX, centerY + 8),
        new cv.Vec3(0, 0, 255),
        1,
        cv.LINE_AA,
      );

      if (this.debugShowStats) {
        const cfg = this.enhancer.getConfiguration();
        const lines = [
          `${phase}  ROI ${preview.cols}x${preview.rows}`,
          `KCF x=${x} y=${y} w=${Math.max(0, right - x)} h=${Math.max(0, bottom - y)}`,
          `CLAHE ${cfg.claheEnabled ? 'ON' : 'OFF'} clip=${cfg.claheClipLimit} gamma=${cfg.gamma}`,
          `warning=${this.session.warning ? 'YES' : 'NO'} ` +
            `side=${this.session.warningSide ?? '-'} ` +
            `frames=${this.session.warningFrames}/` +
            `${this.session.recenterAfterWarningFrames}`,
          `mode=${this.session.recenterMode} ` +
            `recenters=${this.session.recenterCount}/` +
            `${this.session.maxRecenters === 0
              ? 'INF'
              : this.session.maxRecenters} ` +
            `cd=${this.session.cooldownRemaining} losses=${this.losses}`,
          this.#safeAreaDebugLine(),
          this.#scaleHealthDebugLine(),
        ];

        const panelBottom = Math.min(
          preview.rows - 1,
          12 + lines.length * 20,
        );

        preview.drawRectangle(
          new cv.Point2(0, 0),
          new cv.Point2(Math.min(preview.cols - 1, 520), panelBottom),
          new cv.Vec3(18, 18, 18),
          -1,
          cv.LINE_8,
        );

        lines.forEach((line, index) => {
          preview.putText(
            line,
            new cv.Point2(7, 17 + index * 20),
            cv.FONT_HERSHEY_SIMPLEX,
            0.43,
            new cv.Vec3(235, 235, 235),
            1,
            cv.LINE_AA,
          );
        });
      }

      if (!this.debugWindowCreated) {
        if (typeof cv.namedWindow === 'function') {
          cv.namedWindow(this.debugWindowName, cv.WINDOW_NORMAL);
        }

        if (typeof cv.resizeWindow === 'function') {
          cv.resizeWindow(
            this.debugWindowName,
            this.debugWindowWidth,
            this.debugWindowHeight,
          );
        }

        this.debugWindowCreated = true;
      }

      cv.imshow(this.debugWindowName, preview);
      // cv.waitKey() уже вызывается основным OpenCV-окном в app.js.
    } catch (error) {
      this.debugWindowEnabled = false;
      this.#log(`ROI debug window отключено: ${error.message}`);
    } finally {
      LowContrastObjectTracker.#deleteMat(preview);
    }
  }

  #safeAreaDebugLine() {
    const state = this.session.getState();
    const safe = state.safeArea;

    if (!safe) {
      return 'SAFE no-data';
    }

    return (
      `SAFE ${safe.outsideSafeArea ? 'OUT' : 'IN'} ` +
      `side=${safe.side ?? '-'} overflow=` +
      `${Number(safe.maxOverflowPx ?? 0).toFixed(1)}px ` +
      `recenters=${state.recenterCount}`
    );
  }

  #scaleHealthDebugLine() {
    const health = this.scaleHealthMonitor.getState();
    const areaRatio = Number(health.areaRatio);
    const iou = Number(health.iou);

    return (
      `SCALE ${health.state} ` +
      `area=${Number.isFinite(areaRatio) ? areaRatio.toFixed(2) : '-'} ` +
      `iou=${Number.isFinite(iou) ? iou.toFixed(2) : '-'} ` +
      `match=${health.matchFrames}/${health.confirmFrames} ` +
      'AUTO=OFF'
    );
  }

  #createLocalTracker() {
    return new ObjectTracker(this.localTrackerOptions);
  }

  #registerLoss(reason) {
    this.losses += 1;
    this.lastStopReason = reason;

    if (!this.localTracker?.isActive()) {
      this.active = false;
      this.rect = null;
    }

    this.#log(reason);
  }

  #cloneRect(rect) {
    return new cv.Rect(rect.x, rect.y, rect.width, rect.height);
  }

  #log(...args) {
    if (this.debug) logger.info('[LowContrastTracker]', ...args);
  }

  static #deleteMat(mat) {
    if (mat && typeof mat.delete === 'function') {
      mat.delete();
    }
  }
}

module.exports = LowContrastObjectTracker;
