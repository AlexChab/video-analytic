'use strict';

/**
 * Стабилизирует поток прямоугольных обнаружений между видеокадрами.
 *
 * Класс не выполняет поиск движения и не рисует рамки. Его задача —
 * подтвердить новые обнаружения, сопоставить их с предыдущими, сгладить
 * координаты и кратковременно удерживать рамку, если детектор пропустил кадр.
 *
 * Входной объект должен содержать как минимум:
 * { x, y, width, height }
 */
class DetectionStabilizer {
  constructor(options = {}) {
    this.nextTrackId = 1;
    this.tracks = new Map();
    this.updateConfiguration(options, { initial: true });
  }

  /**
   * Применяет параметры без сброса текущих рамок.
   * Это позволяет менять время удержания и сглаживание через ProfileManager.
   */
  updateConfiguration(options = {}, { initial = false } = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('DetectionStabilizer требует объект конфигурации');
    }

    const previous = initial ? null : this.getConfiguration();

    this.enabled = this.#readBoolean(options.enabled, true);
    this.confirmFrames = this.#readInteger(options.confirmFrames, 2, 1);
    this.holdTimeMs = this.#readNumber(options.holdTimeMs, 600, 0);
    this.maxLostFrames = this.#readInteger(options.maxLostFrames, 15, 0);
    this.maxCenterDistance = this.#readNumber(
      options.maxCenterDistance,
      120,
      0,
    );
    this.minIou = Math.min(
      1,
      this.#readNumber(options.minIou, 0.05, 0),
    );
    this.smoothingFactor = Math.min(
      1,
      this.#readNumber(options.smoothingFactor, 0.35, 0),
    );

    const current = this.getConfiguration();
    if (!initial && previous) {
      const changed = Object.keys(current).filter(
        (key) => previous[key] !== current[key],
      );
      if (changed.length > 0) {
        const details = changed
          .map((key) => `${key}: ${previous[key]} → ${current[key]}`)
          .join('; ');
        console.log(`[DetectionStabilizer] Конфигурация обновлена: ${details}`);
      }
    }

    return current;
  }

  getConfiguration() {
    return {
      enabled: this.enabled,
      confirmFrames: this.confirmFrames,
      holdTimeMs: this.holdTimeMs,
      maxLostFrames: this.maxLostFrames,
      maxCenterDistance: this.maxCenterDistance,
      minIou: this.minIou,
      smoothingFactor: this.smoothingFactor,
    };
  }

  /**
   * Принимает сырые обнаружения текущего кадра и возвращает стабильные рамки.
   *
   * @param {Array<object>} detections
   * @param {number} [timestamp=Date.now()]
   * @returns {Array<object>}
   */
  update(detections, timestamp = Date.now()) {
    if (!Array.isArray(detections)) {
      throw new TypeError('DetectionStabilizer.update ожидает массив detections');
    }

    if (!this.enabled) {
      return detections.map((detection) => ({ ...detection }));
    }

    const now = Number.isFinite(Number(timestamp))
      ? Number(timestamp)
      : Date.now();
    const normalized = detections
      .filter((item) => this.#isValidBox(item))
      .map((item) => ({ ...item }));

    for (const track of this.tracks.values()) {
      track.matched = false;
    }

    const candidates = [];
    normalized.forEach((detection, detectionIndex) => {
      for (const track of this.tracks.values()) {
        const distance = this.#centerDistance(detection, track.box);
        const iou = this.#iou(detection, track.box);

        // Совпадение допускается либо по пересечению, либо по близости центров.
        if (iou >= this.minIou || distance <= this.maxCenterDistance) {
          candidates.push({
            detectionIndex,
            trackId: track.id,
            distance,
            iou,
          });
        }
      }
    });

    // Сначала выбираем наиболее пересекающиеся рамки, затем самые близкие.
    candidates.sort((a, b) => b.iou - a.iou || a.distance - b.distance);

    const usedDetections = new Set();
    const usedTracks = new Set();

    for (const candidate of candidates) {
      if (
        usedDetections.has(candidate.detectionIndex) ||
        usedTracks.has(candidate.trackId)
      ) {
        continue;
      }

      const track = this.tracks.get(candidate.trackId);
      const detection = normalized[candidate.detectionIndex];
      if (!track || !detection) continue;

      track.box = this.#smoothBox(track.box, detection);
      track.lastDetection = { ...detection };
      track.lastSeenAt = now;
      track.seenFrames += 1;
      track.lostFrames = 0;
      track.matched = true;
      track.confirmed = track.confirmed || track.seenFrames >= this.confirmFrames;

      usedDetections.add(candidate.detectionIndex);
      usedTracks.add(candidate.trackId);
    }

    // Для рамок, не совпавших с существующими, создаём кандидатов.
    normalized.forEach((detection, detectionIndex) => {
      if (usedDetections.has(detectionIndex)) return;

      const id = this.nextTrackId++;
      this.tracks.set(id, {
        id,
        box: { ...detection },
        lastDetection: { ...detection },
        firstSeenAt: now,
        lastSeenAt: now,
        seenFrames: 1,
        lostFrames: 0,
        matched: true,
        confirmed: this.confirmFrames <= 1,
      });
    });

    // Ненайденные рамки переводим в кратковременное состояние удержания.
    for (const [id, track] of this.tracks.entries()) {
      if (track.matched) continue;

      track.lostFrames += 1;
      const ageSinceSeen = now - track.lastSeenAt;
      const expiredByTime = ageSinceSeen > this.holdTimeMs;
      const expiredByFrames = track.lostFrames > this.maxLostFrames;

      // Неподтверждённый шум не удерживаем после первого же пропуска.
      if (!track.confirmed || expiredByTime || expiredByFrames) {
        this.tracks.delete(id);
      }
    }

    return Array.from(this.tracks.values())
      .filter((track) => track.confirmed)
      .map((track) => ({
        ...track.lastDetection,
        ...this.#roundBox(track.box),
        stabilizerState: track.matched ? 'DETECTED' : 'COASTING',
        stabilizerLostFrames: track.lostFrames,
        stabilizerAgeMs: Math.max(0, now - track.firstSeenAt),
      }));
  }

  reset() {
    this.tracks.clear();
    this.nextTrackId = 1;
  }

  #smoothBox(previous, current) {
    const alpha = this.smoothingFactor;
    const mix = (oldValue, newValue) => oldValue + (newValue - oldValue) * alpha;

    return {
      x: mix(previous.x, current.x),
      y: mix(previous.y, current.y),
      width: Math.max(1, mix(previous.width, current.width)),
      height: Math.max(1, mix(previous.height, current.height)),
    };
  }

  #roundBox(box) {
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width,
      height,
      centerX: Math.round(box.x + width / 2),
      centerY: Math.round(box.y + height / 2),
      area: width * height,
    };
  }

  #centerDistance(first, second) {
    const firstX = first.x + first.width / 2;
    const firstY = first.y + first.height / 2;
    const secondX = second.x + second.width / 2;
    const secondY = second.y + second.height / 2;
    return Math.hypot(firstX - secondX, firstY - secondY);
  }

  #iou(first, second) {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersectionWidth = Math.max(0, right - left);
    const intersectionHeight = Math.max(0, bottom - top);
    const intersection = intersectionWidth * intersectionHeight;
    if (intersection <= 0) return 0;

    const firstArea = first.width * first.height;
    const secondArea = second.width * second.height;
    const union = firstArea + secondArea - intersection;
    return union > 0 ? intersection / union : 0;
  }

  #isValidBox(item) {
    return Boolean(
      item &&
        Number.isFinite(Number(item.x)) &&
        Number.isFinite(Number(item.y)) &&
        Number(item.width) > 0 &&
        Number(item.height) > 0,
    );
  }

  #readBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }

  #readInteger(value, fallback, minimum) {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.max(minimum, Math.trunc(parsed))
      : fallback;
  }

  #readNumber(value, fallback, minimum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
  }
}

module.exports = DetectionStabilizer;
