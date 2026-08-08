'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Строит расширенную область интереса вокруг сопровождаемой цели.
 *
 * Класс не изменяет исходный кадр и не знает ничего о KCF или YOLO.
 */
class TrackingRoiExtractor {
  constructor(options = {}) {
    this.updateConfiguration(options);
  }

  updateConfiguration(options = {}) {
    this.paddingX = TrackingRoiExtractor.#number(options.paddingX, 0.60, 0, 4);
    this.paddingY = TrackingRoiExtractor.#number(options.paddingY, 0.80, 0, 4);
    this.minWidth = TrackingRoiExtractor.#integer(options.minWidth, 240, 16, 4096);
    this.minHeight = TrackingRoiExtractor.#integer(options.minHeight, 160, 16, 4096);
  }

  /**
   * Возвращает копию ROI и его прямоугольник в координатах полного кадра.
   */
  extract(frame, targetRect) {
    if (!frame || !targetRect) return null;

    const frameWidth = Number(frame.cols);
    const frameHeight = Number(frame.rows);

    if (!(frameWidth > 0 && frameHeight > 0)) return null;

    const target = TrackingRoiExtractor.#normalizeRect(targetRect);
    if (!target) return null;

    const desiredWidth = Math.max(
      this.minWidth,
      Math.round(target.width * (1 + this.paddingX * 2)),
    );
    const desiredHeight = Math.max(
      this.minHeight,
      Math.round(target.height * (1 + this.paddingY * 2)),
    );

    const centerX = target.x + target.width / 2;
    const centerY = target.y + target.height / 2;

    const width = Math.min(frameWidth, desiredWidth);
    const height = Math.min(frameHeight, desiredHeight);

    const x = TrackingRoiExtractor.#clamp(
      Math.round(centerX - width / 2),
      0,
      frameWidth - width,
    );
    const y = TrackingRoiExtractor.#clamp(
      Math.round(centerY - height / 2),
      0,
      frameHeight - height,
    );

    const rect = new cv.Rect(x, y, width, height);
    const localTargetRect = {
      x: target.x - x,
      y: target.y - y,
      width: target.width,
      height: target.height,
    };

    // getRegion() является представлением исходного Mat, поэтому сразу создаём
    // независимую копию. Исходный рабочий кадр не модифицируется.
    const roi = frame.getRegion(rect).copy();

    return {
      roi,
      rect: { x, y, width, height },
      localTargetRect,
    };
  }

  static #normalizeRect(rect) {
    const x = Math.round(Number(rect.x));
    const y = Math.round(Number(rect.y));
    const width = Math.round(Number(rect.width));
    const height = Math.round(Number(rect.height));

    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0) return null;

    return { x, y, width, height };
  }

  static #number(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  static #integer(value, fallback, min, max) {
    return Math.round(TrackingRoiExtractor.#number(value, fallback, min, max));
  }

  static #clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
}

module.exports = TrackingRoiExtractor;
