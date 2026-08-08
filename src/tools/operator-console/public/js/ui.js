const elements = Object.fromEntries([
  'connectionDot', 'connectionText', 'intelligenceRibbon', 'modeBadge', 'canvasHint',
  'frameSizeText', 'pointerText', 'objectCountText', 'apiLatency', 'lastUpdatedAt',
  'panelTitle', 'panelMode', 'searchPanel', 'trackingPanel', 'searchObjectCount',
  'trackingEnabled', 'trackingState', 'activeTargetLabel', 'targetLifecycleState',
  'targetId', 'targetCoordinates', 'targetBoxSize', 'trackerType', 'trackingDuration',
  'sourceStateList', 'intelligenceProgress', 'rawJson',
  'autoRecordCheckbox', 'recordingState', 'recordingTimer',
  'recordingFile', 'recordingConfigHint', 'recordingPostRoll', 'autoRecordToggle',
  'stopRecordingButton'
].map((id) => [id, document.querySelector(`#${id}`)]));

export function showConfig(config) {
  elements.frameSizeText.textContent = `Кадр: ${config.frameWidth} × ${config.frameHeight}`;
}

export function showConnection(connected, message = '') {
  elements.connectionDot.className = `status-dot ${connected ? 'status-dot--online' : 'status-dot--offline'}`;
  elements.connectionText.textContent = message || (connected ? 'Tracking API доступен' : 'Tracking API недоступен');
}

export function showMode(mode) {
  const tracking = mode === 'TRACKING';
  elements.modeBadge.textContent = mode;
  elements.modeBadge.className = `mode-badge mode-badge--${tracking ? 'tracking' : 'search'}`;
  elements.panelMode.textContent = mode;
  elements.panelTitle.textContent = tracking ? 'Сопровождение цели' : 'Поиск целей';
  elements.searchPanel.classList.toggle('mode-panel--hidden', tracking);
  elements.trackingPanel.classList.toggle('mode-panel--hidden', !tracking);
  elements.canvasHint.textContent = tracking
    ? 'Активна одна цель. Для нового выбора прекратите сопровождение'
    : 'Выберите красную рамку одним щелчком';
}

export function showStatus({ status, objectCount, latencyMs, updatedAt }) {
  const enabled = status?.enabled ?? status?.trackingEnabled;
  elements.searchObjectCount.textContent = String(objectCount);
  elements.trackingEnabled.textContent = enabled === undefined ? '—' : (enabled ? 'Включён' : 'Выключен');
  elements.trackingState.textContent = status?.state ?? status?.status ?? '—';
  elements.objectCountText.textContent = `Движение: ${objectCount}`;
  elements.apiLatency.textContent = `API: ${latencyMs === null ? '—' : `${latencyMs} мс`}`;
  elements.lastUpdatedAt.textContent = `Обновлено: ${updatedAt ? updatedAt.toLocaleTimeString('ru-RU') : '—'}`;
}

export function showPointer(point) {
  elements.pointerText.textContent = point ? `X=${point.x} Y=${point.y}` : 'Координата: —';
}

