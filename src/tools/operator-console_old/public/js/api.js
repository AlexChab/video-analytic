import { logRequest } from './logger.js';

/** Унифицированный вызов Tracking API через локальный proxy Operator Console. */
async function request(path, options = {}) {
  const startedAt = performance.now();
  const method = options.method || 'GET';

  try {
    const response = await fetch(`/proxy${path}`, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    const durationMs = Math.round(performance.now() - startedAt);
    logRequest({ method, path, status: response.status, durationMs, data });

    if (!response.ok) {
      throw new ApiError(data.error || `HTTP ${response.status}`, response.status, data, durationMs);
    }

    return { status: response.status, data, durationMs, method, path };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      const durationMs = Math.round(performance.now() - startedAt);
      logRequest({ method, path, durationMs, error: error.message });
      error.durationMs = durationMs;
    }
    throw error;
  }
}

export class ApiError extends Error {
  constructor(message, status = 0, data = null, durationMs = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.durationMs = durationMs;
  }
}

export const trackingApi = {
  getObjects: () => request('/api/tracking/objects'),
  getStatus: () => request('/api/tracking/status'),
  selectById: (id) => request('/api/tracking/target/id', {
    method: 'POST',
    body: JSON.stringify({ id })
  }),
  selectByPoint: (x, y) => request('/api/tracking/target/point', {
    method: 'POST',
    body: JSON.stringify({ x, y })
  }),
  reset: () => request('/api/tracking/reset', { method: 'POST' }),
  enable: () => request('/api/tracking/enable', { method: 'POST' }),
  disable: () => request('/api/tracking/disable', { method: 'POST' })
};
