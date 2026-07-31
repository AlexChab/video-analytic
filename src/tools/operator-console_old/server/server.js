'use strict';


const logger = require('../../../utils/Logger');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

/** Загружает конфигурацию отдельного приложения Operator Console. */
function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  return {
    consoleHost: process.env.OPERATOR_CONSOLE_HOST || config.consoleHost || '127.0.0.1',
    consolePort: Number(process.env.OPERATOR_CONSOLE_PORT || config.consolePort || 8090),
    trackingApi: process.env.TRACKING_API_URL || config.trackingApi || 'http://127.0.0.1:8081',
    refreshMs: Number(config.refreshMs || 500),
    frameWidth: Number(config.frameWidth || 1920),
    frameHeight: Number(config.frameHeight || 1080),
    requestTimeoutMs: Number(config.requestTimeoutMs || 3000)
  };
}

const config = loadConfig();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

/** Отправляет JSON-ответ с корректной длиной тела. */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** Безопасно раздаёт статические файлы из public, не позволяя выйти из каталога. */
function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Доступ запрещён' });
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      sendJson(res, 404, { error: 'Файл не найден' });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * Проксирует запросы /proxy/... к Tracking API.
 * Это сохраняет консоль отдельным приложением и одновременно устраняет CORS.
 */
async function proxyRequest(req, res, pathname, search) {
  const apiPath = pathname.slice('/proxy'.length);

  if (!apiPath.startsWith('/api/tracking/')) {
    sendJson(res, 404, { error: 'Проксировать разрешено только /api/tracking/*' });
    return;
  }

  const target = new URL(`${apiPath}${search}`, config.trackingApi);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const requestBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const upstream = await fetch(target, {
      method: req.method,
      headers: requestBody
        ? { 'Content-Type': req.headers['content-type'] || 'application/json' }
        : undefined,
      body: requestBody,
      signal: controller.signal
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Content-Length': responseBody.length,
      'Cache-Control': 'no-store'
    });
    res.end(responseBody);
  } catch (error) {
    const message = error.name === 'AbortError'
      ? `Tracking API не ответил за ${config.requestTimeoutMs} мс`
      : `Tracking API недоступен: ${error.message}`;

    sendJson(res, 502, { error: message, trackingApi: config.trackingApi });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/console/config') {
    sendJson(res, 200, {
      trackingApi: config.trackingApi,
      refreshMs: config.refreshMs,
      frameWidth: config.frameWidth,
      frameHeight: config.frameHeight
    });
    return;
  }

  if (url.pathname.startsWith('/proxy/')) {
    await proxyRequest(req, res, url.pathname, url.search);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Метод не поддерживается' });
    return;
  }

  serveStatic(url.pathname, res);
});

server.listen(config.consolePort, config.consoleHost, () => {
  logger.info('');
  logger.info('Operator Console запущена');
  logger.info(`Интерфейс:   http://${config.consoleHost}:${config.consolePort}`);
  logger.info(`Tracking API: ${config.trackingApi}`);
  logger.info('');
});

server.on('error', (error) => {
  logger.error(`[Operator Console] Ошибка сервера: ${error.message}`);
  process.exitCode = 1;
});
