/** Единое состояние интерфейса. Модули получают его по ссылке и не дублируют данные. */
export const state = {
  config: null,
  selectionMode: 'POINT',
  objects: [],
  trackingStatus: {},
  lastResponse: {},
  activeJsonTab: 'status',
  selectedPoint: null,
  selectedObjectId: null,
  hoveredObjectId: null,
  pointer: null,
  connected: null,
  refreshTimer: null,
  requestInProgress: false,
  lastLatencyMs: null,
  lastUpdatedAt: null,
  lastStatusCode: null
};
