'use strict';

/**
 * Подготавливает стартовую рамку трекера.
 *
 * Детекция MotionDetector описывает видимый объект максимально плотно.
 * Для маленькой цели такая рамка слишком чувствительна к межкадровому
 * смещению камеры. AdaptiveTrackerBox добавляет контекст вокруг цели,
 * сохраняя её центр и не выходя за границы кадра.
 *
 * Модуль не зависит от KCF, ROI, MotionDetector и CameraDriver.
 */
class AdaptiveTrackerBox {
  constructor(options = {}) {
    this.updateConfiguration(options);
  }

  updateConfiguration(options = {}) {
    this.enabled = options.enabled !== false;

    this.minWidth = AdaptiveTrackerBox.#positiveInteger(
      options.minWidth,
      64,
    );
    this.minHeight = AdaptiveTrackerBox.#positiveInteger(
      options.minHeight,
      64,
    );

    this.smallTargetMaxSize = AdaptiveTrackerBox.#positiveNumber(
      options.smallTargetMaxSize,
      64,
    );
    this.mediumTargetMaxSize = AdaptiveTrackerBox.#positiveNumber(
      options.mediumTargetMaxSize,
      120,
    );
    this.largeTargetMaxSize = AdaptiveTrackerBox.#positiveNumber(
      options.largeTargetMaxSize,
      240,
    );

    this.smallPaddingRatio = AdaptiveTrackerBox.#ratio(
      options.smallPaddingRatio,
      0.60,
    );
    this.mediumPaddingRatio = AdaptiveTrackerBox.#ratio(
      options.mediumPaddingRatio,
      0.35,
    );
    this.largePaddingRatio = AdaptiveTrackerBox.#ratio(
      options.largePaddingRatio,
      0.15,
    );
    this.hugePaddingRatio = AdaptiveTrackerBox.#ratio(
      options.hugePaddingRatio,
      0.05,
    );

    this.maxPaddingX = AdaptiveTrackerBox.#nonNegativeNumber(
      options.maxPaddingX,
      32,
    );
    this.maxPaddingY = AdaptiveTrackerBox.#nonNegativeNumber(
      options.maxPaddingY,
      32,
    );

    this.maxExpansionRatio = Math.max(
      1,
      AdaptiveTrackerBox.#positiveNumber(
        options.maxExpansionRatio,
        3.5,
      ),
    );

    return this.getConfiguration();
  }

  /**
   * Возвращает новую рамку с сохранёнными дополнительными полями детекции
   * (id, confidence и т. п.).
   */
  prepare(rect, frameWidth, frameHeight) {
    if (!AdaptiveTrackerBox.#validRect(rect)) {
      throw new TypeError(
        'AdaptiveTrackerBox.prepare(): некорректная исходная рамка',
      );
    }

    const safeFrameWidth = AdaptiveTrackerBox.#positiveInteger(
      frameWidth,
      1,
    );
    const safeFrameHeight = AdaptiveTrackerBox.#positiveInteger(
      frameHeight,
      1,
    );

    const source = {
      x: Number(rect.x),
      y: Number(rect.y),
      width: Number(rect.width),
      height: Number(rect.height),
    };

    if (!this.enabled) {
      return {
        ...rect,
        ...AdaptiveTrackerBox.#roundAndClamp(
          source,
          safeFrameWidth,
          safeFrameHeight,
        ),
        adaptiveTrackerBox: {
          applied: false,
          profile: 'DISABLED',
          sourceRect: source,
        },
      };
    }

    const profile = this.#selectProfile(source);
    const horizontalPadding = Math.min(
      this.maxPaddingX,
      source.width * profile.paddingRatio,
    );
    const verticalPadding = Math.min(
      this.maxPaddingY,
      source.height * profile.paddingRatio,
    );

    const desiredWidth = Math.max(
      this.minWidth,
      source.width + horizontalPadding * 2,
    );
    const desiredHeight = Math.max(
      this.minHeight,
      source.height + verticalPadding * 2,
    );

    const limitedWidth = Math.min(
      desiredWidth,
      source.width * this.maxExpansionRatio,
      safeFrameWidth,
    );
    const limitedHeight = Math.min(
      desiredHeight,
      source.height * this.maxExpansionRatio,
      safeFrameHeight,
    );

    const centerX = source.x + source.width / 2;
    const centerY = source.y + source.height / 2;

    const prepared = AdaptiveTrackerBox.#roundAndClamp(
      {
        x: centerX - limitedWidth / 2,
        y: centerY - limitedHeight / 2,
        width: limitedWidth,
        height: limitedHeight,
      },
      safeFrameWidth,
      safeFrameHeight,
    );

    return {
      ...rect,
      ...prepared,
      adaptiveTrackerBox: {
        applied:
          prepared.width !== Math.round(source.width) ||
          prepared.height !== Math.round(source.height),
        profile: profile.name,
        paddingRatio: profile.paddingRatio,
        sourceRect: {
          x: Math.round(source.x),
          y: Math.round(source.y),
          width: Math.round(source.width),
          height: Math.round(source.height),
        },
        preparedRect: { ...prepared },
      },
    };
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      minWidth: this.minWidth,
      minHeight: this.minHeight,
      smallTargetMaxSize: this.smallTargetMaxSize,
      mediumTargetMaxSize: this.mediumTargetMaxSize,
      largeTargetMaxSize: this.largeTargetMaxSize,
      smallPaddingRatio: this.smallPaddingRatio,
      mediumPaddingRatio: this.mediumPaddingRatio,
      largePaddingRatio: this.largePaddingRatio,
      hugePaddingRatio: this.hugePaddingRatio,
      maxPaddingX: this.maxPaddingX,
      maxPaddingY: this.maxPaddingY,
      maxExpansionRatio: this.maxExpansionRatio,
    };
  }

  #selectProfile(rect) {
    const size = Math.max(rect.width, rect.height);

    if (size <= this.smallTargetMaxSize) {
      return {
        name: 'SMALL',
        paddingRatio: this.smallPaddingRatio,
      };
    }

    if (size <= this.mediumTargetMaxSize) {
      return {
        name: 'MEDIUM',
        paddingRatio: this.mediumPaddingRatio,
      };
    }

    if (size <= this.largeTargetMaxSize) {
      return {
        name: 'LARGE',
        paddingRatio: this.largePaddingRatio,
      };
    }

    return {
      name: 'HUGE',
      paddingRatio: this.hugePaddingRatio,
    };
  }

  static #roundAndClamp(rect, frameWidth, frameHeight) {
    const width = Math.max(
      1,
      Math.min(frameWidth, Math.round(rect.width)),
    );
    const height = Math.max(
      1,
      Math.min(frameHeight, Math.round(rect.height)),
    );

    const x = Math.max(
      0,
      Math.min(frameWidth - width, Math.round(rect.x)),
    );
    const y = Math.max(
      0,
      Math.min(frameHeight - height, Math.round(rect.y)),
    );

    return { x, y, width, height };
  }

  static #validRect(rect) {
    return Boolean(
      rect &&
      Number.isFinite(Number(rect.x)) &&
      Number.isFinite(Number(rect.y)) &&
      Number.isFinite(Number(rect.width)) &&
      Number.isFinite(Number(rect.height)) &&
      Number(rect.width) > 0 &&
      Number(rect.height) > 0
    );
  }

  static #positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? number
      : fallback;
  }

  static #nonNegativeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? number
      : fallback;
  }

  static #positiveInteger(value, fallback) {
    return Math.max(
      1,
      Math.round(
        AdaptiveTrackerBox.#positiveNumber(value, fallback),
      ),
    );
  }

  static #ratio(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(2, Math.max(0, number))
      : fallback;
  }
}

module.exports = AdaptiveTrackerBox;