export function showTarget(target, trackingStatus) {
  if (!target) return;
  const box = target.frame.boundingBox;
  const id = target.targetId ?? '—';
  const tracker = trackingStatus?.trackerType ?? trackingStatus?.tracker?.type ?? trackingStatus?.tracker;
  elements.activeTargetLabel.textContent = `T${id}`;
  elements.targetLifecycleState.textContent = target.state;
  elements.targetId.textContent = String(id);
  elements.targetCoordinates.textContent = `X=${target.frame.x}, Y=${target.frame.y}`;
  elements.targetBoxSize.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`;
  elements.trackerType.textContent = tracker ?? '—';
}

export function showTrackingDuration(target) {
  if (!target) {
    elements.trackingDuration.textContent = '00:00';
    return;
  }
  const totalSeconds = Math.max(0, Math.floor((Date.now() - target.selectedAt) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  elements.trackingDuration.textContent = `${minutes}:${seconds}`;
}

export function showSources(sources) {
  elements.sourceStateList.replaceChildren();
  const completed = sources.filter((source) => source.state !== 'pending').length;
  elements.intelligenceProgress.textContent = `${completed} / ${sources.length}`;

  for (const source of sources) {
    const item = document.createElement('div');
    item.className = `source-item source-item--${source.state}`;
    const text = document.createElement('div');
    const name = document.createElement('div');
    const value = document.createElement('div');
    const state = document.createElement('span');
    name.className = 'source-item__name';
    value.className = 'source-item__value';
    state.className = 'source-item__state';
    name.textContent = source.name;
    value.textContent = source.value;
    state.textContent = source.state.toUpperCase();
    text.append(name, value);
    item.append(text, state);
    elements.sourceStateList.append(item);
  }
}

export function showRibbon(mode, target, sources) {
  elements.intelligenceRibbon.replaceChildren();
  const chips = [{ text: mode, className: 'ribbon-chip--mode' }];

  if (target) {
    chips.push({ text: `T${target.targetId}` });
    chips.push({ text: `X ${target.frame.x} · Y ${target.frame.y}` });
    for (const source of sources) {
      chips.push({
        text: `${source.name}: ${source.state === 'pending' ? 'поиск…' : source.value}`,
        className: source.state === 'ready' ? 'ribbon-chip--ready'
          : source.state === 'pending' ? 'ribbon-chip--pending'
            : source.state === 'error' ? 'ribbon-chip--error' : 'ribbon-chip--muted'
      });
    }
  } else {
    chips.push({ text: 'Ожидание выбора цели', className: 'ribbon-chip--muted' });
  }

  for (const chip of chips) {
    const node = document.createElement('span');
    node.className = `ribbon-chip ${chip.className || ''}`;
    node.textContent = chip.text;
    elements.intelligenceRibbon.append(node);
  }
}

export function showRawJson(data) {
  elements.rawJson.textContent = JSON.stringify(data ?? {}, null, 2);
}

export function getRawJsonText() {
  return elements.rawJson.textContent;
}


export function showRecording(recording = {}) {
  if (!elements.autoRecordCheckbox) return;

  elements.autoRecordCheckbox.checked = Boolean(recording.autoEnabled);

  const visualState = recording.recording
    ? (recording.pendingStop ? 'post' : 'rec')
    : (recording.autoEnabled ? 'armed' : 'off');

  elements.recordingState.textContent =
    visualState === 'rec'
      ? 'REC'
      : visualState === 'post'
        ? 'POST'
        : visualState === 'armed'
          ? 'ARMED'
          : 'OFF';

  elements.recordingState.dataset.state = visualState;
  elements.autoRecordToggle?.setAttribute('data-state', visualState);

  if (elements.stopRecordingButton) {
    elements.stopRecordingButton.disabled = !recording.recording;
  }

  if (elements.recordingPostRoll) {
    elements.recordingPostRoll.textContent =
      `${Number(recording.postRollSec ?? 5)} с`;
  }

  if (recording.current?.startedAt) {
    const sec = Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(recording.current.startedAt).getTime()) / 1000,
      ),
    );

    elements.recordingTimer.textContent =
      `${String(Math.floor(sec / 60)).padStart(2, '0')}:` +
      `${String(sec % 60).padStart(2, '0')}`;
  } else {
    elements.recordingTimer.textContent = '00:00';
  }

  const file = recording.current?.videoPath || '';
  elements.recordingFile.textContent =
    file.split(/[\\/]/).pop() || '—';

  if (elements.recordingConfigHint) {
    elements.recordingConfigHint.textContent =
      recording.autoEnabled
        ? `Автозапис готовий. Максимум ${Number(recording.maxDurationSec ?? 30)} с.`
        : 'Автозапис вимкнено.';
  }
}
