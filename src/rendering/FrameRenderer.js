'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Накладывает служебную графику поверх видеокадра.
 *
 * Цвета:
 * - красный — обнаруженное движение;
 * - зелёный — объект, сопровождаемый CSRT;
 * - голубой — зоны управления PTZ;
 * - жёлтый — центр изображения;
 * - белый — служебный текст.
 */
class FrameRenderer {
  constructor({
    frameWidth,
    frameHeight,
    deadZoneX = 100,
    deadZoneY = 70,
    captureRadius = 180,
  }) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;

    this.centerX = Math.round(frameWidth / 2);

    this.centerY = Math.round(frameHeight / 2);

    this.deadZoneX = deadZoneX;
    this.deadZoneY = deadZoneY;
    this.captureRadius = captureRadius;

    /**
     * OpenCV использует порядок каналов BGR.
     */
    this.colors = {
      red: new cv.Vec3(0, 0, 255),
      green: new cv.Vec3(0, 255, 0),
      cyan: new cv.Vec3(255, 255, 0),
      white: new cv.Vec3(255, 255, 255),
      yellow: new cv.Vec3(0, 255, 255),
      black: new cv.Vec3(0, 0, 0),
      orange: new cv.Vec3(0, 165, 255),
    };
  }

  /**
   * Рисует все визуальные элементы.
   */
  render({
    frame,
    detections = [],
    selection,
    trackedRect = null,
    ptzCommand,
    metadata = {},
  }) {
    this.drawControlZones(frame);

    /**
     * Сначала рисуем детекции, чтобы рамка CSRT затем оказалась
     * поверх них и хорошо выделялась.
     */
    this.drawDetections(frame, detections);

    this.drawTrackedTarget(frame, trackedRect, selection?.targetCenter ?? null);

    this.drawStatus(frame, selection, ptzCommand, metadata);

    return frame;
  }

  /**
   * Рисует круг захвата, мёртвую зону PTZ и центр изображения.
   */
  drawControlZones(frame) {
    frame.drawCircle(
      new cv.Point2(this.centerX, this.centerY),
      this.captureRadius,
      this.colors.cyan,
      1,
      cv.LINE_AA,
    );

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
      2,
      cv.LINE_8,
    );

    frame.drawCircle(
      new cv.Point2(this.centerX, this.centerY),
      5,
      this.colors.yellow,
      -1,
    );
  }

  /**
   * Рисует все области, найденные детектором движения.
   *
   * Эти рамки не являются результатом CSRT и поэтому отображаются
   * тонкими красными линиями.
   */
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

      frame.putText(
        'MOTION',
        new cv.Point2(detection.x, Math.max(20, detection.y - 7)),
        cv.FONT_HERSHEY_SIMPLEX,
        0.45,
        this.colors.red,
        1,
        cv.LINE_AA,
      );
    }
  }

  /**
   * Рисует объект, реально сопровождаемый CSRT.
   *
   * @param {object} frame OpenCV Mat.
   * @param {object|null} trackedRect Текущий прямоугольник CSRT.
   * @param {{x:number,y:number}|null} targetCenter Центр цели.
   */
  drawTrackedTarget(frame, trackedRect, targetCenter) {
    if (!trackedRect || !targetCenter) {
      return;
    }

    const left = Math.round(trackedRect.x);

    const top = Math.round(trackedRect.y);

    const right = Math.round(trackedRect.x + trackedRect.width);

    const bottom = Math.round(trackedRect.y + trackedRect.height);

    const centerX = Math.round(targetCenter.x);

    const centerY = Math.round(targetCenter.y);

    /**
     * Основная толстая зелёная рамка сопровождения.
     */
    frame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(right, bottom),
      this.colors.green,
      4,
      cv.LINE_8,
    );

    /**
     * Центр сопровождаемого объекта.
     */
    frame.drawCircle(
      new cv.Point2(centerX, centerY),
      7,
      this.colors.green,
      -1,
      cv.LINE_AA,
    );

    /**
     * Линия ошибки от центра изображения до центра цели.
     *
     * Она визуально показывает, почему формируется конкретная
     * команда PAN/TILT.
     */
    frame.drawLine(
      new cv.Point2(this.centerX, this.centerY),
      new cv.Point2(centerX, centerY),
      this.colors.green,
      2,
      cv.LINE_AA,
    );

    /**
     * Название алгоритма сопровождения.
     */
    frame.putText(
      'CSRT TARGET',
      new cv.Point2(left, Math.max(28, top - 12)),
      cv.FONT_HERSHEY_SIMPLEX,
      0.75,
      this.colors.green,
      2,
      cv.LINE_AA,
    );

    /**
     * Координаты центра цели.
     */
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

  /**
   * Рисует информационную панель.
   */
  drawStatus(frame, selection, ptzCommand, metadata) {
    const state = selection?.state ?? 'SEARCHING';

    const pan = ptzCommand?.pan ?? 'STOP';

    const tilt = ptzCommand?.tilt ?? 'STOP';

    const errorX = Math.round(ptzCommand?.errorX ?? 0);

    const errorY = Math.round(ptzCommand?.errorY ?? 0);

    /**
     * Тёмная подложка повышает читаемость текста
     * на светлом или пёстром видео.
     */
    frame.drawRectangle(
      new cv.Point2(10, 10),
      new cv.Point2(365, 190),
      this.colors.black,
      -1,
      cv.LINE_8,
    );

    frame.putText(
      `Frame: ${metadata.number ?? 0}`,
      new cv.Point2(20, 35),
      cv.FONT_HERSHEY_SIMPLEX,
      0.62,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    const stateColor =
      state === 'TRACKING'
        ? this.colors.green
        : state === 'TEMPORARILY_LOST'
          ? this.colors.orange
          : this.colors.white;

    frame.putText(
      `State: ${state}`,
      new cv.Point2(20, 65),
      cv.FONT_HERSHEY_SIMPLEX,
      0.62,
      stateColor,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `PAN: ${pan}`,
      new cv.Point2(20, 95),
      cv.FONT_HERSHEY_SIMPLEX,
      0.62,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `TILT: ${tilt}`,
      new cv.Point2(20, 125),
      cv.FONT_HERSHEY_SIMPLEX,
      0.62,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `Error: X=${errorX} Y=${errorY}`,
      new cv.Point2(20, 155),
      cv.FONT_HERSHEY_SIMPLEX,
      0.57,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      'PTZ: CONSOLE MODE',
      new cv.Point2(20, 182),
      cv.FONT_HERSHEY_SIMPLEX,
      0.52,
      this.colors.yellow,
      1,
      cv.LINE_AA,
    );
  }
}

module.exports = FrameRenderer;
