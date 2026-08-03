'use strict';

const util = require('node:util');
const LEVELS = require('./LogLevels');
const CATEGORIES = require('./LogCategories');

const ANSI = Object.freeze({
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
});

/**
 * Преобразует строковую переменную окружения в логическое значение.
 *
 * Поддерживаются значения:
 *   true:  1, true, yes, on
 *   false: 0, false, no, off
 */
function readBoolean(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  return defaultValue;
}

/**
 * Единый логгер серверной части приложения.
 *
 * Важная особенность: Logger может быть импортирован раньше, чем app.js вызовет
 * dotenv.config(). Поэтому настройки окружения перечитываются лениво перед
 * выводом сообщения, если значения LOG_* изменились.
 *
 * Переменные окружения:
 *   LOG_LEVEL=DEBUG|INFO|WARN|ERROR|SILENT
 *   LOG_CATEGORIES=VIDEO,RTSP,TRACK   (пусто или * = все категории)
 *   LOG_COLORS=0                      (отключить ANSI-цвета)
 *   LOG_TIMESTAMP=0                   (скрыть время)
 */
class Logger {
  constructor() {
    this.level = LEVELS.INFO;
    this.categories = null;
    this.useColors = false;
    this.showTimestamp = true;
    this.envSignature = null;

    this.#refreshFromEnvironment(true);
  }

  /** Принудительно перечитывает настройки LOG_* из process.env. */
  reloadFromEnvironment() {
    this.#refreshFromEnvironment(true);
  }

  setLevel(level) {
    this.level = this.#normalizeLevel(level);
  }

  enableCategory(category) {
    if (!this.categories) this.categories = new Set();
    this.categories.add(this.#normalizeCategory(category));
  }

  disableCategory(category) {
    if (!this.categories) {
      this.categories = new Set(Object.values(CATEGORIES));
    }

    this.categories.delete(this.#normalizeCategory(category));
  }

  enableAllCategories() {
    this.categories = null;
  }

  child(category) {
    const normalized = this.#normalizeCategory(category || 'CORE');

    return {
      trace: (...args) => this.trace(`[${normalized}]`, ...args),
      debug: (...args) => this.debug(`[${normalized}]`, ...args),
      info: (...args) => this.info(`[${normalized}]`, ...args),
      success: (...args) => this.success(`[${normalized}]`, ...args),
      warn: (...args) => this.warn(`[${normalized}]`, ...args),
      error: (...args) => this.error(`[${normalized}]`, ...args),
    };
  }

  trace(...args) { this.#write('TRACE', args); }
  debug(...args) { this.#write('DEBUG', args); }
  info(...args) { this.#write('INFO', args); }
  log(...args) { this.info(...args); }
  success(...args) { this.#write('SUCCESS', args); }
  warn(...args) { this.#write('WARN', args); }
  error(...args) { this.#write('ERROR', args); }

  #write(levelName, args) {
    // dotenv мог загрузиться уже после первого require(Logger).
    this.#refreshFromEnvironment(false);

    if (LEVELS[levelName] < this.level) return;

    const { category, values } = this.#extractCategory(args);

    // null означает «разрешены все категории».
    if (this.categories !== null && !this.categories.has(category)) return;

    const time = this.showTimestamp
      ? `${new Date().toISOString().slice(11, 23)} `
      : '';

    const prefix = `${time}[${category}] ${levelName.padEnd(7)}`;
    const message = util.format(...values);
    const line = `${this.#paint(prefix, levelName)} ${message}`;
    const stream = levelName === 'ERROR' ? process.stderr : process.stdout;

    stream.write(`${line}\n`);
  }

  #refreshFromEnvironment(force) {
    const signature = [
      process.env.LOG_LEVEL ?? '',
      process.env.LOG_CATEGORIES ?? '',
      process.env.LOG_COLORS ?? '',
      process.env.LOG_TIMESTAMP ?? '',
    ].join('\u0000');

    if (!force && signature === this.envSignature) return;

    this.level = this.#normalizeLevel(process.env.LOG_LEVEL || 'INFO');
    this.categories = this.#parseCategories(process.env.LOG_CATEGORIES);
    this.useColors = readBoolean(
      process.env.LOG_COLORS,
      Boolean(process.stdout.isTTY),
    );
    this.showTimestamp = readBoolean(process.env.LOG_TIMESTAMP, true);
    this.envSignature = signature;
  }

  #extractCategory(args) {
    const values = [...args];
    let category = 'CORE';

    if (typeof values[0] === 'string') {
      const match = values[0].match(/^\s*\[([^\]]+)\]\s*/u);

      if (match) {
        category = this.#normalizeCategory(match[1]);
        values[0] = values[0].slice(match[0].length);
      }
    }

    return { category, values };
  }

  #normalizeCategory(value) {
    const raw = String(value || 'CORE').trim().toUpperCase();
    const aliases = {
      'ВИДЕО': 'VIDEO',
      'СТАТИСТИКА': 'PERF',
      'СТАТИСТИКА ВСЕГО': 'PERF',
      'ПРОФАЙЛЕР': 'PERF',
      'СИСТЕМА': 'SYSTEM',
      'ТРЕКИНГ': 'TRACK',
      'КАДР': 'VIDEO',
      'PROFILEMANAGER': 'PROFILE',
      'PROFILE_MANAGER': 'PROFILE',
      'CAMERA:SIM': 'CAMERA',
      'CAMERA_SIM': 'CAMERA',
    };

    return aliases[raw] || raw.replace(/\s+/gu, '_');
  }

  #normalizeLevel(value) {
    const name = String(value).trim().toUpperCase();

    if (!(name in LEVELS)) {
      throw new Error(`Неизвестный уровень логирования: ${value}`);
    }

    return LEVELS[name];
  }

  #parseCategories(value) {
    if (!value || !String(value).trim() || String(value).trim() === '*') {
      return null;
    }

    return new Set(
      String(value)
        .split(',')
        .map((category) => this.#normalizeCategory(category))
        .filter(Boolean),
    );
  }

  #paint(text, levelName) {
    if (!this.useColors) return text;

    const color = {
      TRACE: ANSI.gray,
      DEBUG: ANSI.gray,
      INFO: ANSI.cyan,
      SUCCESS: ANSI.green,
      WARN: ANSI.yellow,
      ERROR: ANSI.red,
    }[levelName] || '';

    return `${color}${text}${ANSI.reset}`;
  }
}

module.exports = new Logger();
module.exports.Logger = Logger;
