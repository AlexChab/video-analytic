'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Накладывает служебную графику поверх видеокадра.
 *
 * Цвета и обозначения:
 * - красные рамки — объекты, найденные детектором движения;
 * - красный круг — область автоматического захвата;
 * - красный крест — оптический центр кадра;
 * - зелёная рамка — выбранная цель, которую сопровождает CSRT;
 * - голубой прямоугольник — мёртвая зона будущего управления PTZ;
 * - белый текст — служебная информация.
 */
class FrameRenderer {
  constructor({
    frameWidth,
    frameHeight,
    ...configuration
  }) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.centerX = Math.round(frameWidth / 2);
    this.centerY = Math.round(frameHeight / 2);

    // OpenCV использует порядок каналов BGR.
    this.colors = {
      red: new cv.Vec3(0, 0, 255),
      green: new cv.Vec3(0, 255, 0),
      cyan: new cv.Vec3(255, 255, 0),
      white: new cv.Vec3(255, 255, 255),
      yellow: new cv.Vec3(0, 255, 255),
      black: new cv.Vec3(0, 0, 0),
      orange: new cv.Vec3(0, 165, 255),
    };

    this.updateConfiguration(configuration, { initial: true });
  }

  /**
   * Обновляет параметры визуализации без пересоздания renderer.
   * Неуказанные поля сохраняют текущее значение.
   */
  updateConfiguration(configuration = {}, { initial = false } = {}) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      throw new TypeError('FrameRenderer.updateConfiguration ожидает объект');
    }

    const previousConfiguration = initial ? null : this.getConfiguration();

    const numberOrCurrent = (value, current, fallback) =>
      Number.isFinite(Number(value)) ? Number(value) : (current ?? fallback);
    const booleanOrCurrent = (value, current, fallback) =>
      value === undefined ? (current ?? fallback) : Boolean(value);

    this.deadZoneX = Math.max(0, numberOrCurrent(configuration.deadZoneX, this.deadZoneX, 100));
    this.deadZoneY = Math.max(0, numberOrCurrent(configuration.deadZoneY, this.deadZoneY, 70));
    this.captureRadius = Math.max(0, numberOrCurrent(configuration.captureRadius, this.captureRadius, 180));
    this.showCenterCross = booleanOrCurrent(configuration.showCenterCross, this.showCenterCross, true);
    this.showCaptureZone = booleanOrCurrent(configuration.showCaptureZone, this.showCaptureZone, true);
    this.showDeadZone = booleanOrCurrent(configuration.showDeadZone, this.showDeadZone, true);
    this.showObjectIds = booleanOrCurrent(configuration.showObjectIds, this.showObjectIds, true);

    const currentConfiguration = this.getConfiguration();
    if (!initial) {
      const changed = Object.keys(currentConfiguration).filter(
        (key) => previousConfiguration?.[key] !== currentConfiguration[key],
      );
      if (changed.length > 0) {
        console.log(`[FrameRenderer] Конфигурация обновлена: ${changed.join(', ')}`);
      }
    }
    return currentConfiguration;
  }

  /** Возвращает текущие параметры визуализации. */
  getConfiguration() {
    return {
      deadZoneX: this.deadZoneX,
      deadZoneY: this.deadZoneY,
      captureRadius: this.captureRadius,
      showCenterCross: this.showCenterCross,
      showCaptureZone: this.showCaptureZone,
      showDeadZone: this.showDeadZone,
      showObjectIds: this.showObjectIds,
    };
  }

  /** Рисует все визуальные элементы. */
  render({
    frame,
    detections = [],
    selection,
    trackedRect = null,
    ptzCommand,
    metadata = {},
  }) {
    if (selection?.state === 'DETECTION_ONLY') {
      this.drawDetections(frame, detections);
      return frame;
    }

    this.drawControlZones(frame, selection);

    // В режиме ручного сопровождения красные рамки детектора не выводятся.
    if (selection?.state !== 'TRACKING') {
      this.drawDetections(frame, detections);
    }

    this.drawTrackedTarget(
      frame,
      trackedRect,
      selection?.targetCenter ?? null,
      selection?.targetId ?? null,
    );
    this.drawStatus(frame, selection, ptzCommand, metadata);

    return frame;
  }

  /**
   * Рисует центральную область автоматического захвата.
   *
   * Красный круг означает: пока сопровождение не активно, объект,
   * чей центр войдёт в этот круг и окажется ближе остальных к центру,
   * будет автоматически выбран для CSRT.
   */
  drawControlZones(frame, selection) {
    const isManualMode = selection?.mode === 'MANUAL_TRACKING';

    if (this.showCaptureZone && !isManualMode) {
      frame.drawCircle(
        new cv.Point2(this.centerX, this.centerY),
        this.captureRadius,
        this.colors.red,
        2,
        cv.LINE_AA,
      );
    }

    // Мёртвая зона оставлена для следующего этапа управления PTZ.
    if (this.showDeadZone) {
      frame.drawRectangle(
        new cv.Point2(
          this.centerX - this.deadZoneX,
          this.centerY - this.deadZoneY,
        ),
        new cv.Point2(
          this.centerX + this.deadZoneX,
          this.centerY + this.deadZoneY,
        ),
        this.colors.cyan,
        1,
        cv.LINE_8,
      );
    }

    // Красный прицел точно обозначает геометрический центр изображения.
    if (this.showCenterCross) {
      const crossHalfSize = 16;
      const crossGap = 4;

      frame.drawLine(
        new cv.Point2(this.centerX - crossHalfSize, this.centerY),
        new cv.Point2(this.centerX - crossGap, this.centerY),
        this.colors.red,
        2,
        cv.LINE_AA,
      );
      frame.drawLine(
        new cv.Point2(this.centerX + crossGap, this.centerY),
        new cv.Point2(this.centerX + crossHalfSize, this.centerY),
        this.colors.red,
        2,
        cv.LINE_AA,
      );
      frame.drawLine(
        new cv.Point2(this.centerX, this.centerY - crossHalfSize),
        new cv.Point2(this.centerX, this.centerY - crossGap),
        this.colors.red,
        2,
        cv.LINE_AA,
      );
      frame.drawLine(
        new cv.Point2(this.centerX, this.centerY + crossGap),
        new cv.Point2(this.centerX, this.centerY + crossHalfSize),
        this.colors.red,
        2,
        cv.LINE_AA,
      );

      frame.drawCircle(
        new cv.Point2(this.centerX, this.centerY),
        3,
        this.colors.red,
        -1,
        cv.LINE_AA,
      );
    }

    if (isManualMode) return;

    const captureType = selection?.captureType ?? 'ALL_OBJECTS';
    frame.putText(
      `AUTO CAPTURE: ${captureType}`,
      new cv.Point2(
        Math.max(10, this.centerX - this.captureRadius),
        Math.max(25, this.centerY - this.captureRadius - 10),
      ),
      cv.FONT_HERSHEY_SIMPLEX,
      0.55,
      this.colors.red,
      2,
      cv.LINE_AA,
    );
  }

  /** Рисует все области, найденные детектором движения. */

  drawDetections(frame, detections) {
    for (const detection of detections) {
      frame.drawRectangle(
        new cv.Point2(detection.x, detection.y),
        new cv.Point2(
          detection.x + detection.width,
          detection.y + detection.height,
        ),
        this.colors.red,
        2,
        cv.LINE_8,
      );

      const objectLabel =
        this.showObjectIds && detection.id != null
          ? `OBJECT ID: ${detection.id}`
          : 'OBJECT';

      frame.putText(
        objectLabel,
        new cv.Point2(detection.x, Math.max(20, detection.y - 7)),
        cv.FONT_HERSHEY_SIMPLEX,
        0.48,
        this.colors.red,
        2,
        cv.LINE_AA,
      );
    }
  }

  /** Рисует выбранную цель зелёным и показывает её ID. */
  drawTrackedTarget(frame, trackedRect, targetCenter, targetId) {
    if (!trackedRect || !targetCenter) return;

    const left = Math.round(trackedRect.x);
    const top = Math.round(trackedRect.y);
    const right = Math.round(trackedRect.x + trackedRect.width);
    const bottom = Math.round(trackedRect.y + trackedRect.height);
    const centerX = Math.round(targetCenter.x);
    const centerY = Math.round(targetCenter.y);

    frame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(right, bottom),
      this.colors.green,
      4,
      cv.LINE_8,
    );

    // Центр захваченного объекта отмечается зелёным крестиком.
    frame.drawLine(
      new cv.Point2(centerX - 10, centerY),
      new cv.Point2(centerX + 10, centerY),
      this.colors.green,
      2,
      cv.LINE_AA,
    );
    frame.drawLine(
      new cv.Point2(centerX, centerY - 10),
      new cv.Point2(centerX, centerY + 10),
      this.colors.green,
      2,
      cv.LINE_AA,
    );

    frame.drawLine(
      new cv.Point2(this.centerX, this.centerY),
      new cv.Point2(centerX, centerY),
      this.colors.green,
      2,
      cv.LINE_AA,
    );

    const idText = targetId == null ? 'TARGET' : `TARGET ID: ${targetId}`;
    frame.putText(
      idText,
      new cv.Point2(left, Math.max(28, top - 12)),
      cv.FONT_HERSHEY_SIMPLEX,
      0.75,
      this.colors.green,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `X:${centerX} Y:${centerY}`,
      new cv.Point2(left, Math.min(this.frameHeight - 10, bottom + 25)),
      cv.FONT_HERSHEY_SIMPLEX,
      0.55,
      this.colors.green,
      2,
      cv.LINE_AA,
    );
  }

  /** Рисует информационную панель. */
  drawStatus(frame, selection, ptzCommand, metadata) {
    const state = selection?.state ?? 'SEARCHING';
    const targetId = selection?.targetId ?? '-';
    const captureType = selection?.captureType ?? 'ALL_OBJECTS';
    const pan = ptzCommand?.pan ?? 'STOP';
    const tilt = ptzCommand?.tilt ?? 'STOP';
    const errorX = Math.round(ptzCommand?.errorX ?? 0);
    const errorY = Math.round(ptzCommand?.errorY ?? 0);

    frame.drawRectangle(
      new cv.Point2(10, 10),
      new cv.Point2(430, 225),
      this.colors.black,
      -1,
      cv.LINE_8,
    );

    const stateColor =
      state === 'TRACKING'
        ? this.colors.green
        : state === 'TEMPORARILY_LOST'
          ? this.colors.orange
          : this.colors.white;

    const rows = [
      [`Frame: ${metadata.number ?? 0}`, this.colors.white],
      [`State: ${state}`, stateColor],
      [
        `Target ID: ${targetId}`,
        targetId === '-' ? this.colors.white : this.colors.green,
      ],
      [`Capture: ${captureType}`, this.colors.red],
      [`PAN: ${pan}  TILT: ${tilt}`, this.colors.white],
      [`Error: X=${errorX} Y=${errorY}`, this.colors.white],
      ['PTZ: CONSOLE MODE', this.colors.yellow],
    ];

    rows.forEach(([text, color], index) => {
      frame.putText(
        text,
        new cv.Point2(20, 35 + index * 29),
        cv.FONT_HERSHEY_SIMPLEX,
        index === 6 ? 0.52 : 0.58,
        color,
        index === 6 ? 1 : 2,
        cv.LINE_AA,
      );
    });
  }
}

module.exports = FrameRenderer;
