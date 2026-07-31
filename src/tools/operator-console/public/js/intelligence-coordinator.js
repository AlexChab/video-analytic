/**
 * Клиентская заготовка TargetIntelligenceCoordinator.
 * Она демонстрирует единый жизненный цикл источников данных и не выполняет реальные
 * запросы к AI/AIS/Radar/ГАБ. Для интеграции достаточно заменить обработчики источников.
 */
export class TargetIntelligenceCoordinator {
  constructor({ onUpdate }) {
    this.onUpdate = onUpdate;
    this.runId = 0;
    this.timers = new Set();
    this.sources = [];
  }

  /** Запускает автоматическое обогащение выбранной цели. */
  start(target) {
    this.cancel();
    const runId = ++this.runId;

    this.sources = [
      this.createSource('ai', 'AI-классификация'),
      this.createSource('geolocation', 'Геопривязка'),
      this.createSource('radar', 'Radar'),
      this.createSource('ais', 'AIS'),
      this.createSource('sonar', 'ГАБ / Sonar')
    ];
    this.emit(target);

    // Временные имитаторы показывают поведение интерфейса до подключения реальных систем.
    this.defer(runId, 550, () => this.resolve('geolocation', 'ready', 'Азимут ожидает PTZ'));
    this.defer(runId, 900, () => this.resolve('ai', 'ready', 'Источник не подключён'));
    this.defer(runId, 1250, () => this.resolve('radar', 'not_found', 'Совпадений нет'));
    this.defer(runId, 1550, () => this.resolve('ais', 'not_found', 'Совпадений нет'));
    this.defer(runId, 1850, () => this.resolve('sonar', 'not_found', 'Совпадений нет'));

    return this.sources;
  }

  createSource(id, name) {
    return {
      id,
      name,
      state: 'pending',
      value: 'Запрос данных…',
      updatedAt: Date.now()
    };
  }

  resolve(sourceId, state, value) {
    const source = this.sources.find((item) => item.id === sourceId);
    if (!source) return;
    source.state = state;
    source.value = value;
    source.updatedAt = Date.now();
    this.emit();
  }

  defer(runId, delayMs, callback) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (runId === this.runId) callback();
    }, delayMs);
    this.timers.add(timer);
  }

  emit(target = null) {
    this.onUpdate(this.sources.map((source) => ({ ...source })), target);
  }

  cancel() {
    this.runId += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.sources = [];
    this.emit();
  }
}
