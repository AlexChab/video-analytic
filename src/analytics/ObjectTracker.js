'use strict';


const logger = require('../utils/Logger');
const cv = require('@u4/opencv4nodejs');

/**
 * Обёртка над OpenCV-трекером одиночного объекта.
 *
 * Основной режим работы:
 * 1. MotionDetector или TargetSelector обнаруживает объект.
 * 2. Метод start() получает первый кадр и прямоугольник объекта.
 * 3. На последующих кадрах вызывается update().
 * 4. Если сопровождение потеряно, update() возвращает null.
 */
class ObjectTracker {
  /**
   * @param {Object} [options] Настройки трекера.
   * @param {"CSRT"|"KCF"|"MIL"} [options.type="CSRT"]
   * Тип алгоритма сопровождения.
   *
   * @param {number} [options.minWidth=8]
   * Минимально допустимая ширина области объекта.
   *
   * @param {number} [options.minHeight=8]
   * Минимально допустимая высота области объекта.
   *
   * @param {number} [options.maxConsecutiveErrors=3]
   * Сколько последовательных ошибок допускается до полного сброса трекера.
   *
   * @param {boolean} [options.debug=false]
   * Выводить ли диагностические сообщения.
   */
  constructor(options = {}) {
    this.type = String(options.type ?? 'CSRT').toUpperCase();

    this.minWidth = this.#toPositiveInteger(options.minWidth, 8);
    this.minHeight = this.#toPositiveInteger(options.minHeight, 8);

    this.maxConsecutiveErrors = this.#toPositiveInteger(
      options.maxConsecutiveErrors,
      3,
    );

    this.debug = Boolean(options.debug);

    /**
     * Нативный экземпляр OpenCV Tracker.
     *
     * Он создаётся непосредственно перед init(), потому что после потери
     * объекта или повторной инициализации старый экземпляр лучше не
     * использовать.
     *
     * @type {Object|null}
     */
    this.tracker = null;

    /**
     * Последний успешно полученный прямоугольник цели.
     *
     * @type {import("@u4/opencv4nodejs").Rect|null}
     */
    this.rect = null;

    /**
     * Признак активного сопровождения.
     *
     * @type {boolean}
     */
    this.active = false;

    /**
     * Количество последовательных исключений или некорректных результатов.
     *
     * @type {number}
     */
    this.consecutiveErrors = 0;

    /**
     * Счётчик обработанных кадров после запуска сопровождения.
     *
     * @type {number}
     */
    this.frameCount = 0;

    /**
     * Текст последней причины остановки сопровождения.
     *
     * @type {string|null}
     */
    this.lastStopReason = null;

