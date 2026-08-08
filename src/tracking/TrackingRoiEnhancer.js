'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Усиливает контраст только внутри диагностического ROI.
 *
 * Результат создаётся как отдельный Mat. Рабочий кадр не изменяется.
 */
class TrackingRoiEnhancer {
  constructor(options = {}) {
    this.updateConfiguration(options);
    this.clahe = null;
    this.#rebuildClahe();
  }

  updateConfiguration(options = {}) {
    this.claheEnabled = TrackingRoiEnhancer.#boolean(
      options.claheEnabled,
      true,
    );
    this.claheClipLimit = TrackingRoiEnhancer.#number(
      options.claheClipLimit,
      2.0,
      0.1,
      20,
    );
    this.claheTileSize = TrackingRoiEnhancer.#integer(
      options.claheTileSize,
      8,
      2,
      32,
    );
    this.gamma = TrackingRoiEnhancer.#number(options.gamma, 1.10, 0.2, 4);
    this.sharpen = TrackingRoiEnhancer.#number(options.sharpen, 0.20, 0, 2);
    this.upscale = TrackingRoiEnhancer.#number(options.upscale, 2, 1, 4);

    if (this.clahe !== undefined) this.#rebuildClahe();
  }

  #rebuildClahe() {
    this.clahe = null;

    if (!this.claheEnabled) return;

    try {
      if (typeof cv.CLAHE === 'function') {
        this.clahe = new cv.CLAHE(
          this.claheClipLimit,
          new cv.Size(this.claheTileSize, this.claheTileSize),
        );
      }
    } catch {
      // Ниже используется безопасный fallback equalizeHist().
      this.clahe = null;
    }
  }

  enhance(roi) {
    if (!roi) return null;

    let gray = roi.channels === 1
      ? roi.copy()
      : roi.cvtColor(cv.COLOR_BGR2GRAY);

    let contrast = gray;

    if (this.claheEnabled) {
      try {
        contrast = this.clahe
          ? this.clahe.apply(gray)
          : gray.equalizeHist();
      } catch {
        contrast = gray.equalizeHist();
      }
    }

    let enhanced = contrast.cvtColor(cv.COLOR_GRAY2BGR);

    if (Math.abs(this.gamma - 1) > 0.001) {
      const source = enhanced.getData();
      const corrected = Buffer.allocUnsafe(source.length);
      const inverseGamma = 1 / this.gamma;

      for (let index = 0; index < source.length; index += 1) {
        corrected[index] = Math.max(
          0,
          Math.min(
            255,
            Math.round(255 * Math.pow(source[index] / 255, inverseGamma)),
          ),
        );
      }

      enhanced = new cv.Mat(
        corrected,
        enhanced.rows,
        enhanced.cols,
        cv.CV_8UC3,
      );
    }

    if (this.sharpen > 0) {
      try {
        const blurred = enhanced.gaussianBlur(new cv.Size(3, 3), 0);
        enhanced = enhanced.addWeighted(
          1 + this.sharpen,
          blurred,
          -this.sharpen,
          0,
        );
      } catch {
        // Sharpen является необязательным диагностическим этапом.
      }
    }

    if (this.upscale > 1.001) {
      enhanced = enhanced.resize(
        Math.max(1, Math.round(enhanced.rows * this.upscale)),
        Math.max(1, Math.round(enhanced.cols * this.upscale)),
        0,
        0,
        cv.INTER_CUBIC,
      );
    }

    return enhanced;
  }

  getConfiguration() {
    return {
      claheEnabled: this.claheEnabled,
      claheClipLimit: this.claheClipLimit,
      claheTileSize: this.claheTileSize,
      gamma: this.gamma,
      sharpen: this.sharpen,
      upscale: this.upscale,
    };
  }

  static #boolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }

  static #number(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  static #integer(value, fallback, min, max) {
    return Math.round(TrackingRoiEnhancer.#number(value, fallback, min, max));
  }
}

module.exports = TrackingRoiEnhancer;
