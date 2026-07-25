const cv = require('@u4/opencv4nodejs');

/**
 * Обёртка над OpenCV CSRT Tracker.
 *
 * Назначение класса:
 * - инициализировать трекер по найденной области цели;
 * - сопровождать цель на последующих кадрах;
 * - возвращать актуальный прямоугольник цели;
 * - сбрасывать трекер при потере объекта.
 *
 * MotionDetector нужен только для первоначального обнаружения цели.
 * После захвата сопровождение выполняет CSRT.
 */
class ObjectTracker {
  constructor() {
    /**
     * Текущий экземпляр OpenCV-трекера.
     *
     * Пока цель не выбрана, трекер отсутствует.
     */
    this.tracker = null;

    /**
     * Признак активного сопровождения.
     */
    this.active = false;

    /**
     * Последняя известная область цели.
     *
     * Формат:
     * {
     *   x,
     *   y,
     *   width,
     *   height
     * }
     */
    this.lastBox = null;
  }

  /**
   * Запускает сопровождение новой цели.
   *
   * @param {import('@u4/opencv4nodejs').Mat} frame
   * Кадр OpenCV, на котором обнаружена цель.
   *
   * @param {{
   *   x: number,
   *   y: number,
   *   width: number,
   *   height: number
   * }} box
   * Начальная ограничивающая рамка цели.
   *
   * @returns {boolean}
   * true — трекер успешно инициализирован;
   * false — рамка некорректна или инициализация завершилась ошибкой.
   */
  initialize(frame, box) {
    if (!frame) {
      throw new TypeError('ObjectTracker.initialize ожидает кадр OpenCV');
    }

    if (!this.isValidBox(box)) {
      return false;
    }

    /**
     * Перед захватом новой цели полностью сбрасываем
     * предыдущее состояние.
     */
    this.reset();

    /**
     * CSRT создаётся заново для каждой новой цели.
     */
    // this.tracker = new cv.TrackerCSRT();
    this.tracker = cv.TrackerCSRT();

    /**
     * OpenCV ожидает прямоугольник cv.Rect.
     */
    const rectangle = new cv.Rect(
      Math.round(box.x),
      Math.round(box.y),
      Math.round(box.width),
      Math.round(box.height),
    );

    try {
      /**
       * В opencv4nodejs метод init может:
       * - вернуть boolean;
       * - ничего не вернуть при успешном выполнении;
       * - выбросить исключение при ошибке.
       */
      const initializationResult = this.tracker.init(frame, rectangle);

      if (initializationResult === false) {
        this.reset();
        return false;
      }

      this.active = true;
      this.lastBox = this.normalizeBox(box);

      return true;
    } catch (error) {
      console.error('[Tracker] Ошибка инициализации CSRT:', error.message);

      this.reset();

      return false;
    }
  }

  /**
   * Обновляет положение сопровождаемой цели.
   *
   * @param {import('@u4/opencv4nodejs').Mat} frame
   * Текущий кадр OpenCV.
   *
   * @returns {{
   *   success: boolean,
   *   box: null | {
   *     x: number,
   *     y: number,
   *     width: number,
   *     height: number
   *   }
   * }}
   */
  update(frame) {
    if (!this.active || !this.tracker) {
      return {
        success: false,
        box: null,
      };
    }

    try {
      /**
       * В разных версиях opencv4nodejs update()
       * может возвращать:
       *
       * 1. cv.Rect;
       * 2. объект вида { success, rect };
       * 3. объект вида { success, box }.
       *
       * Поэтому ниже поддерживаем несколько вариантов API.
       */
      const result = this.tracker.update(frame);

      const parsedResult = this.parseUpdateResult(result);

      if (!parsedResult.success || !this.isValidBox(parsedResult.box)) {
        this.reset();

        return {
          success: false,
          box: null,
        };
      }

      this.lastBox = this.normalizeBox(parsedResult.box);

      return {
        success: true,
        box: this.lastBox,
      };
    } catch (error) {
      console.error('[Tracker] Ошибка обновления CSRT:', error.message);

      this.reset();

      return {
        success: false,
        box: null,
      };
    }
  }

  /**
   * Преобразует результат Tracker.update()
   * к единому внутреннему формату.
   *
   * @param {*} result
   * @returns {{success: boolean, box: object|null}}
   */
  parseUpdateResult(result) {
    if (!result) {
      return {
        success: false,
        box: null,
      };
    }

    /**
     * Вариант: update() сразу вернул cv.Rect.
     */
    if (
      Number.isFinite(result.x) &&
      Number.isFinite(result.y) &&
      Number.isFinite(result.width) &&
      Number.isFinite(result.height)
    ) {
      return {
        success: true,
        box: result,
      };
    }

    /**
     * Вариант:
     * {
     *   success: true,
     *   rect: cv.Rect
     * }
     */
    if (result.rect) {
      return {
        success: result.success !== false,
        box: result.rect,
      };
    }

    /**
     * Вариант:
     * {
     *   success: true,
     *   box: cv.Rect
     * }
     */
    if (result.box) {
      return {
        success: result.success !== false,
        box: result.box,
      };
    }

    return {
      success: false,
      box: null,
    };
  }

  /**
   * Проверяет корректность прямоугольника цели.
   *
   * @param {*} box
   * @returns {boolean}
   */
  isValidBox(box) {
    return Boolean(
      box &&
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 1 &&
      box.height > 1,
    );
  }

  /**
   * Приводит координаты рамки к обычному объекту
   * с целочисленными значениями.
   *
   * @param {object} box
   * @returns {{
   *   x: number,
   *   y: number,
   *   width: number,
   *   height: number
   * }}
   */
  normalizeBox(box) {
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }

  /**
   * Возвращает центр последней известной рамки.
   *
   * Это удобно для расчёта ошибки PTZ.
   *
   * @returns {null | {x: number, y: number}}
   */
  getCenter() {
    if (!this.lastBox) {
      return null;
    }

    return {
      x: this.lastBox.x + this.lastBox.width / 2,

      y: this.lastBox.y + this.lastBox.height / 2,
    };
  }

  /**
   * Полностью прекращает сопровождение.
   */
  reset() {
    this.tracker = null;
    this.active = false;
    this.lastBox = null;
  }
}

module.exports = ObjectTracker;
