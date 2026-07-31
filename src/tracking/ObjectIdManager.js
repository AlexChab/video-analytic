'use strict';

/**
 * Назначает обнаруженным объектам постоянные идентификаторы.
 *
 * Сопоставление выполняется по расстоянию между центрами рамок.
 * Если объект временно исчезает, его ID хранится ещё несколько кадров.
 */
class ObjectIdManager {
  constructor({ maxMatchDistance = 120, lostFrameLimit = 12 } = {}) {
    this.maxMatchDistance = maxMatchDistance;
    this.lostFrameLimit = lostFrameLimit;
    this.nextId = 1;
    this.tracks = new Map();
  }

  /**
   * Добавляет поле id ко всем входным detections.
   * Исходные объекты не изменяются — возвращается новый массив.
   */
  update(detections) {
    if (!Array.isArray(detections)) {
      throw new TypeError('ObjectIdManager.update ожидает массив detections');
    }

    // В начале кадра считаем все существующие треки ненайденными.
    for (const track of this.tracks.values()) {
      track.matched = false;
    }

    const result = detections.map((detection) => ({ ...detection }));
    const candidates = [];

    // Строим список всех допустимых пар detection ↔ track.
    result.forEach((detection, detectionIndex) => {
      const center = this.#getCenter(detection);

      for (const track of this.tracks.values()) {
        const distance = Math.hypot(center.x - track.center.x, center.y - track.center.y);
        if (distance <= this.maxMatchDistance) {
          candidates.push({ detectionIndex, trackId: track.id, distance });
        }
      }
    });

    // Сначала назначаем самые близкие пары, чтобы два объекта не получили один ID.
    candidates.sort((a, b) => a.distance - b.distance);
    const usedDetections = new Set();
    const usedTracks = new Set();

    for (const candidate of candidates) {
      if (usedDetections.has(candidate.detectionIndex) || usedTracks.has(candidate.trackId)) {
        continue;
      }

      const detection = result[candidate.detectionIndex];
      const track = this.tracks.get(candidate.trackId);
      if (!track) continue;

      detection.id = track.id;
      track.rect = { ...detection };
      track.center = this.#getCenter(detection);
      track.lostFrames = 0;
      track.matched = true;

      usedDetections.add(candidate.detectionIndex);
      usedTracks.add(candidate.trackId);
    }

    // Для новых объектов создаём новые ID.
    result.forEach((detection, detectionIndex) => {
      if (usedDetections.has(detectionIndex)) return;

      const id = this.nextId++;
      detection.id = id;
      this.tracks.set(id, {
        id,
        rect: { ...detection },
        center: this.#getCenter(detection),
        lostFrames: 0,
        matched: true,
      });
    });

    // Удаляем треки, которые слишком долго не появлялись.
    for (const [id, track] of this.tracks.entries()) {
      if (track.matched) continue;

      track.lostFrames += 1;
      if (track.lostFrames > this.lostFrameLimit) {
        this.tracks.delete(id);
      }
    }

    return result;
  }

  /** Обновляет параметры сопоставления объектов без сброса текущих ID. */
  updateConfiguration({ maxMatchDistance, lostFrameLimit } = {}) {
    if (Number.isFinite(Number(maxMatchDistance))) {
      this.maxMatchDistance = Math.max(0, Number(maxMatchDistance));
    }

    if (Number.isFinite(Number(lostFrameLimit))) {
      this.lostFrameLimit = Math.max(0, Math.trunc(Number(lostFrameLimit)));
    }

    return {
      maxMatchDistance: this.maxMatchDistance,
      lostFrameLimit: this.lostFrameLimit,
    };
  }

  reset() {
    this.nextId = 1;
    this.tracks.clear();
  }

  #getCenter(rect) {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  }
}

module.exports = ObjectIdManager;
