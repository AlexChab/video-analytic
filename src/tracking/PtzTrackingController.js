const logger = require('../utils/Logger');
/**
 * Контроллер автоматического сопровождения объекта PTZ-камерой.
 *
 * На текущем этапе реальные команды камере не отправляются.
 * Рассчитанные команды выводятся в консоль.
 *
 * Алгоритм:
 * 1. ожидает появления объекта рядом с центром кадра;
 * 2. захватывает этот объект;
 * 3. сопоставляет его с объектом на следующем кадре;
 * 4. вычисляет отклонение центра объекта от центра кадра;
 * 5. формирует команды LEFT, RIGHT, UP, DOWN или STOP.
 */
class PtzTrackingController {
  /**
   * @param {object} options
   * @param {number} options.frameWidth Ширина видеокадра.
   * @param {number} options.frameHeight Высота видеокадра.
   * @param {number} [options.captureRadius=180]
   * Максимальное расстояние от центра кадра,
   * при котором объект можно автоматически захватить.
   *
   * @param {number} [options.deadZoneX=100]
   * Половина ширины мёртвой зоны по горизонтали.
   *
   * @param {number} [options.deadZoneY=70]
   * Половина высоты мёртвой зоны по вертикали.
   *
   * @param {number} [options.maxMatchDistance=250]
   * Максимальное расстояние между предыдущим и новым положением объекта.
   *
   * @param {number} [options.lostFrameLimit=15]
   * Сколько кадров допускается не видеть объект до потери захвата.
   *
   * @param {number} [options.commandIntervalMs=300]
   * Минимальный интервал между повторными выводами PTZ-команд.
   */
  constructor({
    frameWidth,
    frameHeight,
    captureRadius = 180,
    deadZoneX = 100,
    deadZoneY = 70,
    maxMatchDistance = 250,
    lostFrameLimit = 15,
    commandIntervalMs = 300,
  }) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;

    this.frameCenter = {
      x: frameWidth / 2,
      y: frameHeight / 2,
    };

    this.captureRadius = captureRadius;
    this.deadZoneX = deadZoneX;
    this.deadZoneY = deadZoneY;
    this.maxMatchDistance = maxMatchDistance;
    this.lostFrameLimit = lostFrameLimit;
    this.commandIntervalMs = commandIntervalMs;

    /**
     * Возможные состояния:
     *
     * SEARCHING — ожидаем цель возле центра;
     * TRACKING  — сопровождаем захваченную цель;
     * LOST      — цель временно не обнаружена.
     */
    this.state = 'SEARCHING';

    /**
     * Последнее известное положение центра цели.
     */
    this.targetCenter = null;

    /**
     * Последний прямоугольник цели.
     */
    this.targetDetection = null;

    /**
     * Число кадров подряд, в которых цель отсутствовала.
     */
    this.lostFrames = 0;

