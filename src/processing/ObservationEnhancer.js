'use strict';

const cv = require('@u4/opencv4nodejs');
const { performance } = require('node:perf_hooks');

/**
 * Создаёт отдельный визуальный кадр для оператора.
 *
 * Аналитический кадр не изменяется. Даже режим ORIGINAL возвращает copy(),
 * чтобы Renderer и последующие визуальные фильтры не могли затронуть Mat,
 * который использовался MotionDetector/KCF/PTZ.
 */
class ObservationEnhancer {
  static MODES = Object.freeze([
    'ORIGINAL',
    'CLAHE',
    'CLAHE_SHARPEN',
  ]);

  constructor(options = {}) {
    this.clahe = null;
    this.lastProcessingMs = 0;
    this.lastError = null;
    this.updateConfiguration(options);
  }

  updateConfiguration(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'enabled')) {
      this.enabled = ObservationEnhancer.#boolean(
        options.enabled,
        false,
      );
    } else if (this.enabled === undefined) {
      this.enabled = false;
    }

    if (Object.prototype.hasOwnProperty.call(options, 'mode')) {
      this.mode = ObservationEnhancer.#normalizeMode(options.mode);
    } else if (!this.mode) {
      this.mode = 'ORIGINAL';
    }

    this.claheClipLimit = ObservationEnhancer.#number(
      options.claheClipLimit ?? this.claheClipLimit,
      1.7,
      0.1,
      20,
    );

    this.claheTileSize = ObservationEnhancer.#integer(
      options.claheTileSize ?? this.claheTileSize,
      8,
      2,
      32,
    );

    this.sharpenAmount = ObservationEnhancer.#number(
      options.sharpenAmount ?? this.sharpenAmount,
      0.10,
      0,
      2,
    );

    this.showHud = ObservationEnhancer.#boolean(
      options.showHud ?? this.showHud,
      true,
    );

    this.#rebuildClahe();
    return this.getStatus();
  }

  setEnabled(enabled) {
    this.enabled = ObservationEnhancer.#boolean(enabled, false);
    return this.getStatus();
  }

  setMode(mode) {
    this.mode = ObservationEnhancer.#normalizeMode(mode);

    /*
     * Выбор ORIGINAL не выключает сам модуль: оператор может переключаться
     * между режимами одной группой кнопок. enabled=false является отдельным
     * аварийным выключателем визуальной ветки.
     */
    return this.getStatus();
  }

  setClahe(options = {}) {
    this.claheClipLimit = ObservationEnhancer.#number(
      options.clipLimit ?? options.claheClipLimit,
      this.claheClipLimit,
      0.1,
      20,
    );
    this.claheTileSize = ObservationEnhancer.#integer(
      options.tileSize ?? options.claheTileSize,
      this.claheTileSize,
      2,
      32,
    );
    this.#rebuildClahe();
    return this.getStatus();
  }

  setSharpen(options = {}) {
    this.sharpenAmount = ObservationEnhancer.#number(
      options.amount ?? options.sharpenAmount,
      this.sharpenAmount,
      0,
      2,
    );
    return this.getStatus();
  }

  /**
   * Возвращает Mat, предназначенный только для Renderer/OpenCV preview.
   */
  process(frame) {
    if (!frame) {
      throw new Error('ObservationEnhancer.process требует cv.Mat');
    }

    const startedAt = performance.now();
    let displayFrame = null;

    try {
      if (!this.enabled || this.mode === 'ORIGINAL') {
        displayFrame = frame.copy();
      } else {
        displayFrame = this.#applyClahe(frame);

        if (this.mode === 'CLAHE_SHARPEN') {
          displayFrame = this.#applySharpen(displayFrame);
        }
      }

      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;

      /*
       * Визуальный фильтр никогда не должен останавливать аналитику.
       * При любой ошибке показываем безопасную копию исходного кадра.
       */
      displayFrame = frame.copy();
    }

    this.lastProcessingMs = performance.now() - startedAt;

    if (this.showHud) {
      this.#drawHud(displayFrame);
    }

    return displayFrame;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      availableModes: [...ObservationEnhancer.MODES],
      analyticsInput: 'ORIGINAL',
      displayOnly: true,
      clahe: {
        clipLimit: this.claheClipLimit,
        tileSize: this.claheTileSize,
      },
      sharpen: {
        amount: this.sharpenAmount,
      },
      showHud: this.showHud,
      lastProcessingMs: Number(this.lastProcessingMs.toFixed(2)),
      lastError: this.lastError,
    };
  }

  #applyClahe(frame) {
    /*
     * Минимальный и предсказуемый этап:
     * BGR -> GRAY -> CLAHE -> BGR.
     *
     * Цвет намеренно не используется как источник решения оператора в этом
     * режиме: цель — увидеть устойчивую структуру, контур и локальный контраст.
     * Позже можно добавить отдельный COLOR_CLAHE профиль.
     */
    const gray = frame.channels === 1
      ? frame.copy()
      : frame.cvtColor(cv.COLOR_BGR2GRAY);

    let enhancedGray;

    try {
      enhancedGray = this.clahe
        ? this.clahe.apply(gray)
        : gray.equalizeHist();
    } catch {
      enhancedGray = gray.equalizeHist();
    }

    return enhancedGray.cvtColor(cv.COLOR_GRAY2BGR);
  }

  #applySharpen(frame) {
    if (this.sharpenAmount <= 0) {
      return frame;
    }

    const blurred = frame.gaussianBlur(new cv.Size(3, 3), 0);

    return frame.addWeighted(
      1 + this.sharpenAmount,
      blurred,
      -this.sharpenAmount,
      0,
    );
  }

  #drawHud(frame) {
    if (!frame || typeof frame.putText !== 'function') return;

    const activeMode = this.enabled ? this.mode : 'ORIGINAL';
    const line1 = `VIEW: ${activeMode}`;
    const line2 = 'ANALYTICS: ORIGINAL';
    const line3 = `ENHANCE: ${this.lastProcessingMs.toFixed(1)} ms`;

    try {
      frame.drawRectangle(
        new cv.Point2(8, 8),
        new cv.Point2(280, 76),
        new cv.Vec3(15, 15, 15),
        -1,
        cv.LINE_8,
      );

      [line1, line2, line3].forEach((line, index) => {
        frame.putText(
          line,
          new cv.Point2(16, 28 + index * 20),
          cv.FONT_HERSHEY_SIMPLEX,
          0.48,
          new cv.Vec3(235, 235, 235),
          1,
          cv.LINE_AA,
        );
      });
    } catch {
      // HUD необязателен и не должен влиять на основной кадр.
    }
  }

  #rebuildClahe() {
    this.clahe = null;

    try {
      if (typeof cv.CLAHE === 'function') {
        this.clahe = new cv.CLAHE(
          this.claheClipLimit,
          new cv.Size(this.claheTileSize, this.claheTileSize),
        );
      }
    } catch {
      this.clahe = null;
    }
  }

  static #normalizeMode(value) {
    const mode = String(value ?? 'ORIGINAL').trim().toUpperCase();

    if (!ObservationEnhancer.MODES.includes(mode)) {
      throw new Error(
        `Неизвестный режим наблюдения: ${mode}. ` +
        `Допустимые режимы: ${ObservationEnhancer.MODES.join(', ')}.`,
      );
    }

    return mode;
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
    return Math.round(
      ObservationEnhancer.#number(value, fallback, min, max),
    );
  }
}

module.exports = ObservationEnhancer;
