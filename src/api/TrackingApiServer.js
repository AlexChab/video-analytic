'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const logger = require('../utils/Logger');

const apiLog = logger.child('API');
const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * HTTP API ручного сопровождения и runtime-конфигурации.
 *
 * Сервер работает только на встроенных модулях Node.js и не требует Express.
 */
class TrackingApiServer {
  constructor({
    host = '127.0.0.1',
    port = 8081,
    control,
    profileManager = null,
    frameWidth,
    frameHeight,
  }) {
    this.host = host;
    this.port = port;
    this.control = control;
    this.profileManager = profileManager;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.server = null;
  }

  start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.listen(this.port, this.host, () => {
      apiLog.info(`HTTP API: http://${this.host}:${this.port}`);
    });
  }

  stop() {
    if (!this.server) return;

    this.server.close();
    this.server = null;
  }

  async #handle(req, res) {
    try {
      this.#setCommonHeaders(res);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      const configResponse = await this.#handleConfigurationRoutes(req, res, url);
      if (configResponse) return;

      const trackingResponse = await this.#handleTrackingRoutes(req, res, url);
      if (trackingResponse) return;

      return this.#json(res, 404, {
        success: false,
        error: 'Маршрут не найден',
        method: req.method,
        path: url.pathname,
      });
    } catch (error) {
      apiLog.warn(`${req.method} ${req.url}: ${error.message}`);
      return this.#json(res, this.#statusForError(error), {
        success: false,
        error: error.message,
      });
    }
  }

  async #handleConfigurationRoutes(req, res, url) {
    if (!url.pathname.startsWith('/api/config')
      && !url.pathname.startsWith('/api/runtime')
      && !url.pathname.startsWith('/api/profile')) {
      return false;
    }

    const profileManager = this.#requireProfileManager();

    if (req.method === 'GET' && url.pathname === '/api/config') {
      this.#json(res, 200, {
        success: true,
        profile: profileManager.getProfileInfo(),
        configuration: profileManager.getEffectiveConfig(),
      });
      return true;
    }

    const configPath = this.#extractConfigPath(url.pathname);
    if (configPath !== null) {
      if (req.method === 'GET') {
        const result = this.#getByPath(profileManager.getEffectiveConfig(), configPath);
        if (!result.exists) {
          this.#json(res, 404, {
            success: false,
            error: `Параметр конфигурации не найден: ${configPath}`,
          });
          return true;
        }

        this.#json(res, 200, {
          success: true,
          path: configPath,
          value: result.value,
        });
        return true;
      }

      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const body = await this.#body(req);
        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
          throw new Error('В JSON-теле необходимо передать поле value');
        }

        const before = this.#getByPath(profileManager.getEffectiveConfig(), configPath);
        profileManager.setRuntimeOverride(configPath, body.value);
        const after = this.#getByPath(profileManager.getEffectiveConfig(), configPath);

        apiLog.info(`Runtime-параметр изменён: ${configPath}`);
        this.#json(res, 200, {
          success: true,
          path: configPath,
          oldValue: before.exists ? before.value : null,
          newValue: after.value,
          runtimeOverrides: profileManager.getRuntimeOverrides(),
        });
        return true;
      }

      if (req.method === 'DELETE') {
        const before = this.#getByPath(profileManager.getRuntimeOverrides(), configPath);
        profileManager.clearRuntimeOverride(configPath);
        const effective = this.#getByPath(profileManager.getEffectiveConfig(), configPath);

        apiLog.info(`Runtime-параметр очищен: ${configPath}`);
        this.#json(res, 200, {
          success: true,
          path: configPath,
          overrideExisted: before.exists,
          effectiveValue: effective.exists ? effective.value : null,
          runtimeOverrides: profileManager.getRuntimeOverrides(),
        });
        return true;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/runtime') {
      this.#json(res, 200, {
        success: true,
        runtimeOverrides: profileManager.getRuntimeOverrides(),
      });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/runtime') {
      profileManager.clearRuntimeOverrides();
      apiLog.info('Все runtime-переопределения очищены');
      this.#json(res, 200, {
        success: true,
        runtimeOverrides: profileManager.getRuntimeOverrides(),
        configuration: profileManager.getEffectiveConfig(),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/profiles') {
      this.#json(res, 200, {
        success: true,
        active: profileManager.getActiveProfile(),
        profiles: profileManager.listProfiles(),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/profile') {
      this.#json(res, 200, {
        success: true,
        info: profileManager.getProfileInfo(),
        active: profileManager.getActiveProfile(),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/profile/select') {
      const body = await this.#body(req);
      const scope = String(body.scope || '').trim();
      const id = String(body.id || body.profileId || '').trim();

      if (!['preset', 'custom'].includes(scope)) {
        throw new Error('Поле scope должно иметь значение preset или custom');
      }
      if (!id) {
        throw new Error('Необходимо указать id профиля');
      }

      const active = profileManager.activateProfile(scope, id);
      apiLog.info(`Активирован профиль ${scope}/${id}`);
      this.#json(res, 200, {
        success: true,
        active,
        configuration: profileManager.getEffectiveConfig(),
      });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/profile') {
      profileManager.clearActiveProfile();
      apiLog.info('Активный профиль отключён');
      this.#json(res, 200, {
        success: true,
        active: null,
        profile: profileManager.getProfileInfo(),
        configuration: profileManager.getEffectiveConfig(),
      });
      return true;
    }

    return false;
  }

  async #handleTrackingRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/tracking/status') {
      this.#json(res, 200, this.control.getStatus());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/tracking/objects') {
      this.#json(res, 200, { objects: this.control.getStatus().objects });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/tracking/target/id') {
      const body = await this.#body(req);
      const id = Number(body.id);
      if (!Number.isFinite(id)) throw new Error('Поле id должно быть числом');

      this.control.selectById(id);
      this.#json(res, 202, { accepted: true, command: 'SELECT_ID', id });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/tracking/target/point') {
      const body = await this.#body(req);
      const x = Number(body.x);
      const y = Number(body.y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('Поля x и y должны быть числами');
      }
      if (x < 0 || x >= this.frameWidth || y < 0 || y >= this.frameHeight) {
        return this.#json(res, 400, {
          error: `Координаты вне кадра ${this.frameWidth}x${this.frameHeight}`,
        });
      }

      this.control.selectByPoint(x, y);
      this.#json(res, 202, { accepted: true, command: 'SELECT_POINT', x, y });
      return true;
    }

    const commands = {
      '/api/tracking/reset': ['reset', 'RESET'],
      '/api/tracking/disable': ['disable', 'DISABLE'],
      '/api/tracking/enable': ['enable', 'ENABLE'],
    };

    if (req.method === 'POST' && commands[url.pathname]) {
      const [method, command] = commands[url.pathname];
      this.control[method]();
      this.#json(res, 202, { accepted: true, command });
      return true;
    }

    return false;
  }

  #extractConfigPath(pathname) {
    const prefix = '/api/config/';
    if (!pathname.startsWith(prefix)) return null;

    const rawPath = decodeURIComponent(pathname.slice(prefix.length)).trim();
    if (!rawPath) throw new Error('Не указан путь параметра конфигурации');

    const normalized = rawPath.replace(/\//gu, '.');
    const parts = normalized.split('.').map((part) => part.trim()).filter(Boolean);

    if (parts.length === 0 || parts.some((part) => FORBIDDEN_PATH_PARTS.has(part))) {
      throw new Error('Недопустимый путь параметра конфигурации');
    }

    return parts.join('.');
  }

  #getByPath(object, configPath) {
    const parts = configPath.split('.');
    let value = object;

    for (const part of parts) {
      if (value === null
        || typeof value !== 'object'
        || !Object.prototype.hasOwnProperty.call(value, part)) {
        return { exists: false, value: undefined };
      }
      value = value[part];
    }

    return { exists: true, value };
  }

  #requireProfileManager() {
    if (!this.profileManager) {
      const error = new Error('Configuration API не подключён к ProfileManager');
      error.statusCode = 503;
      throw error;
    }
    return this.profileManager;
  }

  #body(req) {
    return new Promise((resolve, reject) => {
      let text = '';
      let finished = false;

      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        if (finished) return;
        text += chunk;
        if (Buffer.byteLength(text, 'utf8') > 65536) {
          finished = true;
          const error = new Error('Слишком большое тело запроса');
          error.statusCode = 413;
          reject(error);
          req.destroy();
        }
      });
      req.on('end', () => {
        if (finished) return;
        try {
          const body = text ? JSON.parse(text) : {};
          if (body === null || Array.isArray(body) || typeof body !== 'object') {
            throw new Error('JSON-тело должно быть объектом');
          }
          resolve(body);
        } catch (error) {
          reject(new Error(error.message === 'JSON-тело должно быть объектом'
            ? error.message
            : 'Требуется корректный JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  #statusForError(error) {
    if (Number.isInteger(error.statusCode)) return error.statusCode;
    if (/не найден|не существует/iu.test(error.message)) return 404;
    return 400;
  }

  #setCommonHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
  }

  #json(res, status, data) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  }
}

module.exports = TrackingApiServer;
