'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Лёгкая инженерная текстовая панель поверх уже существующего cv.Mat.
 *
 * ВАЖНО:
 * - не создаёт новый Mat;
 * - не использует hConcat/vConcat;
 * - не использует blend/ROI;
 * - рисует только rectangle + putText на переданном кадре.
 *
 * Это сделано намеренно для совместимости с разными сборками
 * @u4/opencv4nodejs / OpenCV HighGUI.
 */
class OverlayPanel {
  constructor(options = {}) {
    this.updateConfiguration(options);
  }

  updateConfiguration(options = {}) {
    this.margin = Math.max(0, Math.round(Number(options.margin) || 12));
    this.padding = Math.max(4, Math.round(Number(options.padding) || 12));
    this.lineHeight = Math.max(
      16,
      Math.round(Number(options.lineHeight) || 23),
    );
    this.width = Math.max(260, Math.round(Number(options.width) || 470));

    this.background = options.background ?? new cv.Vec3(12, 12, 12);
    this.border = options.border ?? new cv.Vec3(220, 220, 220);
    this.defaultText = options.defaultText ?? new cv.Vec3(255, 255, 255);

    return this.getConfiguration();
  }

  getConfiguration() {
    return {
      margin: this.margin,
      padding: this.padding,
      lineHeight: this.lineHeight,
      width: this.width,
    };
  }

  /**
   * Рисует панель в правой части кадра.
   *
   * Возвращает фактический прямоугольник панели.
   */
  draw(frame, lines = [], options = {}) {
    if (!frame || !Array.isArray(lines) || lines.length === 0) {
      return null;
    }

    const desiredWidth = Math.max(
      260,
      Math.round(Number(options.width) || this.width),
    );

    const maxWidth = Math.max(120, frame.cols - this.margin * 2);
    const panelWidth = Math.min(desiredWidth, maxWidth);

    const desiredHeight =
      this.padding * 2 +
      Math.max(1, lines.length) * this.lineHeight;

    const maxHeight = Math.max(60, frame.rows - this.margin * 2);
    const panelHeight = Math.min(desiredHeight, maxHeight);

    const x = Math.max(
      this.margin,
      frame.cols - this.margin - panelWidth,
    );

    const y = this.margin;

    const x2 = Math.min(frame.cols - 1, x + panelWidth);
    const y2 = Math.min(frame.rows - 1, y + panelHeight);

    // Непрозрачная подложка — максимально совместимый вариант.
    frame.drawRectangle(
      new cv.Point2(x, y),
      new cv.Point2(x2, y2),
      this.background,
      -1,
      cv.LINE_8,
    );

    frame.drawRectangle(
      new cv.Point2(x, y),
      new cv.Point2(x2, y2),
      this.border,
      1,
      cv.LINE_AA,
    );

    const textX = x + this.padding;

    lines.forEach((line, index) => {
      const textY =
        y +
        this.padding +
        this.lineHeight * (index + 1) -
        5;

      if (textY >= y2 - 4) return;

      const entry =
        line && typeof line === 'object'
          ? line
          : { text: String(line ?? '') };

      frame.putText(
        String(entry.text ?? ''),
        new cv.Point2(textX, textY),
        cv.FONT_HERSHEY_SIMPLEX,
        entry.header ? 0.52 : 0.42,
        entry.color ?? this.defaultText,
        entry.header ? 2 : 1,
        cv.LINE_AA,
      );
    });

    return {
      x,
      y,
      width: panelWidth,
      height: panelHeight,
      centerX: x + panelWidth / 2,
      centerY: y + panelHeight / 2,
    };
  }
}

module.exports = OverlayPanel;
