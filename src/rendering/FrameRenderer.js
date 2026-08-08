'use strict';

const cv = require('@u4/opencv4nodejs');
const ptzDiagnostics = require('../camera/PtzDiagnosticsStore');

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
    this.showTrackingModeHud = booleanOrCurrent(
      configuration.showTrackingModeHud,
      this.showTrackingModeHud,
      true,
    );
    this.ptzDebugHudEnabled = booleanOrCurrent(
      configuration.ptzDebugHudEnabled,
      this.ptzDebugHudEnabled,
      true,
    );
    this.captureDiagnosticsHudEnabled = booleanOrCurrent(
      configuration.captureDiagnosticsHudEnabled,
      this.captureDiagnosticsHudEnabled,
      true,
    );
    this.debugHudVisible = booleanOrCurrent(
      configuration.debugHudVisible,
      this.debugHudVisible,
      true,
    );

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
      showTrackingModeHud: this.showTrackingModeHud,
      ptzDebugHudEnabled: this.ptzDebugHudEnabled,
      captureDiagnosticsHudEnabled: this.captureDiagnosticsHudEnabled,
      debugHudVisible: this.debugHudVisible,
    };
  }

  /**
   * Глобальный переключатель большого технического HUD.
   *
   * F1 меняет только визуализацию. Детектор, KCF, PTZ и сбор диагностики
   * продолжают работать с прежними параметрами.
   */
  toggleDebugHud() {
    this.debugHudVisible = !this.debugHudVisible;
    return this.debugHudVisible;
  }

  setDebugHudVisible(visible) {
    this.debugHudVisible = Boolean(visible);
    return this.debugHudVisible;
  }

  isDebugHudVisible() {
    return this.debugHudVisible;
  }

  /** Рисует все визуальные элементы. */
  render({
    frame,
    detections = [],
    selection,
    trackedRect = null,
    ptzCommand,
    motionDiagnostics = null,
    metadata = {},
  }) {
    if (selection?.state === 'DETECTION_ONLY') {
      this.drawDetections(frame, detections);
      if (this.debugHudVisible) {
        this.drawMotionDiagnostics(frame, motionDiagnostics, 10, 10);
      }
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
    if (this.debugHudVisible) {
      this.drawStatus(
        frame,
        selection,
        ptzCommand,
        metadata,
        motionDiagnostics,
      );
    }

    return frame;
  }

  /**
   * Минимальный Motion Diagnostics HUD для режима DETECTION_ONLY, где
   * основной status HUD намеренно не рисуется.
   */
  drawMotionDiagnostics(frame, diagnostics, x = 10, y = 10) {
    if (!diagnostics?.enabled || !diagnostics?.hudEnabled) return;

    const f = diagnostics.frame ?? {};
    const r = f.rejected ?? {};
    const p = diagnostics.pipeline ?? {};

    frame.drawRectangle(
      new cv.Point2(x, y),
      new cv.Point2(Math.min(this.frameWidth - 10, x + 760), y + 92),
      this.colors.black,
      -1,
      cv.LINE_8,
    );

    const lines = [
      `MOTION contours=${f.contours ?? 0} raw=${p.rawAccepted ?? 0} ` +
        `stable=${p.stableAccepted ?? 0} ids=${p.objectsWithId ?? 0}`,
      `REJECT contour=${r.CONTOUR_AREA ?? 0} box=${r.BOX_AREA ?? 0} ` +
        `w=${r.WIDTH ?? 0} h=${r.HEIGHT ?? 0} asp=${r.ASPECT ?? 0} ` +
        `max=${r.MAX_AREA ?? 0}`,
      diagnostics.lastReject
        ? `LAST ${diagnostics.lastReject.reason} ` +
          `${Math.round(diagnostics.lastReject.width)}x` +
          `${Math.round(diagnostics.lastReject.height)} ` +
          `area=${Math.round(diagnostics.lastReject.area)}`
        : 'LAST -',
    ];

    lines.forEach((text, index) => {
      frame.putText(
        text,
        new cv.Point2(x + 10, y + 24 + index * 27),
        cv.FONT_HERSHEY_SIMPLEX,
        0.50,
        index === 0 ? this.colors.yellow : this.colors.orange,
        1,
        cv.LINE_AA,
      );
    });
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
  drawStatus(
    frame,
    selection,
    ptzCommand,
    metadata,
    motionDiagnostics = null,
  ) {
    const state = selection?.state ?? 'SEARCHING';
    const targetId = selection?.targetId ?? '-';
    const captureType = selection?.captureType ?? 'ALL_OBJECTS';
    const pan = ptzCommand?.pan ?? 'STOP';
    const tilt = ptzCommand?.tilt ?? 'STOP';
    const errorX = Math.round(ptzCommand?.errorX ?? 0);
    const errorY = Math.round(ptzCommand?.errorY ?? 0);
    const panSpeed = Number(ptzCommand?.panSpeed ?? 0);
    const tiltSpeed = Number(ptzCommand?.tiltSpeed ?? 0);
    const zoomLocked = Boolean(ptzCommand?.zoomLocked);
    const ptzMode = ptzCommand?.ptzMode ?? 'STOP';
    const fine = ptzCommand?.fineCentering ?? null;

    frame.drawRectangle(
      new cv.Point2(10, 10),
      new cv.Point2(
        790,
        (this.ptzDebugHudEnabled
          ? (this.showTrackingModeHud ? 510 : 390)
          : (this.showTrackingModeHud ? 375 : 255)) +
          (this.captureDiagnosticsHudEnabled ? 145 : 0) +
          (motionDiagnostics?.enabled && motionDiagnostics?.hudEnabled
            ? 85
            : 0),
      ),
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
      [
        `PAN: ${pan} ${panSpeed.toFixed(2)}  ` +
        `TILT: ${tilt} ${tiltSpeed.toFixed(2)}`,
        this.colors.white,
      ],
      [`Error: X=${errorX} Y=${errorY}`, this.colors.white],
      [
        fine
          ? `PTZ MODE: ${ptzMode}  ` +
            `STOP:${fine.stopErrorX}x${fine.stopErrorY}  ` +
            `ENTER:${fine.enterErrorX}x${fine.enterErrorY}`
          : `PTZ MODE: ${ptzMode}`,
        ptzMode === 'FINE'
          ? this.colors.green
          : this.colors.white,
      ],
      [
        zoomLocked
          ? 'ZOOM: LOCKED DURING TRACKING'
          : `ZOOM: ${ptzCommand?.zoom ?? 'STOP'}`,
        zoomLocked ? this.colors.orange : this.colors.yellow,
      ],
    ];

    if (this.ptzDebugHudEnabled) {
      const diagnostics = ptzDiagnostics.getSnapshot();
      const ctrl = diagnostics.controller ?? ptzCommand?.ptzDebug ?? {};
      const disp = diagnostics.dispatcher ?? {};
      const drv = diagnostics.driver ?? {};

      const raw = ctrl.raw ?? {};
      const stable = ctrl.stable ?? {};

      rows.push(
        [
          `PTZ RAW: ${raw.pan ?? '-'} ` +
          `${Number(raw.requestedPanSpeed ?? 0).toFixed(3)} / ` +
          `${raw.tilt ?? '-'} ` +
          `${Number(raw.requestedTiltSpeed ?? 0).toFixed(3)}`,
          this.colors.yellow,
        ],
        [
          `PTZ STABLE: ${stable.pan ?? '-'} ` +
          `${Number(stable.panSpeed ?? 0).toFixed(3)} / ` +
          `${stable.tilt ?? '-'} ` +
          `${Number(stable.tiltSpeed ?? 0).toFixed(3)}`,
          this.colors.cyan,
        ],
        [
          `DISPATCH: ${disp.stage ?? '-'} ` +
          `${disp.pan ?? '-'} ${Number(disp.panSpeed ?? 0).toFixed(3)} / ` +
          `${disp.tilt ?? '-'} ${Number(disp.tiltSpeed ?? 0).toFixed(3)}`,
          disp.stage === 'SENT'
            ? this.colors.green
            : this.colors.white,
        ],
        [
          `DRIVER: ${drv.stage ?? '-'} ${drv.driver ?? '-'} ` +
          `PAN=${drv.pan ?? '-'} RATE=` +
          `${Number(drv.panRate ?? 0).toFixed(3)} ` +
          `TILT=${drv.tilt ?? '-'} RATE=` +
          `${Number(drv.tiltRate ?? 0).toFixed(3)} ` +
          `${drv.dryRun ? 'DRY' : ''}`,
          drv.stage === 'DRY_RUN'
            ? this.colors.orange
            : this.colors.white,
        ],
      );
    }

    if (this.showTrackingModeHud) {
      const trackerState = selection?.trackerState ?? {};
      const roiState = trackerState.roi ?? {};
      const enhancement = trackerState.enhancement ?? {};
      const mode = selection?.trackingMode ?? trackerState.mode ?? 'STANDARD';
      const trackerType = trackerState.type ?? 'KCF';
      const roiRect = roiState.rect;
      const roiText = roiRect
        ? `${roiRect.width}x${roiRect.height}`
        : '-';
      const confidence = Number(trackerState.confidence);
      const scaleHealth = trackerState.scaleHealth ?? {};
      const scaleAreaRatio = Number(scaleHealth.areaRatio);
      const scaleState = scaleHealth.state ?? 'NO_DATA';

      rows.push(
        [`Tracking: ${mode} / ${trackerType}`, this.colors.green],
        [
          `ROI: ${roiText}  RECENTER: ${roiState.recenterCount ?? 0} ` +
          `CD:${roiState.cooldownRemaining ?? 0}`,
          this.colors.cyan,
        ],
        [
          `CLAHE:${enhancement.claheEnabled ? 'ON' : 'OFF'} ` +
          `G:${enhancement.gamma ?? '-'} CONF:` +
          `${Number.isFinite(confidence) ? confidence.toFixed(2) : '-'}`,
          Number.isFinite(confidence) && confidence < 0.35
            ? this.colors.orange
            : this.colors.white,
        ],
        [
          `SCALE: ${scaleState}  RATIO:` +
          `${Number.isFinite(scaleAreaRatio)
            ? scaleAreaRatio.toFixed(2)
            : '-'} ` +
          `MATCH:${scaleHealth.matchFrames ?? 0}/` +
          `${scaleHealth.confirmFrames ?? 0} AUTO:OFF`,
          ['GROWING', 'SHRINKING'].includes(scaleState)
            ? this.colors.orange
            : scaleState === 'STABLE'
              ? this.colors.green
              : this.colors.white,
        ],
      );
    }

    if (this.captureDiagnosticsHudEnabled) {
      const capture = selection?.captureDiagnostics ?? null;

      if (capture?.enabled) {
        const roi = capture.roi ?? {};
        const safe = roi.safeArea ?? {};
        const recenter = capture.lastRecenter ?? null;
        const attention = capture.attention ?? {};
        const event = capture.lastEvent ?? null;

        const attentionColor =
          attention.level === 'ERROR'
            ? this.colors.red
            : attention.level === 'WARN'
              ? this.colors.orange
              : attention.level === 'OK'
                ? this.colors.green
                : this.colors.white;

        rows.push(
          [
            `CAPTURE DBG: ID=${capture.targetId ?? '-'} ` +
            `DET=${capture.targetPresent ? 'YES' : 'NO'} ` +
            `KCF=${capture.trackerActive ? 'ON' : 'OFF'} ` +
            `RECT=${capture.trackerRectPresent ? 'YES' : 'NO'}`,
            capture.trackerRectPresent
              ? this.colors.green
              : this.colors.orange,
          ],
          [
            `SAFE: ${safe.outsideSafeArea ? 'OUT' : 'IN'} ` +
            `SIDE=${safe.side ?? '-'} ` +
            `OVER=${Number(safe.maxOverflowPx ?? 0).toFixed(1)}px ` +
            `WARN=${roi.warning ? 'YES' : 'NO'} ` +
            `${roi.warningFrames ?? 0}/${roi.recenterAfterWarningFrames ?? 0}`,
            safe.outsideSafeArea
              ? this.colors.orange
              : this.colors.green,
          ],
          [
            `RECENTERS: ${roi.recenterCount ?? 0}/` +
            `${Number(roi.maxRecenters ?? 0) === 0 ? 'INF' : roi.maxRecenters} ` +
            `CD=${roi.cooldownRemaining ?? 0} ` +
            (recenter
              ? `LAST=${recenter.effective ? 'OK' : 'INEFFECTIVE'} ` +
                `${Number(recenter.beforeOverflowPx ?? 0).toFixed(1)}->` +
                `${Number(recenter.afterOverflowPx ?? 0).toFixed(1)}px`
              : 'LAST=-'),
            recenter?.effective === false
              ? this.colors.red
              : this.colors.cyan,
          ],
          [
            `CAPTURE REASON: ${attention.reason ?? 'NO_DATA'}`,
            attentionColor,
          ],
          [
            event
              ? `LAST EVENT: ${event.from}->${event.to} ` +
                `(${event.reason ?? '-'})`
              : 'LAST EVENT: -',
            event ? this.colors.yellow : this.colors.white,
          ],
        );
      }
    }

    if (motionDiagnostics?.enabled && motionDiagnostics?.hudEnabled) {
      const motionFrame = motionDiagnostics.frame ?? {};
      const rejected = motionFrame.rejected ?? {};
      const pipeline = motionDiagnostics.pipeline ?? {};
      const lastReject = motionDiagnostics.lastReject ?? null;

      rows.push(
        [
          `MOTION: contours=${motionFrame.contours ?? 0} ` +
          `raw=${pipeline.rawAccepted ?? 0} ` +
          `stable=${pipeline.stableAccepted ?? 0} ` +
          `ids=${pipeline.objectsWithId ?? 0}`,
          this.colors.yellow,
        ],
        [
          `MOTION REJECT: contour=${rejected.CONTOUR_AREA ?? 0} ` +
          `box=${rejected.BOX_AREA ?? 0} ` +
          `w=${rejected.WIDTH ?? 0} h=${rejected.HEIGHT ?? 0} ` +
          `asp=${rejected.ASPECT ?? 0} max=${rejected.MAX_AREA ?? 0}`,
          this.colors.orange,
        ],
        [
          lastReject
            ? `LAST REJECT: ${lastReject.reason} ` +
              `${Math.round(lastReject.width)}x${Math.round(lastReject.height)} ` +
              `area=${Math.round(lastReject.area)} ` +
              `stage=${lastReject.stage}`
            : 'LAST REJECT: -',
          lastReject ? this.colors.orange : this.colors.white,
        ],
      );
    }

    rows.forEach(([text, color], index) => {
      frame.putText(
        text,
        new cv.Point2(20, 35 + index * 27),
        cv.FONT_HERSHEY_SIMPLEX,
        index === 6 ? 0.52 : index >= 7 ? 0.50 : 0.58,
        color,
        index === 6 || index >= 7 ? 1 : 2,
        cv.LINE_AA,
      );
    });
  }
}

module.exports = FrameRenderer;
