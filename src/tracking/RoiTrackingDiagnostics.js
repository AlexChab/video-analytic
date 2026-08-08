'use strict';

const { performance } = require('node:perf_hooks');
const cv = require('@u4/opencv4nodejs');
const TrackingRoiExtractor = require('./TrackingRoiExtractor');
const TrackingRoiEnhancer = require('./TrackingRoiEnhancer');

/**
 * Безопасный диагностический контур сравнения ORIGINAL / ENHANCED ROI.
 *
 * По умолчанию выключен и никак не влияет на рабочий KCF.
 */
class RoiTrackingDiagnostics {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.showWindows = Boolean(options.showWindows);
    this.intervalMs = Math.max(50, Number(options.intervalMs ?? 250));
    this.originalWindowName = 'ROI ORIGINAL';
    this.enhancedWindowName = 'ROI ENHANCED';
    this.lastRunAt = 0;
    this.windowsCreated = false;

    this.extractor = new TrackingRoiExtractor(options);
    this.enhancer = new TrackingRoiEnhancer(options);
  }

  process(frame, trackedRect) {
    if (!this.enabled || !frame || !trackedRect) return null;

    const now = Date.now();
    if (now - this.lastRunAt < this.intervalMs) return null;
    this.lastRunAt = now;

    const totalStartedAt = performance.now();
    const extractionStartedAt = performance.now();
    const extraction = this.extractor.extract(frame, trackedRect);
    const extractMs = performance.now() - extractionStartedAt;

    if (!extraction) return null;

    const enhanceStartedAt = performance.now();
    const enhanced = this.enhancer.enhance(extraction.roi);
    const enhanceMs = performance.now() - enhanceStartedAt;

    if (!enhanced) {
      extraction.roi.delete?.();
      return null;
    }

    const originalPreview = extraction.roi.copy();
    this.#drawTargetRect(originalPreview, extraction.localTargetRect, 1);
    this.#drawInfo(originalPreview, [
      `ROI ${extraction.rect.width}x${extraction.rect.height}`,
      `Extract ${extractMs.toFixed(2)} ms`,
    ]);

    const scaleX = enhanced.cols / extraction.roi.cols;
    const scaleY = enhanced.rows / extraction.roi.rows;
    this.#drawTargetRect(enhanced, {
      x: extraction.localTargetRect.x * scaleX,
      y: extraction.localTargetRect.y * scaleY,
      width: extraction.localTargetRect.width * scaleX,
      height: extraction.localTargetRect.height * scaleY,
    }, Math.max(1, Math.round(scaleX)));

    const cfg = this.enhancer.getConfiguration();
    this.#drawInfo(enhanced, [
      `CLAHE ${cfg.claheEnabled ? 'ON' : 'OFF'} clip=${cfg.claheClipLimit}`,
      `Gamma ${cfg.gamma} sharpen ${cfg.sharpen}`,
      `Enhance ${enhanceMs.toFixed(2)} ms`,
    ]);

    if (this.showWindows) {
      this.#show(originalPreview, enhanced);
    }

    const result = {
      roiRect: extraction.rect,
      extractMs,
      enhanceMs,
      totalMs: performance.now() - totalStartedAt,
    };

    originalPreview.delete?.();
    extraction.roi.delete?.();
    enhanced.delete?.();

    return result;
  }

  #show(original, enhanced) {
    try {
      if (!this.windowsCreated && typeof cv.namedWindow === 'function') {
        cv.namedWindow(this.originalWindowName, cv.WINDOW_NORMAL);
        cv.namedWindow(this.enhancedWindowName, cv.WINDOW_NORMAL);

        if (typeof cv.resizeWindow === 'function') {
          cv.resizeWindow(this.originalWindowName, 480, 300);
          cv.resizeWindow(this.enhancedWindowName, 480, 300);
        }
        this.windowsCreated = true;
      }

      cv.imshow(this.originalWindowName, original);
      cv.imshow(this.enhancedWindowName, enhanced);
      // waitKey() уже вызывается главным окном OpenCV в app.js.
    } catch {
      this.showWindows = false;
    }
  }

  #drawTargetRect(frame, rect, thickness) {
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const right = Math.min(frame.cols - 1, Math.round(rect.x + rect.width));
    const bottom = Math.min(frame.rows - 1, Math.round(rect.y + rect.height));

    frame.drawRectangle(
      new cv.Point2(x, y),
      new cv.Point2(right, bottom),
      new cv.Vec3(0, 255, 0),
      thickness,
      cv.LINE_AA,
    );
  }

  #drawInfo(frame, lines) {
    const panelHeight = 14 + lines.length * 22;
    frame.drawRectangle(
      new cv.Point2(0, 0),
      new cv.Point2(Math.min(frame.cols - 1, 390), panelHeight),
      new cv.Vec3(20, 20, 20),
      -1,
      cv.LINE_8,
    );

    lines.forEach((line, index) => {
      frame.putText(
        line,
        new cv.Point2(8, 20 + index * 22),
        cv.FONT_HERSHEY_SIMPLEX,
        0.48,
        new cv.Vec3(235, 235, 235),
        1,
        cv.LINE_AA,
      );
    });
  }

  dispose() {
    if (!this.windowsCreated) return;

    for (const name of [this.originalWindowName, this.enhancedWindowName]) {
      try {
        cv.destroyWindow(name);
      } catch {
        // Окно уже могло быть закрыто пользователем.
      }
    }

    this.windowsCreated = false;
  }
}

module.exports = RoiTrackingDiagnostics;
