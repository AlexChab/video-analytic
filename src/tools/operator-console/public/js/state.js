/**
 * Единое состояние Operator Console.
 * Все визуальные модули получают этот объект по ссылке и не создают собственные копии данных.
 */
export const state = {
  config: null,
  mode: 'SEARCH',
  objects: [],
  trackingStatus: {},
  lastResponse: {},
  activeJsonTab: 'status',
  activeTarget: null,
  hoveredObjectId: null,
  pointer: null,
  connected: null,
  refreshTimer: null,
  durationTimer: null,
  requestInProgress: false,
  lastLatencyMs: null,
  lastUpdatedAt: null,
  lastStatusCode: null,
  intelligenceSources: []
};
