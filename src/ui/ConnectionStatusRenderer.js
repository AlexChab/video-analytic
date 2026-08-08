'use strict';

const cv = require('@u4/opencv4nodejs');

/**
 * Отображает состояние RTSP-потока только в UI OpenCV.
 *
 * Класс никогда не передаёт служебные изображения в MotionDetector,
 * DetectionStabilizer, Tracker, PTZ или LatestFrameBuffer.
 */
class ConnectionStatusRenderer {
  constructor({ width, height }) {
    this.width = ConnectionStatusRenderer.#normalizeSize(width, 1280);
    this.height = ConnectionStatusRenderer.#normalizeSize(height, 720);

    this.colors = {
      background: new cv.Vec3(20, 22, 26),
      panel: new cv.Vec3(31, 35, 42),
      white: new cv.Vec3(235, 235, 235),
      muted: new cv.Vec3(155, 165, 175),
      yellow: new cv.Vec3(0, 210, 255),
      red: new cv.Vec3(40, 55, 235),
      green: new cv.Vec3(70, 210, 90),
      border: new cv.Vec3(75, 82, 92),
    };

    /*
     * Mat.zeros() используется вместо перегрузки new cv.Mat(..., fillValue),
     * которая в Node.js 22 + @u4/opencv4nodejs может ошибочно выбрать
     * конструктор Mat(Buffer) и аварийно завершить процесс.
     */
    this.waitingFrame = cv.Mat.zeros(
      this.height,
      this.width,
      cv.CV_8UC3,
    );

    /** Один раз созданная копия последнего живого кадра с UI-плашкой. */
    this.frozenFrame = null;

    /** Ключ состояния, уже нарисованного на frozenFrame. */
    this.frozenStatusKey = null;
  }