    /**
     * Последняя отправленная или напечатанная команда.
     */
    this.lastCommand = null;
    this.lastCommandTime = 0;
  }

  /**
   * Обрабатывает список обнаруженных объектов.
   *
   * @param {Array<{
   *   x: number,
   *   y: number,
   *   width: number,
   *   height: number,
   *   area: number
   * }>} detections
   *
   * @returns {{
   *   state: string,
   *   target: object|null,
   *   targetCenter: object|null,
   *   command: object,
   *   errorX: number,
   *   errorY: number
   * }}
   */
  update(detections) {
    if (this.state === 'SEARCHING') {
      return this.handleSearching(detections);
    }

    return this.handleTracking(detections);
  }

  /**
   * В состоянии SEARCHING ищем объект,
   * который оказался возле центра кадра.
   */
  handleSearching(detections) {
    const candidate = this.findCaptureCandidate(detections);

    if (!candidate) {
      const command = this.createStopCommand();

      this.printCommand(command, {
        reason: 'ожидание объекта возле центра',
      });

      return this.createResult(command, 0, 0);
    }

    this.state = 'TRACKING';
    this.targetDetection = candidate;
    this.targetCenter = this.getDetectionCenter(candidate);
    this.lostFrames = 0;

    logger.info(
      '[Трекинг] Цель захвачена: ' +
        `x=${Math.round(this.targetCenter.x)}, ` +
        `y=${Math.round(this.targetCenter.y)}, ` +
        `площадь=${Math.round(candidate.area)}`,
    );

    return this.calculateTrackingCommand(candidate);
  }

  /**
   * В состоянии TRACKING ищем объект,
   * ближайший к его предыдущему положению.
   */
  handleTracking(detections) {
    const matchedTarget = this.findMatchingTarget(detections);

    if (!matchedTarget) {
      this.lostFrames += 1;
      this.state = 'LOST';

      const command = this.createStopCommand();

      this.printCommand(command, {
        reason:
          `цель временно потеряна ` +
          `(${this.lostFrames}/${this.lostFrameLimit})`,
      });

      if (this.lostFrames >= this.lostFrameLimit) {
        logger.info(
          '[Трекинг] Цель потеряна окончательно. Возвращаемся к поиску.',
        );

        this.reset();
      }

      return this.createResult(command, 0, 0);
    }

    if (this.state === 'LOST') {
      logger.info('[Трекинг] Цель снова обнаружена.');
    }

    this.state = 'TRACKING';
    this.targetDetection = matchedTarget;
    this.targetCenter = this.getDetectionCenter(matchedTarget);
    this.lostFrames = 0;

    return this.calculateTrackingCommand(matchedTarget);
  }

  /**
   * Ищет объект, который можно первоначально захватить.
   *
   * Выбирается объект, центр которого ближе всего
   * к центральной точке кадра.
   */
  findCaptureCandidate(detections) {
    let bestCandidate = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const detection of detections) {
      const center = this.getDetectionCenter(detection);

      const distance = this.getDistance(center, this.frameCenter);

      if (distance <= this.captureRadius && distance < bestDistance) {
        bestCandidate = detection;
        bestDistance = distance;
      }
    }

    return bestCandidate;
  }

  /**
   * Сопоставляет текущие обнаружения с уже захваченной целью.
   *
   * Пока применяется простой алгоритм:
   * выбирается объект, ближайший к предыдущей позиции цели.
   */
  findMatchingTarget(detections) {
    if (!this.targetCenter) {
      return null;
    }

    let bestMatch = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const detection of detections) {
      const center = this.getDetectionCenter(detection);

      const distance = this.getDistance(center, this.targetCenter);

      if (distance <= this.maxMatchDistance && distance < bestDistance) {
        bestMatch = detection;
        bestDistance = distance;
      }
    }

    return bestMatch;
  }

  /**
   * Вычисляет PTZ-команду по отклонению цели
   * от центральной точки кадра.
   */
  calculateTrackingCommand(detection) {
    const center = this.getDetectionCenter(detection);

    /**
     * Положительная ошибка X означает,
     * что объект находится правее центра.
     *
     * Положительная ошибка Y означает,
     * что объект находится ниже центра.
     */
    const errorX = center.x - this.frameCenter.x;
    const errorY = center.y - this.frameCenter.y;

    let pan = 'STOP';
    let tilt = 'STOP';

    if (errorX < -this.deadZoneX) {
      pan = 'LEFT';
    } else if (errorX > this.deadZoneX) {
      pan = 'RIGHT';
    }

    if (errorY < -this.deadZoneY) {
      tilt = 'UP';
    } else if (errorY > this.deadZoneY) {
      tilt = 'DOWN';
    }

    const command = {
      pan,
      tilt,
      moving: pan !== 'STOP' || tilt !== 'STOP',
    };

    this.printCommand(command, {
      errorX,
      errorY,
      targetX: center.x,
      targetY: center.y,
    });

    return this.createResult(command, errorX, errorY);
  }

  /**
   * Выводит команду с ограничением частоты.
   *
   * Одинаковая команда не будет печататься на каждом кадре,
   * иначе при 30 FPS консоль быстро переполнится.
   */
  printCommand(command, metadata = {}) {
    const commandKey = `${command.pan}:${command.tilt}`;
    const currentTime = Date.now();

    const commandChanged = commandKey !== this.lastCommand;
    const intervalElapsed =
      currentTime - this.lastCommandTime >= this.commandIntervalMs;

    if (!commandChanged && !intervalElapsed) {
      return;
    }

    const parts = [`[PTZ] PAN=${command.pan}`, `TILT=${command.tilt}`];

    if (Number.isFinite(metadata.errorX)) {
      parts.push(`errorX=${Math.round(metadata.errorX)}`);
    }

    if (Number.isFinite(metadata.errorY)) {
      parts.push(`errorY=${Math.round(metadata.errorY)}`);
    }

    if (metadata.reason) {
      parts.push(`причина="${metadata.reason}"`);
    }

    logger.info(parts.join(', '));

    this.lastCommand = commandKey;
    this.lastCommandTime = currentTime;
  }

  /**
   * Возвращает центральную точку прямоугольника объекта.
   */
  getDetectionCenter(detection) {
    return {
      x: detection.x + detection.width / 2,
      y: detection.y + detection.height / 2,
    };
  }

  /**
   * Вычисляет расстояние между двумя точками.
   */
  getDistance(pointA, pointB) {
    const deltaX = pointA.x - pointB.x;
    const deltaY = pointA.y - pointB.y;

    return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  }

  /**
   * Создаёт команду полной остановки PTZ.
   */
  createStopCommand() {
    return {
      pan: 'STOP',
      tilt: 'STOP',
      moving: false,
    };
  }

  /**
   * Формирует единый результат работы контроллера.
   */
  createResult(command, errorX, errorY) {
    return {
      state: this.state,
      target: this.targetDetection,
      targetCenter: this.targetCenter,
      command,
      errorX,
      errorY,
    };
  }

  /**
   * Полностью сбрасывает захват цели.
   */
  reset() {
    this.state = 'SEARCHING';
    this.targetCenter = null;
    this.targetDetection = null;
    this.lostFrames = 0;
  }
}

module.exports = PtzTrackingController;
