const elements = {
  connectionDot: document.querySelector('#connectionDot'),
  connectionText: document.querySelector('#connectionText'),
  apiAddress: document.querySelector('#apiAddress'),
  trackingState: document.querySelector('#trackingState'),
  targetId: document.querySelector('#targetId'),
  trackerType: document.querySelector('#trackerType'),
  trackingEnabled: document.querySelector('#trackingEnabled'),
  selectionMode: document.querySelector('#selectionMode'),
  diagnosticObjectCount: document.querySelector('#diagnosticObjectCount'),
  apiLatency: document.querySelector('#apiLatency'),
  lastUpdatedAt: document.querySelector('#lastUpdatedAt'),
  lastStatusCode: document.querySelector('#lastStatusCode'),
  rawJson: document.querySelector('#rawJson'),
  frameSizeText: document.querySelector('#frameSizeText'),
  pointerText: document.querySelector('#pointerText'),
  objectCountText: document.querySelector('#objectCountText'),
  canvasHint: document.querySelector('#canvasHint')
};

export function showConfig(config) {
  elements.apiAddress.textContent = config.trackingApi;
  elements.frameSizeText.textContent = `Кадр: ${config.frameWidth} × ${config.frameHeight}`;
}

export function showConnection(connected, message = '') {
  elements.connectionDot.className = `status-dot ${connected ? 'status-dot--online' : 'status-dot--offline'}`;
  elements.connectionText.textContent = message || (connected ? 'Tracking API доступен' : 'Tracking API недоступен');
}

/** Обновляет диагностическую карточку, не завязываясь на единственную форму ответа API. */
export function showDiagnostics({ status = {}, objectCount = 0, latencyMs = null, updatedAt = null, statusCode = null }) {
  const enabled = status?.enabled ?? status?.isEnabled ?? status?.trackingEnabled;
  const tracker = status?.tracker ?? status?.trackerType ?? status?.algorithm ?? status?.target?.tracker;

  elements.trackingState.textContent = status?.state ?? status?.status ?? '—';
  elements.targetId.textContent = status?.targetId ?? status?.selectedId ?? status?.target?.id ?? '—';
  elements.trackerType.textContent = tracker ?? '—';
  elements.trackingEnabled.textContent = enabled === undefined ? '—' : (enabled ? 'Да' : 'Нет');
  elements.diagnosticObjectCount.textContent = String(objectCount);
  elements.apiLatency.textContent = latencyMs === null ? '—' : `${latencyMs} мс`;
  elements.lastUpdatedAt.textContent = updatedAt ? updatedAt.toLocaleTimeString('ru-RU') : '—';
  elements.lastStatusCode.textContent = statusCode === null ? '—' : String(statusCode);
}

export function showRawJson(data) {
  elements.rawJson.textContent = JSON.stringify(data ?? {}, null, 2);
}

export function getRawJsonText() {
  return elements.rawJson.textContent;
}

export function showMode(mode) {
  elements.selectionMode.textContent = mode;
  elements.canvasHint.textContent = mode === 'POINT'
    ? 'Щёлкните по кадру, чтобы передать координату'
    : 'Щёлкните по рамке объекта, чтобы передать его ID';
}

export function showPointer(point) {
  elements.pointerText.textContent = point ? `Координата: X=${point.x}, Y=${point.y}` : 'Координата: —';
}

export function showObjectCount(count) {
  elements.objectCountText.textContent = `Объектов: ${count}`;
  elements.diagnosticObjectCount.textContent = String(count);
}
