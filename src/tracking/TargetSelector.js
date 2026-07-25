/**
 * Выбирает и сопровождает одну цель среди обнаруженных объектов.
 *
 * Этот класс не управляет камерой и не работает с OpenCV.
 * Он получает обычные JavaScript-объекты с координатами рамок.
 *
 * Состояния:
 * - SEARCHING — ожидаем объект возле центра кадра;
 * - TRACKING — цель захвачена;
 * - LOST — цель временно потеряна.
 */
class TargetSelector {
  /**
   * @param {object} options
   * @param {number} options.frameWidth Ширина кадра.
   * @param {number} options.frameHeight Высота кадра.
   * @param {number} [options.captureRadius=180]
   * Радиус зоны первоначального захвата возле центра кадра.
   * @param {number} [options.maxMatchDistance=250]
   * Максимальное перемещение цели между кадрами.
   * @param {number} [options.lostFrameLimit=15]
   * Количество кадров, после которого цель считается потерянной.
   */
  constructor({
    frameWidth,
    frameHeight,
    captureRadius = 180,
    maxMatchDistance = 250,
    lostFrameLimit = 15,
  }) {
    this.frameCenter = {
      x: frameWidth / 2,
      y: frameHeight / 2,
    };

    this.captureRadius = captureRadius;
    this.maxMatchDistance = maxMatchDistance;
    this.lostFrameLimit = lostFrameLimit;

    this.state = 'SEARCHING';
    this.target = null;
    this.targetCenter = null;
    this.lostFrames = 0;
  }

  /**
   * Обновляет состояние выбранной цели.
   *
   * @param {Array<object>} detections Найденные объекты.
   * @returns {{
   *   state: string,
   *   target: object|null,
   *   targetCenter: object|null,
   *   justCaptured: boolean,
   *   justLost: boolean
   * }}
   */
  update(detections) {
    if (!Array.isArray(detections)) {
      throw new TypeError('TargetSelector.update ожидает массив detections');
    }

    if (this.state === 'SEARCHING') {
      return this.searchTarget(detections);
    }

    return this.trackTarget(detections);
  }

  /**
   * Ищет объект, попавший в центральную зону захвата.
   */
  searchTarget(detections) {
    let candidate = null;
    let candidateDistance = Number.POSITIVE_INFINITY;

    for (const detection of detections) {
      const center = this.getCenter(detection);
      const distance = this.getDistance(center, this.frameCenter);

      if (distance <= this.captureRadius && distance < candidateDistance) {
        candidate = detection;
        candidateDistance = distance;
      }
    }

    if (!candidate) {
      return this.createResult({
        justCaptured: false,
        justLost: false,
      });
    }

    this.state = 'TRACKING';
    this.target = candidate;
    this.targetCenter = this.getCenter(candidate);
    this.lostFrames = 0;

    return this.createResult({
      justCaptured: true,
      justLost: false,
    });
  }

  /**
   * Ищет объект, ближайший к предыдущему положению цели.
   */
  trackTarget(detections) {
    let bestMatch = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const detection of detections) {
      const center = this.getCenter(detection);
      const distance = this.getDistance(center, this.targetCenter);

      if (distance <= this.maxMatchDistance && distance < bestDistance) {
        bestMatch = detection;
        bestDistance = distance;
      }
    }

    if (bestMatch) {
      this.state = 'TRACKING';
      this.target = bestMatch;
      this.targetCenter = this.getCenter(bestMatch);
      this.lostFrames = 0;

      return this.createResult({
        justCaptured: false,
        justLost: false,
      });
    }

    this.lostFrames += 1;
    this.state = 'LOST';

    if (this.lostFrames < this.lostFrameLimit) {
      return this.createResult({
        justCaptured: false,
        justLost: false,
      });
    }

    const previousTarget = this.target;

    this.reset();

    return {
      state: this.state,
      target: null,
      previousTarget,
      targetCenter: null,
      justCaptured: false,
      justLost: true,
    };
  }

  /**
   * Возвращает центр прямоугольника объекта.
   */
  getCenter(detection) {
    return {
      x: detection.x + detection.width / 2,
      y: detection.y + detection.height / 2,
    };
  }

  /**
   * Вычисляет расстояние между точками.
   */
  getDistance(pointA, pointB) {
    return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
  }

  createResult({ justCaptured, justLost }) {
    return {
      state: this.state,
      target: this.target,
      targetCenter: this.targetCenter,
      justCaptured,
      justLost,
    };
  }

  /**
   * Сбрасывает текущую цель.
   */
  reset() {
    this.state = 'SEARCHING';
    this.target = null;
    this.targetCenter = null;
    this.lostFrames = 0;
  }
}

module.exports = TargetSelector;
