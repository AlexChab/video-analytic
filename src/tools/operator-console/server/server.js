'use strict';

const logger = require('../../../utils/Logger');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const PROJECT_ROOT = path.resolve(ROOT_DIR, '..', '..', '..');
const SAMPLES_DIR = path.join(PROJECT_ROOT, 'samples');
fs.mkdirSync(SAMPLES_DIR, { recursive: true });

/** Загружает конфигурацию отдельного приложения Operator Console. */
function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  return {
    consoleHost:
      process.env.OPERATOR_CONSOLE_HOST || config.consoleHost || '0.0.0.0',
    consolePort: Number(
      process.env.OPERATOR_CONSOLE_PORT || config.consolePort || 8090,
    ),
    trackingApi:
      process.env.TRACKING_API_URL ||
      config.trackingApi ||
      'http://0.0.0.0:8081',
    refreshMs: Number(config.refreshMs || 500),
    frameWidth: Number(config.frameWidth || 1920),
    frameHeight: Number(config.frameHeight || 1080),
    requestTimeoutMs: Number(config.requestTimeoutMs || 3000),
    recordingPostRollSec: Number(config.recordingPostRollSec || 5),
    recordingFps: Number(config.recordingFps || 10),
    recordingRtspUrl:
      process.env.OPERATOR_RECORD_RTSP_URL ||
      config.recordingRtspUrl ||
      '',
    recordingRtspTransport:
      process.env.OPERATOR_RECORD_RTSP_TRANSPORT ||
      config.recordingRtspTransport ||
      'tcp',
    ffmpegPath:
      process.env.OPERATOR_FFMPEG_PATH ||
      config.ffmpegPath ||
      'ffmpeg',
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
  '.svg': 'image/svg+xml',
};

/** Отправляет JSON-ответ с корректной длиной тела. */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
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
      'Cache-Control': 'no-cache',
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

  const allowedPrefixes = [
    '/api/tracking/',
    '/api/observation',
    '/api/config',
    '/api/runtime',
    '/api/profile',
  ];
  if (!allowedPrefixes.some((prefix) => apiPath.startsWith(prefix))) {
    sendJson(res, 404, { error: 'Маршрут не разрешён локальным proxy' });
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
      signal: controller.signal,
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type':
        upstream.headers.get('content-type') ||
        'application/json; charset=utf-8',
      'Content-Length': responseBody.length,
      'Cache-Control': 'no-store',
    });
    res.end(responseBody);
  } catch (error) {
    const message =
      error.name === 'AbortError'
        ? `Tracking API не ответил за ${config.requestTimeoutMs} мс`
        : `Tracking API недоступен: ${error.message}`;

    sendJson(res, 502, { error: message, trackingApi: config.trackingApi });
  } finally {
    clearTimeout(timeout);
  }
}


/*
 * AUTO REC is deliberately isolated from the existing /proxy/... path.
 * Existing Tracking API proxy code and allowlist remain unchanged.
 */
