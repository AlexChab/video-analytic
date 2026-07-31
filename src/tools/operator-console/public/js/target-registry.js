import { getObjectId, normalizeBox } from './renderer.js';

/**
 * Локальная клиентская заготовка TargetRegistry.
 * Сейчас реестр хранит только активную цель Operator Console. Позже этот контракт можно
 * заменить серверным реестром, не меняя остальную логику интерфейса.
 */
export class TargetRegistry {
  constructor() {
    this.activeTarget = null;
  }

  /** Создаёт активную цель из объекта Motion/Tracking API. */
  activate(object, framePoint = null) {
    const box = normalizeBox(object || {});
    const id = getObjectId(object);
    const center = framePoint || {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2)
    };

    this.activeTarget = {
      targetId: id,
      state: 'SELECTED',
      source: 'motion-detector',
      selectedAt: Date.now(),
      updatedAt: Date.now(),
      frame: {
        x: center.x,
        y: center.y,
        boundingBox: box
      },
      intelligence: {}
    };

    return this.activeTarget;
  }

  /** Обновляет геометрию активной цели по свежему объекту Tracking API. */
  updateFromObject(object) {
    if (!this.activeTarget || !object) return this.activeTarget;
    const box = normalizeBox(object);
    this.activeTarget.frame.boundingBox = box;
    this.activeTarget.frame.x = Math.round(box.x + box.width / 2);
    this.activeTarget.frame.y = Math.round(box.y + box.height / 2);
    this.activeTarget.updatedAt = Date.now();
    return this.activeTarget;
  }

  setState(nextState) {
    if (!this.activeTarget) return null;
    this.activeTarget.state = nextState;
    this.activeTarget.updatedAt = Date.now();
    return this.activeTarget;
  }

  setIntelligence(sourceId, data) {
    if (!this.activeTarget) return null;
    this.activeTarget.intelligence[sourceId] = { ...data };
    this.activeTarget.updatedAt = Date.now();
    return this.activeTarget;
  }

  clear(finalState = 'CANCELLED') {
    const previous = this.activeTarget;
    if (previous) previous.state = finalState;
    this.activeTarget = null;
    return previous;
  }

  getActive() {
    return this.activeTarget;
  }
}