  static #normalizeSize(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
      return fallback;
    }

    return Math.max(1, Math.round(number));
  }

  /** Маскирует логин и пароль в RTSP URL. */
  static maskSource(source) {
    const value = String(source ?? 'not configured');

    try {
      const url = new URL(value);

      if (url.username) url.username = '***';
      if (url.password) url.password = '***';

      return url.toString();
    } catch {
      return value.replace(/:\/\/([^:@/]+):([^@/]+)@/u, '://***:***@');
    }
  }

  /** Ограничивает длинную строку шириной панели. */
  static shorten(value, maximumLength = 92) {
    const text = String(value ?? '');

    return text.length <= maximumLength
      ? text
      : `${text.slice(0, maximumLength - 3)}...`;
  }

  /** Форматирует возраст последнего кадра. */
  static formatAge(milliseconds) {
    if (milliseconds === null || milliseconds === undefined) {
      return 'never received';
    }

    if (milliseconds < 1000) {
      return `${Math.round(milliseconds)} ms ago`;
    }

    return `${(milliseconds / 1000).toFixed(1)} s ago`;
  }

  /**
   * Полноэкранный экран используется только до получения первого кадра.
   */
  renderWaiting({
    source,
    attempt,
    retryInMs,
    ffmpegRunning,
    ptzEnabled,
  }) {
    this.waitingFrame.setTo(this.colors.background);

    const panelWidth = Math.min(this.width - 80, 1180);
    const panelHeight = Math.min(this.height - 80, 500);
    const left = Math.round((this.width - panelWidth) / 2);
    const top = Math.round((this.height - panelHeight) / 2);
    const right = left + panelWidth;
    const bottom = top + panelHeight;

    this.waitingFrame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(right, bottom),
      this.colors.panel,
      -1,
      cv.LINE_8,
    );

    this.waitingFrame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(right, bottom),
      this.colors.border,
      2,
      cv.LINE_8,
    );

    this.waitingFrame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(left + 12, bottom),
      this.colors.yellow,
      -1,
      cv.LINE_8,
    );

    const textLeft = left + 55;
    let y = top + 88;

    this.waitingFrame.putText(
      'NO VIDEO STREAM',
      new cv.Point2(textLeft, y),
      cv.FONT_HERSHEY_SIMPLEX,
      1.35,
      this.colors.yellow,
      3,
      cv.LINE_AA,
    );

    y += 58;

    this.waitingFrame.putText(
      'Waiting for RTSP source',
      new cv.Point2(textLeft, y),
      cv.FONT_HERSHEY_SIMPLEX,
      0.78,
      this.colors.white,
      2,
      cv.LINE_AA,
    );

    y += 62;

    const retryText =
      retryInMs === null
        ? 'restart: watchdog active'
        : `next restart: ${(retryInMs / 1000).toFixed(1)} s`;

    const rows = [
      `SOURCE: ${ConnectionStatusRenderer.shorten(
        ConnectionStatusRenderer.maskSource(source),
      )}`,
      `FFMPEG: ${
        ffmpegRunning
          ? 'RUNNING / WAITING FOR DATA'
          : 'STOPPED / RESTARTING'
      }`,
      `START ATTEMPT: ${Math.max(1, Number(attempt) || 1)}   ${retryText}`,
      `PTZ: ${ptzEnabled ? 'IDLE - NO FRAME COMMANDS' : 'DISABLED'}`,
    ];

    for (const row of rows) {
      this.waitingFrame.putText(
        row,
        new cv.Point2(textLeft, y),
        cv.FONT_HERSHEY_SIMPLEX,
        0.56,
        this.colors.muted,
        1,
        cv.LINE_AA,
      );

      y += 42;
    }

    this.waitingFrame.putText(
      'ESC - shutdown application',
      new cv.Point2(textLeft, bottom - 35),
      cv.FONT_HERSHEY_SIMPLEX,
      0.52,
      this.colors.green,
      1,
      cv.LINE_AA,
    );

    return this.waitingFrame;
  }

  /**
   * Возвращает стоп-кадр с компактной плашкой потери потока.
   *
   * liveFrame клонируется только при первом вызове после потери потока.
   * Последующие вызовы переиспользуют frozenFrame и не копируют Full HD Mat.
   */
  renderFrozen(liveFrame, status) {
    if (!liveFrame || typeof liveFrame.copy !== 'function') {
      return this.renderWaiting(status);
    }

    const statusKey = JSON.stringify({
      source: status.source,
      attempt: status.attempt,
      retryBucket:
        status.retryInMs === null
          ? null
          : Math.ceil(status.retryInMs / 500),
      ageBucket:
        status.lastFrameAgeMs === null
          ? null
          : Math.floor(status.lastFrameAgeMs / 500),
      ffmpegRunning: status.ffmpegRunning,
      ptzEnabled: status.ptzEnabled,
    });

    if (!this.frozenFrame) {
      /*
       * Единственная копия рабочего кадра создаётся в момент потери потока.
       * Это не происходит в режиме LIVE и не влияет на FPS аналитики.
       */
      this.frozenFrame = liveFrame.copy();
      this.frozenStatusKey = null;
    }

    if (this.frozenStatusKey === statusKey) {
      return this.frozenFrame;
    }

    /*
     * Плашка обновляется поверх уже замороженного Mat. Чтобы старый текст не
     * наслаивался, компактная область сначала закрашивается заново.
     */
    const margin = Math.max(16, Math.round(this.width * 0.012));
    const panelWidth = Math.min(
      this.width - margin * 2,
      Math.max(520, Math.round(this.width * 0.43)),
    );
    const panelHeight = 118;
    const left = margin;
    const top = margin;
    const right = left + panelWidth;
    const bottom = top + panelHeight;

    this.frozenFrame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(right, bottom),
      this.colors.panel,
      -1,
      cv.LINE_8,
    );

    this.frozenFrame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(right, bottom),
      this.colors.red,
      2,
      cv.LINE_8,
    );

    this.frozenFrame.drawRectangle(
      new cv.Point2(left, top),
      new cv.Point2(left + 9, bottom),
      this.colors.red,
      -1,
      cv.LINE_8,
    );

    this.frozenFrame.putText(
      'VIDEO STREAM LOST - RECONNECTING',
      new cv.Point2(left + 27, top + 39),
      cv.FONT_HERSHEY_SIMPLEX,
      0.64,
      this.colors.red,
      2,
      cv.LINE_AA,
    );

    const ageText = ConnectionStatusRenderer.formatAge(
      status.lastFrameAgeMs,
    );

    const retryText =
      status.retryInMs === null
        ? 'watchdog active'
        : `retry ${(status.retryInMs / 1000).toFixed(1)} s`;

    this.frozenFrame.putText(
      `Last frame: ${ageText}   ${retryText}   PTZ: ${
        status.ptzEnabled ? 'STOP / HOLD' : 'DISABLED'
      }`,
      new cv.Point2(left + 27, top + 78),
      cv.FONT_HERSHEY_SIMPLEX,
      0.49,
      this.colors.white,
      1,
      cv.LINE_AA,
    );

    this.frozenFrame.putText(
      `FFmpeg: ${
        status.ffmpegRunning ? 'waiting for data' : 'restarting'
      }   attempt: ${Math.max(1, Number(status.attempt) || 1)}`,
      new cv.Point2(left + 27, top + 103),
      cv.FONT_HERSHEY_SIMPLEX,
      0.43,
      this.colors.muted,
      1,
      cv.LINE_AA,
    );

    this.frozenStatusKey = statusKey;

    return this.frozenFrame;
  }

  /**
   * Вызывается при появлении свежего кадра после обрыва.
   */
  clearFrozenFrame() {
    if (
      this.frozenFrame &&
      typeof this.frozenFrame.delete === 'function'
    ) {
      this.frozenFrame.delete();
    }

    this.frozenFrame = null;
    this.frozenStatusKey = null;
  }

  /** Освобождает только Mat, которыми владеет данный renderer. */
  dispose() {
    this.clearFrozenFrame();

    if (
      this.waitingFrame &&
      typeof this.waitingFrame.delete === 'function'
    ) {
      this.waitingFrame.delete();
    }

    this.waitingFrame = null;
  }
}

module.exports = ConnectionStatusRenderer;