const recorder = {
  autoEnabled: false,
  child: null,
  session: null,
  stopTimer: null,
  maxTimer: null,

  status() {
    return {
      autoEnabled: this.autoEnabled,
      recording: Boolean(this.child),
      pendingStop: Boolean(this.stopTimer),
      postRollSec: config.recordingPostRollSec,
      maxDurationSec: 30,
      current: this.session,
    };
  },

  start(meta = {}) {
    if (!this.autoEnabled) return this.status();
    if (this.child) {
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      return this.status();
    }
    if (!config.recordingRtspUrl) {
      throw new Error(
        'AUTO_REC_RTSP_NOT_CONFIGURED: set recordingRtspUrl in config.json ' +
        'or OPERATOR_RECORD_RTSP_URL'
      );
    }

    const d = new Date();
    const stamp =
      d.getFullYear() +
      String(d.getMonth()+1).padStart(2,'0') +
      String(d.getDate()).padStart(2,'0') + '_' +
      String(d.getHours()).padStart(2,'0') +
      String(d.getMinutes()).padStart(2,'0') +
      String(d.getSeconds()).padStart(2,'0');
    const target = String(meta.targetId ?? 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const base = `capture_${stamp}_T${target}`;
    const videoPath = path.join(SAMPLES_DIR, `${base}.mp4`);
    const metadataPath = path.join(SAMPLES_DIR, `${base}.json`);

    this.session = {
      targetId: meta.targetId ?? null,
      startedAt: d.toISOString(),
      videoPath,
      metadataPath,
      capture: meta,
    };

    fs.writeFileSync(
      metadataPath,
      JSON.stringify({...this.session, state:'RECORDING'}, null, 2),
      'utf8'
    );

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', config.recordingRtspTransport,
      '-i', config.recordingRtspUrl,
      '-map', '0:v:0', '-an',
      '-vf', `fps=${config.recordingFps}`,
      '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', videoPath,
    ];

    this.child = spawn(config.ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    // AUTO REC: жёсткий серверный лимит 30 секунд.
    // Он не зависит от состояния браузера и сработает даже если UI потерял связь.
    clearTimeout(this.maxTimer);
    this.maxTimer = setTimeout(() => {
      logger.info('[AUTO REC] MAX_DURATION 30s');
      this.stop('MAX_DURATION', 0);
    }, 30000);
    this.maxTimer.unref?.();
    this.child.stderr.on('data', b =>
      logger.debug?.(`[AUTO REC] ${b.toString().trim()}`)
    );
    this.child.once('close', code => {
      if (!this.session) return;
      this.session.endedAt = new Date().toISOString();
      this.session.ffmpegExitCode = code;
      fs.writeFileSync(
        this.session.metadataPath,
        JSON.stringify({...this.session, state:'FINISHED'}, null, 2),
        'utf8'
      );
      this.child = null;
      this.session = null;
      clearTimeout(this.stopTimer);
      clearTimeout(this.maxTimer);
      this.stopTimer = null;
      this.maxTimer = null;
    });
    logger.info(`[AUTO REC] START target=${meta.targetId ?? '-'} -> ${videoPath}`);
    return this.status();
  },

  stop(reason = 'TRACKING_ENDED', postRollSec = config.recordingPostRollSec) {
    if (!this.child) return this.status();
    if (this.stopTimer) return this.status();

    const delay = Math.max(0, Number(postRollSec) || 0);
    if (this.session) {
      this.session.stopReason = reason;
      this.session.stopRequestedAt = new Date().toISOString();
    }

    const finish = () => {
      this.stopTimer = null;
      clearTimeout(this.maxTimer);
      this.maxTimer = null;

      const child = this.child;
      if (!child) return;

      // Сначала просим FFmpeg штатно закрыть MP4 trailer.
      try {
        child.stdin?.write('q\n');
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }

      // Если FFmpeg завис — не оставляем бесконечную запись.
      setTimeout(() => {
        if (this.child !== child) return;
        logger.warn('[AUTO REC] graceful stop timeout -> SIGTERM');
        try { child.kill('SIGTERM'); } catch {}

        setTimeout(() => {
          if (this.child !== child) return;
          logger.warn('[AUTO REC] SIGTERM timeout -> SIGKILL');
          try { child.kill('SIGKILL'); } catch {}
        }, 1500).unref?.();
      }, 2500).unref?.();
    };

    if (delay > 0) {
      this.stopTimer = setTimeout(finish, delay * 1000);
      this.stopTimer.unref?.();
      logger.info(`[AUTO REC] POST-ROLL ${delay}s reason=${reason}`);
    } else {
      finish();
    }
    return this.status();
  },
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleRecorder(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/console/recording/status') {
    sendJson(res, 200, recorder.status());
    return true;
  }
  if (req.method === 'PUT' && url.pathname === '/console/recording/auto') {
    const body = await readJson(req);
    recorder.autoEnabled = Boolean(body.enabled);
    sendJson(res, 200, recorder.status());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/console/recording/start') {
    const body = await readJson(req);
    sendJson(res, 200, recorder.start(body));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/console/recording/stop') {
    const body = await readJson(req);
    sendJson(
      res, 200,
      recorder.stop(body.reason, body.postRollSec)
    );
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/console/config') {
    sendJson(res, 200, {
      trackingApi: config.trackingApi,
      refreshMs: config.refreshMs,
      frameWidth: config.frameWidth,
      frameHeight: config.frameHeight,
      recordingPostRollSec: config.recordingPostRollSec,
      recordingConfigured: Boolean(config.recordingRtspUrl),
    });
    return;
  }

  if (url.pathname.startsWith('/console/recording/')) {
    try {
      const handled = await handleRecorder(req, res, url);
      if (!handled) sendJson(res, 404, { error: 'Recorder route not found' });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
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
  logger.info(
    `Интерфейс:   http://${config.consoleHost}:${config.consolePort}`,
  );
  logger.info(`Tracking API: ${config.trackingApi}`);
  logger.info('');
});

server.on('error', (error) => {
  logger.error(`[Operator Console] Ошибка сервера: ${error.message}`);
  process.exitCode = 1;
});
