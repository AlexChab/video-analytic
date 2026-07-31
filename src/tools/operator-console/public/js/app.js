import { state } from './state.js';
import { trackingApi } from './api.js';
import { renderCanvas, getObjectId } from './renderer.js';
import { bindCanvas } from './canvas.js';
import { clearLog } from './logger.js';
import { TargetRegistry } from './target-registry.js';
import { TargetIntelligenceCoordinator } from './intelligence-coordinator.js';
import {
  showConfig, showConnection, showMode, showStatus, showPointer, showTarget,
  showTrackingDuration, showSources, showRibbon, showRawJson, getRawJsonText
} from './ui.js';

const canvas = document.querySelector('#trackingCanvas');
const autoRefreshCheckbox = document.querySelector('#autoRefreshCheckbox');
const refreshIntervalSelect = document.querySelector('#refreshIntervalSelect');
const jsonTabs = [...document.querySelectorAll('[data-json-tab]')];
const registry = new TargetRegistry();
const coordinator = new TargetIntelligenceCoordinator({
  onUpdate: (sources) => {
    state.intelligenceSources = sources;
    const target = registry.getActive();
    if (target) {
      for (const source of sources) registry.setIntelligence(source.id, source);
      state.activeTarget = registry.getActive();
    }
    render();
  }
});

function getApiTargetId(status) {
  return status?.targetId ?? status?.selectedId ?? status?.target?.id ?? null;
}

function render() {
  if (!state.config) return;
  renderCanvas(canvas, state);
  showMode(state.mode);
  showStatus({
    status: state.trackingStatus,
    objectCount: state.objects.length,
    latencyMs: state.lastLatencyMs,
    updatedAt: state.lastUpdatedAt
  });
  showTarget(state.activeTarget, state.trackingStatus);
  showTrackingDuration(state.activeTarget);
  showSources(state.intelligenceSources);
  showRibbon(state.mode, state.activeTarget, state.intelligenceSources);
  renderRawJson();
}

function renderRawJson() {
  const dataByTab = {
    status: state.trackingStatus,
    objects: { objects: state.objects },
    target: state.activeTarget || {},
    response: state.lastResponse
  };
  showRawJson(dataByTab[state.activeJsonTab] ?? {});
}

function rememberResponse(result) {
  state.lastResponse = {
    method: result.method,
    path: result.path,
    status: result.status,
    durationMs: result.durationMs,
    data: result.data
  };
  state.lastLatencyMs = result.durationMs;
  state.lastStatusCode = result.status;
  state.lastUpdatedAt = new Date();
}

function setConnected(connected, message) {
  state.connected = connected;
  showConnection(connected, message);
}

function enterTracking(target) {
  registry.setState('TRACKING');
  state.activeTarget = registry.getActive() || target;
  state.mode = 'TRACKING';
  coordinator.start(state.activeTarget);
  restartDurationTimer();
  render();
}

function returnToSearch(finalState = 'CANCELLED') {
  coordinator.cancel();
  registry.clear(finalState);
  state.activeTarget = null;
  state.intelligenceSources = [];
  state.hoveredObjectId = null;
  state.mode = 'SEARCH';
  clearInterval(state.durationTimer);
  state.durationTimer = null;
  render();
}

function restartDurationTimer() {
  clearInterval(state.durationTimer);
  state.durationTimer = setInterval(() => showTrackingDuration(state.activeTarget), 1000);
}

async function refreshObjects({ silent = false } = {}) {
  try {
    const result = await trackingApi.getObjects();
    state.objects = Array.isArray(result.data.objects) ? result.data.objects : [];
    rememberResponse(result);

    if (state.activeTarget) {
      const current = state.objects.find((object) => String(getObjectId(object)) === String(state.activeTarget.targetId));
      if (current) {
        registry.updateFromObject(current);
        state.activeTarget = registry.getActive();
      }
    }

    setConnected(true);
    render();
    return result;
  } catch (error) {
    setConnected(false, error.message);
    if (!silent) console.error(error);
    throw error;
  }
}