    // Проверяем наличие выбранного трекера сразу при создании класса.
    this.#validateTrackerAvailability();
  }

  /**
   * Начинает сопровождение объекта.
   *
   * @param {import("@u4/opencv4nodejs").Mat} frame
   * Первый кадр, на котором объект уже обнаружен.
   *
   * @param {import("@u4/opencv4nodejs").Rect|Object} roi
   * Область объекта:
   *   new cv.Rect(x, y, width, height)
   *
   * либо обычный объект:
   *   { x, y, width, height }
   *
   * @returns {import("@u4/opencv4nodejs").Rect}
   * Нормализованный прямоугольник, фактически переданный OpenCV.
   *
   * @throws {TypeError|RangeError|Error}
   * Выбрасывает ошибку при некорректном кадре, ROI или ошибке OpenCV.
   */
  start(frame, roi) {
    this.#validateFrame(frame);

    const normalizedRect = this.#normalizeRect(roi, frame.cols, frame.rows);

    // Повторный запуск всегда должен создавать новый нативный трекер.
    this.reset('Повторная инициализация');

    const tracker = this.#createTracker();

    try {
      /*
       * В используемой версии @u4/opencv4nodejs init() не обязан
       * возвращать boolean. Успешным считаем вызов без исключения.
       */
      tracker.init(frame, normalizedRect);
    } catch (error) {
      this.reset('Ошибка инициализации OpenCV-трекера');

      throw new Error(
        `Не удалось инициализировать ${this.type}-трекер: ` +
          `${this.#getErrorMessage(error)}`,
      );
    }

    this.tracker = tracker;
    this.rect = normalizedRect;
    this.active = true;
    this.consecutiveErrors = 0;
    this.frameCount = 0;
    this.lastStopReason = null;

    this.#log('Сопровождение запущено:', this.#rectToObject(this.rect));

    return this.#cloneRect(this.rect);
  }

  /**
   * Обновляет положение сопровождаемого объекта на новом кадре.
   *
   * @param {import("@u4/opencv4nodejs").Mat} frame
   * Новый кадр видеопотока.
   *
   * @returns {import("@u4/opencv4nodejs").Rect|null}
   * Новое положение объекта или null, если сопровождение неактивно/потеряно.
   */
  update(frame) {
    if (!this.active || !this.tracker) {
      return null;
    }

    this.#validateFrame(frame);
    this.frameCount += 1;

    let result;

    try {
      /*
       * В проверенной сборке update() возвращает непосредственно Rect:
       *
       * Rect { x, y, width, height }
       */
      result = this.tracker.update(frame);
    } catch (error) {
      this.#registerError(
        `Исключение update(): ${this.#getErrorMessage(error)}`,
      );

      return null;
    }

    const extractedRect = this.#extractRect(result);

    if (!extractedRect) {
      this.#registerError('OpenCV не вернул корректный прямоугольник цели');

      return null;
    }

    let normalizedRect;

    try {
      normalizedRect = this.#normalizeRect(
        extractedRect,
        frame.cols,
        frame.rows,
      );
    } catch (error) {
      this.#registerError(
        `Получена некорректная область цели: ` +
          `${this.#getErrorMessage(error)}`,
      );

      return null;
    }

    this.rect = normalizedRect;
    this.consecutiveErrors = 0;

    return this.#cloneRect(this.rect);
  }

  /**
   * Принудительно останавливает сопровождение и очищает состояние.
   *
   * @param {string} [reason="Ручной сброс"] Причина сброса.
   */
  reset(reason = 'Ручной сброс') {
    if (this.active || this.tracker) {
      this.#log(`Сопровождение остановлено: ${reason}`);
    }

    /*
     * У OpenCV Tracker в биндинге может отсутствовать явный метод release().
     * Удаление ссылки позволяет сборщику мусора освободить нативный объект.
     */
    this.tracker = null;
    this.rect = null;
    this.active = false;
    this.consecutiveErrors = 0;
    this.frameCount = 0;
    this.lastStopReason = reason;
  }

  /**
   * Возвращает признак активного сопровождения.
   *
   * @returns {boolean}
   */
  isActive() {
    return this.active;
  }

  /**
   * Возвращает последнюю известную область цели.
   *
   * Возвращается копия cv.Rect, чтобы внешний код не изменил внутреннее
   * состояние ObjectTracker.
   *
   * @returns {import("@u4/opencv4nodejs").Rect|null}
   */
  getRect() {
    return this.rect ? this.#cloneRect(this.rect) : null;
  }

  /**
   * Возвращает центр текущей области цели.
   *
   * Это удобно для вычисления ошибки PTZ относительно центра изображения.
   *
   * @returns {{x: number, y: number}|null}
   */
  getCenter() {
    if (!this.rect) {
      return null;
    }

    return {
      x: this.rect.x + this.rect.width / 2,
      y: this.rect.y + this.rect.height / 2,
    };
  }

  /**
   * Возвращает диагностическое состояние трекера.
   *
   * @returns {Object}
   */
  getState() {
    return {
      type: this.type,
      active: this.active,
      frameCount: this.frameCount,
      consecutiveErrors: this.consecutiveErrors,
      lastStopReason: this.lastStopReason,
      rect: this.rect ? this.#rectToObject(this.rect) : null,
      center: this.getCenter(),
    };
  }

  /**
   * Рисует рамку сопровождаемого объекта на кадре.
   *
   * Метод изменяет переданный Mat.
   *
   * @param {import("@u4/opencv4nodejs").Mat} frame
   * Кадр, на котором нужно нарисовать рамку.
   *
   * @param {Object} [options]
   * @param {import("@u4/opencv4nodejs").Vec} [options.color]
   * Цвет рамки в формате BGR.
   *
   * @param {number} [options.thickness=2]
   * Толщина линии.
   *
   * @returns {import("@u4/opencv4nodejs").Mat}
   */
  draw(frame, options = {}) {
    this.#validateFrame(frame);

    if (!this.rect) {
      return frame;
    }

    const color = options.color ?? new cv.Vec(0, 255, 0);
    const thickness = this.#toPositiveInteger(options.thickness, 2);

    const topLeft = new cv.Point2(this.rect.x, this.rect.y);

    const bottomRight = new cv.Point2(
      this.rect.x + this.rect.width,
      this.rect.y + this.rect.height,
    );

    frame.drawRectangle(topLeft, bottomRight, color, thickness, cv.LINE_8);

    return frame;
  }

  /**
   * Создаёт экземпляр выбранного алгоритма OpenCV.
   *
   * @returns {Object}
   */
  #createTracker() {
    switch (this.type) {
      case 'CSRT':
        return new cv.TrackerCSRT();

      case 'KCF':
        return new cv.TrackerKCF();

      case 'MIL':
        return new cv.TrackerMIL();

      default:
        throw new RangeError(
          `Неизвестный тип трекера "${this.type}". ` +
            'Допустимые значения: CSRT, KCF, MIL.',
        );
    }
  }

  /**
   * Проверяет, экспортирует ли текущая сборка opencv4nodejs нужный класс.
   */
  #validateTrackerAvailability() {
    const constructorName = `Tracker${this.type}`;
    const TrackerConstructor = cv[constructorName];

    if (typeof TrackerConstructor !== 'function') {
      throw new Error(
        `${constructorName} недоступен в текущей сборке OpenCV. ` +
          'Проверьте наличие модуля tracking из opencv_contrib.',
      );
    }
  }

  /**
   * Проверяет, что переданное значение является непустым cv.Mat.
   *
   * @param {import("@u4/opencv4nodejs").Mat} frame
   */
  #validateFrame(frame) {
    if (!frame || typeof frame !== 'object') {
      throw new TypeError('Кадр не передан или имеет неверный тип.');
    }

    if (typeof frame.rows !== 'number' || typeof frame.cols !== 'number') {
      throw new TypeError(
        'Кадр не похож на cv.Mat: отсутствуют rows или cols.',
      );
    }

    if (frame.rows <= 0 || frame.cols <= 0) {
      throw new RangeError(`Получен пустой кадр: ${frame.cols}x${frame.rows}.`);
    }

    /*
     * В разных версиях биндинга empty может быть методом или свойством.
     * Поэтому обрабатываем оба варианта.
     */
    if (typeof frame.empty === 'function' && frame.empty()) {
      throw new RangeError('Получен пустой cv.Mat.');
    }

    if (frame.empty === true) {
      throw new RangeError('Получен пустой cv.Mat.');
    }
  }

  /**
   * Приводит произвольный ROI к корректному cv.Rect и ограничивает его
   * размерами кадра.
   *
   * @param {Object} roi
   * @param {number} frameWidth
   * @param {number} frameHeight
   *
   * @returns {import("@u4/opencv4nodejs").Rect}
   */
  #normalizeRect(roi, frameWidth, frameHeight) {
    if (!roi || typeof roi !== 'object') {
      throw new TypeError('ROI не передан или имеет неверный тип.');
    }

    let x = Number(roi.x);
    let y = Number(roi.y);
    let width = Number(roi.width);
    let height = Number(roi.height);

    if (![x, y, width, height].every(Number.isFinite)) {
      throw new TypeError(
        'ROI должен содержать числовые x, y, width и height.',
      );
    }

    // OpenCV работает с целочисленными координатами прямоугольника.
    x = Math.round(x);
    y = Math.round(y);
    width = Math.round(width);
    height = Math.round(height);

    if (width <= 0 || height <= 0) {
      throw new RangeError(
        `Размер ROI должен быть положительным: ${width}x${height}.`,
      );
    }

    /*
     * Переводим прямоугольник в координаты двух границ.
     * Это позволяет корректно обработать ROI, частично выходящий за кадр.
     */
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(frameWidth, x + width);
    const bottom = Math.min(frameHeight, y + height);

    const clippedWidth = right - left;
    const clippedHeight = bottom - top;

    if (clippedWidth < this.minWidth || clippedHeight < this.minHeight) {
      throw new RangeError(
        `ROI после ограничения границами кадра слишком мал: ` +
          `${clippedWidth}x${clippedHeight}. Минимум: ` +
          `${this.minWidth}x${this.minHeight}.`,
      );
    }

    return new cv.Rect(left, top, clippedWidth, clippedHeight);
  }

  /**
   * Извлекает cv.Rect из результата tracker.update().
   *
   * Основной формат вашей сборки:
   *   Rect { x, y, width, height }
   *
   * Дополнительно поддерживаются распространённые варианты:
   *   { rect: Rect }
   *   { boundingBox: Rect }
   *   [success, Rect]
   *
   * @param {*} result
   * @returns {Object|null}
   */
  #extractRect(result) {
    if (!result) {
      return null;
    }

    // Основной вариант, подтверждённый вашим smoke-тестом.
    if (this.#looksLikeRect(result)) {
      return result;
    }

    if (this.#looksLikeRect(result.rect)) {
      return result.rect;
    }

    if (this.#looksLikeRect(result.boundingBox)) {
      return result.boundingBox;
    }

    if (Array.isArray(result)) {
      /*
       * Некоторые биндинги возвращают [success, rect].
       * При false сопровождение считается потерянным.
       */
      if (result.length >= 2 && result[0] === false) {
        return null;
      }

      const possibleRect = result.length >= 2 ? result[1] : result[0];

      if (this.#looksLikeRect(possibleRect)) {
        return possibleRect;
      }
    }

    return null;
  }

  /**
   * Проверяет, похож ли объект на прямоугольник OpenCV.
   *
   * @param {*} value
   * @returns {boolean}
   */
  #looksLikeRect(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      Number.isFinite(Number(value.x)) &&
      Number.isFinite(Number(value.y)) &&
      Number.isFinite(Number(value.width)) &&
      Number.isFinite(Number(value.height)),
    );
  }

  /**
   * Регистрирует ошибку обновления.
   *
   * После достижения лимита последовательных ошибок сопровождение полностью
   * сбрасывается.
   *
   * @param {string} reason
   */
  #registerError(reason) {
    this.consecutiveErrors += 1;

    this.#log(
      `Ошибка сопровождения ${this.consecutiveErrors}/` +
        `${this.maxConsecutiveErrors}: ${reason}`,
    );

    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.reset(reason);
    }
  }

  /**
   * Создаёт независимую копию cv.Rect.
   *
   * @param {import("@u4/opencv4nodejs").Rect} rect
   * @returns {import("@u4/opencv4nodejs").Rect}
   */
  #cloneRect(rect) {
    return new cv.Rect(rect.x, rect.y, rect.width, rect.height);
  }

  /**
   * Преобразует cv.Rect в простой JavaScript-объект.
   *
   * @param {import("@u4/opencv4nodejs").Rect} rect
   * @returns {{x:number, y:number, width:number, height:number}}
   */
  #rectToObject(rect) {
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Преобразует значение в положительное целое число.
   *
   * @param {*} value
   * @param {number} fallback
   * @returns {number}
   */
  #toPositiveInteger(value, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
      return fallback;
    }

    return Math.max(1, Math.round(number));
  }

  /**
   * Возвращает безопасный текст исключения.
   *
   * @param {*} error
   * @returns {string}
   */
  #getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  /**
   * Выводит диагностическое сообщение при включённом debug.
   *
   * @param {...*} args
   */
  #log(...args) {
    if (this.debug) {
      logger.info('[ObjectTracker]', ...args);
    }
  }
}

module.exports = ObjectTracker;
