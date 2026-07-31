import { state } from './state.js';
import { trackingApi } from './api.js';
import { renderCanvas } from './renderer.js';
import { bindCanvas } from './canvas.js';
import { clearLog } from './logger.js';
import {
  showConfig,
  showConnection,
  showDiagnostics,
  showRawJson,
  getRawJsonText,
  showMode,
  showPointer,
  showObjectCount
} from './ui.js';

const canvas = document.querySelector('#trackingCanvas');
const pointModeButton = document.querySelector('#pointModeButton');
const idModeButton = document.querySelector('#idModeButton');
const autoRefreshCheckbox = document.querySelector('#autoRefreshCheckbox');
const refreshIntervalSelect = document.querySelector('#refreshIntervalSelect');
const bottomTabs = [...document.querySelectorAll('[data-bottom-tab]')];
const rawJsonView = document.querySelector('#rawJson');
const requestLogView = document.querySelector('#requestLog');
const copyJsonButton = document.querySelector('#copyJsonButton');
const clearLogButton = document.querySelector('#clearLogButton');

/** Перерисовывает Canvas после изменения состояния. */
function render() {
  renderCanvas(canvas, state);
  showObjectCount(state.objects.length);
  renderDiagnostics();
  renderRawJson();
}

function renderDiagnostics() {
  showDiagnostics({
    status: state.trackingStatus,
    objectCount: state.objects.length,
    latencyMs: state.lastLatencyMs,
    updatedAt: state.lastUpdatedAt,
    statusCode: state.lastStatusCode
  });
}

function renderRawJson() {
  const dataByTab = {
    status: state.trackingStatus,
    objects: { objects: state.objects },
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

function setSelectionMode(mode) {
  state.selectionMode = mode;
  state.hoveredObjectId = null;
  pointModeButton.classList.toggle('button--active', mode === 'POINT');
  idModeButton.classList.toggle('button--active', mode === 'ID');
  showMode(mode);
  render();
}

function setConnected(connected, message) {
  state.connected = connected;
  showConnection(connected, message);
}

async function refreshObjects({ silent = false } = {}) {
  try {
    const result = await trackingApi.getObjects();
    state.objects = Array.isArray(result.data.objects) ? result.data.objects : [];
    rememberResponse(result);
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
    render();
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
    await Promise.allSettled([
      refreshObjects({ silent }),
      refreshStatus({ silent })
    ]);
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
    render();
    await refreshAll({ silent: true });
  } catch (error) {
    setConnected(false, error.message);
  }
}

function bindBottomTabs() {
  for (const tab of bottomTabs) {
    tab.addEventListener('click', () => {
      const selectedTab = tab.dataset.bottomTab;
      const isLog = selectedTab === 'log';

      for (const item of bottomTabs) {
        item.classList.toggle('bottom-tab--active', item === tab);
      }

      rawJsonView.classList.toggle('bottom-view--hidden', isLog);
      requestLogView.classList.toggle('bottom-view--hidden', !isLog);
      copyJsonButton.hidden = isLog;
      clearLogButton.hidden = !isLog;

      if (!isLog) {
        state.activeJsonTab = selectedTab;
        renderRawJson();
      }
    });
  }

  clearLogButton.hidden = true;
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
  showMode(state.selectionMode);

  bindCanvas({
    canvas,
    state,
    onSelectPoint: async ({ x, y }) => {
      state.selectedPoint = { x, y };
      state.selectedObjectId = null;
      render();
      await executeCommand(() => trackingApi.selectByPoint(x, y));
    },
    onSelectObject: async (id) => {
      state.selectedObjectId = id;
      state.selectedPoint = null;
      render();
      await executeCommand(() => trackingApi.selectById(id));
    },
    onPointerChange: showPointer,
    onRender: render
  });

  pointModeButton.addEventListener('click', () => setSelectionMode('POINT'));
  idModeButton.addEventListener('click', () => setSelectionMode('ID'));
  autoRefreshCheckbox.addEventListener('change', restartAutoRefresh);
  refreshIntervalSelect.addEventListener('change', restartAutoRefresh);

  document.querySelector('#objectsButton').addEventListener('click', () => refreshObjects());
  document.querySelector('#statusButton').addEventListener('click', () => refreshStatus());
  document.querySelector('#resetButton').addEventListener('click', () => executeCommand(trackingApi.reset));
  document.querySelector('#enableButton').addEventListener('click', () => executeCommand(trackingApi.enable));
  document.querySelector('#disableButton').addEventListener('click', () => executeCommand(trackingApi.disable));
  document.querySelector('#clearLogButton').addEventListener('click', clearLog);
  document.querySelector('#copyJsonButton').addEventListener('click', copyRawJson);
  bindBottomTabs();

  render();
  await refreshAll({ silent: true });
  restartAutoRefresh();
}

initialize().catch((error) => {
  setConnected(false, `Ошибка запуска консоли: ${error.message}`);
  console.error(error);
});
