const cv = require('@u4/opencv4nodejs');

/**
 * Рисует служебную информацию поверх кадра.
 *
 * Этот класс ничего не знает про алгоритм детекции
 * и не рассчитывает PTZ-команды.
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

    // OpenCV использует порядок каналов BGR.
    this.colors = {
      red: new cv.Vec3(0, 0, 255),
      green: new cv.Vec3(0, 255, 0),
      cyan: new cv.Vec3(255, 255, 0),
      white: new cv.Vec3(255, 255, 255),
      yellow: new cv.Vec3(0, 255, 255),
    };
  }

  /**
   * Рисует все элементы поверх кадра.
   */
  render({ frame, detections, selection, ptzCommand, metadata = {} }) {
    this.drawControlZones(frame);
    this.drawDetections(frame, detections, selection);
    this.drawStatus(frame, selection, ptzCommand, metadata);

    return frame;
  }

  /**
   * Рисует центральную точку, мёртвую зону
   * и окружность первоначального захвата.
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
   * Рисует найденные объекты.
   *
   * Захваченная цель выделяется зелёным.
   * Остальные обнаружения рисуются красным.
   */
  drawDetections(frame, detections, selection) {
    for (const detection of detections) {
      const isTarget = selection.target === detection;

      const color = isTarget ? this.colors.green : this.colors.red;

      frame.drawRectangle(
        new cv.Point2(detection.x, detection.y),
        new cv.Point2(
          detection.x + detection.width,
          detection.y + detection.height,
        ),
        color,
        isTarget ? 4 : 2,
        cv.LINE_8,
      );

      if (!isTarget) {
        continue;
      }

      const targetX = Math.round(detection.x + detection.width / 2);

      const targetY = Math.round(detection.y + detection.height / 2);

      frame.drawCircle(new cv.Point2(targetX, targetY), 6, color, -1);

      frame.drawLine(
        new cv.Point2(this.centerX, this.centerY),
        new cv.Point2(targetX, targetY),
        color,
        2,
        cv.LINE_AA,
      );

      frame.putText(
        'TARGET',
        new cv.Point2(detection.x, Math.max(25, detection.y - 10)),
        cv.FONT_HERSHEY_SIMPLEX,
        0.7,
        color,
        2,
        cv.LINE_AA,
      );
    }
  }

  /**
   * Рисует номер кадра, состояние трекинга
   * и текущие команды PTZ.
   */
  drawStatus(frame, selection, ptzCommand, metadata) {
    frame.putText(
      `Frame: ${metadata.number ?? 0}`,
      new cv.Point2(20, 35),
      cv.FONT_HERSHEY_SIMPLEX,
      0.65,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `State: ${selection.state}`,
      new cv.Point2(20, 65),
      cv.FONT_HERSHEY_SIMPLEX,
      0.65,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `PAN: ${ptzCommand.pan}`,
      new cv.Point2(20, 95),
      cv.FONT_HERSHEY_SIMPLEX,
      0.65,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    frame.putText(
      `TILT: ${ptzCommand.tilt}`,
      new cv.Point2(20, 125),
      cv.FONT_HERSHEY_SIMPLEX,
      0.65,
      this.colors.white,
      2,
      cv.LINE_AA,
    );
  }
}

module.exports = FrameRenderer;