async function refreshStatus({ silent = false } = {}) {
  try {
    const result = await trackingApi.getStatus();
    state.trackingStatus = result.data || {};
    rememberResponse(result);
    setConnected(true);

    // Если сервер сообщил об отсутствии цели, консоль автоматически возвращается в SEARCH.
    const apiTargetId = getApiTargetId(state.trackingStatus);
    const apiState = String(state.trackingStatus?.state ?? state.trackingStatus?.status ?? '').toUpperCase();
    if (state.mode === 'TRACKING' && apiTargetId === null && ['IDLE', 'SEARCH', 'READY', 'NONE'].includes(apiState)) {
      returnToSearch('LOST');
    } else {
      render();
    }
    return result;
  } catch (error) {
    setConnected(false, error.message);
    if (!silent) console.error(error);
    throw error;
  }
}

async function refreshAll({ silent = false } = {}) {
  if (state.requestInProgress) return;
  state.requestInProgress = true;
  try {
    await Promise.allSettled([refreshObjects({ silent }), refreshStatus({ silent })]);
  } finally {
    state.requestInProgress = false;
  }
}

function restartAutoRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  if (!autoRefreshCheckbox.checked) return;
  const interval = Number(refreshIntervalSelect.value || state.config.refreshMs);
  state.refreshTimer = setInterval(() => refreshAll({ silent: true }), interval);
}

async function executeCommand(command) {
  try {
    const result = await command();
    rememberResponse(result);
    setConnected(true);
    await refreshAll({ silent: true });
    return result;
  } catch (error) {
    setConnected(false, error.message);
    throw error;
  }
}

async function selectTarget(object, point) {
  if (state.mode !== 'SEARCH') return;
  const id = getObjectId(object);
  if (id === null) return;

  const target = registry.activate(object, point);
  state.activeTarget = target;
  state.mode = 'TRACKING';
  render();

  try {
    await executeCommand(() => trackingApi.selectById(id));
    enterTracking(target);
  } catch {
    returnToSearch('ERROR');
  }
}

function bindJsonTabs() {
  for (const tab of jsonTabs) {
    tab.addEventListener('click', () => {
      state.activeJsonTab = tab.dataset.jsonTab;
      for (const item of jsonTabs) item.classList.toggle('diagnostic-tab--active', item === tab);
      renderRawJson();
    });
  }
}

async function copyRawJson() {
  try {
    await navigator.clipboard.writeText(getRawJsonText());
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = getRawJsonText();
    document.body.append(temporary);
    temporary.select();
    document.execCommand('copy');
    temporary.remove();
  }
}

async function initialize() {
  const response = await fetch('/console/config', { cache: 'no-store' });
  state.config = await response.json();
  refreshIntervalSelect.value = String(state.config.refreshMs);
  showConfig(state.config);

  bindCanvas({
    canvas,
    state,
    onSelectObject: selectTarget,
    onPointerChange: showPointer,
    onRender: render
  });

  autoRefreshCheckbox.addEventListener('change', restartAutoRefresh);
  refreshIntervalSelect.addEventListener('change', restartAutoRefresh);
  document.querySelector('#refreshButton').addEventListener('click', () => refreshAll());
  document.querySelector('#enableButton').addEventListener('click', () => executeCommand(trackingApi.enable));
  document.querySelector('#disableButton').addEventListener('click', () => executeCommand(trackingApi.disable));
  document.querySelector('#resetButton').addEventListener('click', async () => {
    try { await executeCommand(trackingApi.reset); } finally { returnToSearch('CANCELLED'); }
  });
  document.querySelector('#clearLogButton').addEventListener('click', clearLog);
  document.querySelector('#copyJsonButton').addEventListener('click', copyRawJson);
  bindJsonTabs();

  render();
  await refreshAll({ silent: true });
  restartAutoRefresh();
}

initialize().catch((error) => {
  setConnected(false, `Ошибка запуска консоли: ${error.message}`);
  console.error(error);
});
