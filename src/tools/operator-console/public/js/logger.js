const logContainer = document.querySelector('#requestLog');

/** Добавляет компактную цветовую запись о HTTP-запросе в начало журнала. */
export function logRequest({ method, path, status, durationMs, data, error }) {
  const entry = document.createElement('details');
  const successful = !error && status >= 200 && status < 300;
  const warning = !error && status >= 400 && status < 500;
  entry.className = `log-entry ${successful ? 'log-entry--ok' : warning ? 'log-entry--warning' : 'log-entry--error'}`;

  const time = new Date().toLocaleTimeString('ru-RU');
  const statusText = status ? String(status) : 'ERROR';

  const summary = document.createElement('summary');
  summary.className = 'log-entry__head';
  summary.innerHTML = `
    <span><span class="log-entry__method">${escapeHtml(method)}</span> ${escapeHtml(path)}</span>
    <span class="log-entry__meta">${escapeHtml(statusText)} · ${durationMs} мс · ${time}</span>
  `;

  const body = document.createElement('pre');
  body.className = 'log-entry__body';
  body.textContent = JSON.stringify(error ? { error } : (data ?? {}), null, 2);

  entry.append(summary, body);
  logContainer.prepend(entry);

  while (logContainer.children.length > 100) {
    logContainer.lastElementChild.remove();
  }
}

export function clearLog() {
  logContainer.replaceChildren();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
