'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const DEFAULT_PROCESSING_PROFILE = require('./DefaultProcessingProfile');
const ProfileStorage = require('./ProfileStorage');
const defaultLogger = require('../utils/Logger');

/**
 * Проверяет, является ли значение обычным объектом.
 * Массивы, Date, Buffer и другие специальные объекты сюда не относятся.
 *
 * @param {*} value Проверяемое значение.
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Создаёт безопасную глубокую копию значения.
 *
 * В проекте используется Node.js 22, поэтому штатный structuredClone()
 * является основным способом копирования. Запасной вариант оставлен для
 * тестовых сред с более старой версией Node.js.
 *
 * @param {*} value Исходное значение.
 * @returns {*} Независимая копия.
 */
function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Глубоко объединяет два дерева конфигурации без изменения исходных объектов.
 *
 * Правила объединения:
 * - обычные объекты объединяются рекурсивно;
 * - массивы заменяются целиком;
 * - примитивы заменяются целиком;
 * - undefined не перезаписывает уже существующее значение;
 * - null является допустимым явным значением и заменяет прежнее значение.
 *
 * @param {Object} base Базовая конфигурация.
 * @param {Object} override Более приоритетная конфигурация.
 * @returns {Object} Новый объединённый объект.
 */
function deepMerge(base, override) {
  const result = isPlainObject(base) ? cloneValue(base) : {};

  if (!isPlainObject(override)) {
    return result;
  }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;

    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
      continue;
    }

    result[key] = cloneValue(value);
  }

  return result;
}

/**
 * Преобразует путь вида "motion.threshold" в массив сегментов.
 *
 * @param {string|string[]} configPath Путь к параметру.
 * @returns {string[]}
 */
function normalizePath(configPath) {
  const parts = Array.isArray(configPath)
    ? configPath.map((part) => String(part).trim())
    : String(configPath ?? '')
      .split('.')
      .map((part) => part.trim());

  if (parts.length === 0 || parts.some((part) => !part)) {
    throw new Error('Путь к параметру конфигурации не может быть пустым');
  }

  for (const part of parts) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') {
      throw new Error(`Недопустимый сегмент пути конфигурации: ${part}`);
    }
  }

  return parts;
}

/**
 * Возвращает значение из объекта по точечному пути.
 *
 * @param {Object} source Исходный объект.
 * @param {string|string[]} configPath Путь вида "motion.threshold".
 * @param {*} defaultValue Значение, возвращаемое при отсутствии пути.
 * @returns {*}
 */
function getByPath(source, configPath, defaultValue = undefined) {
  const parts = normalizePath(configPath);
  let cursor = source;

  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') {
      return defaultValue;
    }

    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      return defaultValue;
    }

    cursor = cursor[part];
  }

  return cursor;
}

/**
 * Устанавливает значение в объекте по точечному пути.
 * Промежуточные объекты создаются автоматически.
 *
 * @param {Object} target Изменяемый объект.
 * @param {string|string[]} configPath Путь вида "motion.threshold".
 * @param {*} value Новое значение.
 * @returns {Object} Переданный объект target.
 */
function setByPath(target, configPath, value) {
  if (!isPlainObject(target)) {
    throw new TypeError('setByPath ожидает обычный объект target');
  }

  const parts = normalizePath(configPath);
  let cursor = target;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];

    if (!isPlainObject(cursor[part])) {
      cursor[part] = {};
    }

    cursor = cursor[part];
  }

  cursor[parts.at(-1)] = cloneValue(value);
  return target;
}

/**
 * Удаляет значение из объекта по точечному пути и очищает пустые ветви.
 *
 * @param {Object} target Изменяемый объект.
 * @param {string|string[]} configPath Путь к удаляемому значению.
 * @returns {boolean} true, если значение существовало и было удалено.
 */
function deleteByPath(target, configPath) {
  if (!isPlainObject(target)) return false;

  const parts = normalizePath(configPath);
  const parents = [];
  let cursor = target;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isPlainObject(cursor[part])) return false;
    parents.push([cursor, part]);
    cursor = cursor[part];
  }

  const finalKey = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(cursor, finalKey)) return false;

  delete cursor[finalKey];

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index];
    if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }

  return true;
}

/**
 * Подсчитывает количество конечных runtime-параметров.
 * Например, { motion: { threshold: 10, blurSize: 5 } } содержит 2 значения.
 *
 * @param {*} value Проверяемая ветвь.
 * @returns {number}
 */
function countLeafValues(value) {
  if (!isPlainObject(value)) return value === undefined ? 0 : 1;

  return Object.values(value).reduce(
    (total, child) => total + countLeafValues(child),
    0,
  );
}

/**
 * Центральный сервис конфигурации конвейера обработки.
 *
 * Итоговая конфигурация строится по приоритету:
 *
 * 1. встроенный безопасный профиль;
 * 2. legacy-файл motion.config.js;
 * 3. активный preset/custom профиль;
 * 4. runtime-переопределения в памяти.
 *
 * Ни один модуль обработки не должен самостоятельно читать файлы профилей.
 * Вместо этого он получает готовую секцию через методы ProfileManager.
 */
class ProfileManager extends EventEmitter {
  /**
   * @param {Object} options Параметры менеджера.
   * @param {ProfileStorage} [options.storage] Хранилище файлов профилей.
   * @param {string} [options.legacyMotionConfigPath] Путь к motion.config.js.
   * @param {Object} [options.defaultProfile] Встроенный резервный профиль.
   * @param {Object} [options.logger] Объект логирования, совместимый с Logger.
   */
  constructor({
    storage = new ProfileStorage(),
    legacyMotionConfigPath = path.join(__dirname, 'motion.config.js'),
    defaultProfile = DEFAULT_PROCESSING_PROFILE,
    logger = defaultLogger,
  } = {}) {
    super();

    this.storage = storage;
    this.legacyMotionConfigPath = legacyMotionConfigPath;
    this.defaultProfile = cloneValue(defaultProfile);
    this.logger = logger;

    this.activeProfile = null;
    this.runtimeOverrides = {};
    this.effectiveConfig = cloneValue(this.defaultProfile.parameters ?? {});

    this.initialized = false;
    this.dirty = false;
    this.loadedAt = null;
    this.lastConfigurationChangeAt = null;
  }

  /**
   * Загружает конфигурацию с диска и строит итоговое дерево параметров.
   * Метод безопасен для повторного вызова.
   *
   * @returns {Object} Копия итоговой конфигурации.
   */
  initialize() {
    return this.load();
  }

  /**
   * Основной метод первоначальной загрузки.
   *
   * @returns {Object} Копия итоговой конфигурации.
   */
  load() {
    this.logger.log('[ProfileManager] Загрузка конфигурации...');
    this.storage.ensureDirectories();

    this.activeProfile = null;
    this.runtimeOverrides = {};
    this.dirty = false;

    this.logger.log('[ProfileManager] ✓ Встроенные значения загружены');

    const activeReference = this.#loadActiveReferenceSafely();
    if (activeReference) {
      try {
        this.activeProfile = this.storage.loadProfile(
          activeReference.scope,
          activeReference.profileId,
        );

        this.logger.log(
          `[ProfileManager] ✓ Активный профиль: ${activeReference.scope}/${activeReference.profileId}`,
        );
      } catch (error) {
        this.activeProfile = null;
        this.logger.warn(
          `[ProfileManager] ⚠ Активный профиль не загружен: ${error.message}`,
        );
      }
    } else {
      this.logger.log(
        '[ProfileManager] ℹ Активный профиль не выбран; используется базовая конфигурация',
      );
    }

    this.initialized = true;
    this.loadedAt = new Date().toISOString();
    this.buildConfiguration({ emitEvent: false, logLegacyResult: true });

    const info = this.getProfileInfo();
    this.emit('loaded', info);
    this.emit('profile-loaded', this.getActiveProfile());
    this.emit('configuration-changed', this.getEffectiveConfig());

    this.logger.log('[ProfileManager] ✓ Итоговая конфигурация построена');
    return this.getEffectiveConfig();
  }

  /**
   * Повторно читает active-profile.json и сам активный профиль с диска.
   * Несохранённые runtime-переопределения при перезагрузке сбрасываются.
   *
   * @returns {Object} Копия итоговой конфигурации.
   */
  reload() {
    return this.load();
  }

  /**
   * Перестраивает effectiveConfig из всех уровней конфигурации.
   * Обычно этот метод вызывается автоматически после изменения состояния.
   *
   * @param {Object} options Параметры перестройки.
   * @param {boolean} [options.emitEvent=true] Отправлять configuration-changed.
   * @param {boolean} [options.logLegacyResult=false] Печатать результат чтения legacy-конфига.
   * @returns {Object} Копия итоговой конфигурации.
   */
  buildConfiguration({ emitEvent = true, logLegacyResult = false } = {}) {
    this.#assertInitialized();

    let configuration = cloneValue(this.defaultProfile.parameters ?? {});

    const legacyMotionConfig = this.#loadLegacyMotionConfig(logLegacyResult);
    if (legacyMotionConfig) {
      configuration = deepMerge(configuration, {
        motion: legacyMotionConfig,
      });
    }

    if (this.activeProfile) {
      configuration = deepMerge(
        configuration,
        this.activeProfile.parameters ?? {},
      );
    }

    configuration = deepMerge(configuration, this.runtimeOverrides);
    this.effectiveConfig = configuration;
    this.lastConfigurationChangeAt = new Date().toISOString();

    if (emitEvent) {
      this.emit('configuration-changed', this.getEffectiveConfig());
    }

    return this.getEffectiveConfig();
  }

  /**
   * Возвращает полную итоговую конфигурацию.
   * Возвращается копия, поэтому вызывающий код не может случайно изменить
   * внутреннее состояние ProfileManager.
   *
   * @returns {Object}
   */
  getEffectiveConfig() {
    this.#assertInitialized();
    return cloneValue(this.effectiveConfig);
  }

  /**
   * Возвращает отдельный параметр итоговой конфигурации по точечному пути.
   *
   * @param {string|string[]} configPath Путь вида "motion.threshold".
   * @param {*} [defaultValue] Значение при отсутствии параметра.
   * @returns {*}
   */
  get(configPath, defaultValue = undefined) {
    this.#assertInitialized();
    return cloneValue(getByPath(this.effectiveConfig, configPath, defaultValue));
  }

  /**
   * Возвращает итоговую конфигурацию детектора движения.
   *
   * Для обратной совместимости выполняется нормализация minArea/minBoxArea.
   *
   * @returns {Object}
   */
  getMotionConfig() {
    const motion = this.#getSection('motion');

    const minAreaIsValid = Number.isFinite(Number(motion.minArea));
    const minBoxAreaIsValid = Number.isFinite(Number(motion.minBoxArea));

    if (!minAreaIsValid && minBoxAreaIsValid) {
      motion.minArea = Number(motion.minBoxArea);
    }

    if (!minBoxAreaIsValid && minAreaIsValid) {
      motion.minBoxArea = Number(motion.minArea);
    }

    return motion;
  }

  /** @returns {Object} Итоговые параметры сопровождения. */
  getTrackingConfig() {
    return this.#getSection('tracking');
  }

  /** @returns {Object} Итоговые параметры визуализации. */
  getRendererConfig() {
    return this.#getSection('renderer');
  }

  /**
   * Совместимый псевдоним для кода, использующего имя render.
   *
   * @returns {Object}
   */
  getRenderConfig() {
    const renderer = this.getRendererConfig();
    return Object.keys(renderer).length > 0
      ? renderer
      : this.#getSection('render');
  }

  /** @returns {Object} Итоговые параметры восстановления цели. */
  getRecoveryConfig() {
    return this.#getSection('recovery');
  }

  /** @returns {Object} Итоговые параметры YOLO-детектора. */
  getYoloConfig() {
    return this.#getSection('yolo');
  }

  /**
   * Возвращает активный профиль в сериализуемом виде.
   *
   * @returns {Object|null}
   */
  getActiveProfile() {
    return this.activeProfile ? this.activeProfile.toJSON() : null;
  }

  /**
   * Возвращает краткую служебную информацию для API и Operator Console.
   *
   * @returns {Object}
   */
  getProfileInfo() {
    const active = this.getActiveProfile();

    return {
      initialized: this.initialized,
      profileId: active?.id ?? this.defaultProfile.id ?? 'built-in-default',
      profileName: active?.name ?? this.defaultProfile.name ?? 'Встроенный профиль',
      scope: active?.scope ?? this.defaultProfile.scope ?? 'built-in',
      readOnly: active?.readOnly ?? true,
      schemaVersion: active?.schemaVersion ?? this.defaultProfile.schemaVersion ?? 1,
      revision: active?.revision ?? 0,
      dirty: this.dirty,
      runtimeOverrideCount: countLeafValues(this.runtimeOverrides),
      loadedAt: this.loadedAt,
      lastConfigurationChangeAt: this.lastConfigurationChangeAt,
    };
  }

  /**
   * Старый совместимый метод состояния.
   * Новому HTTP API рекомендуется использовать getProfileInfo().
   *
   * @returns {Object}
   */
  getStatus() {
    return {
      ...this.getProfileInfo(),
      activeProfile: this.getActiveProfile(),
      runtimeOverrides: this.getRuntimeOverrides(),
    };
  }

  /**
   * Возвращает копию всех runtime-переопределений.
   *
   * @returns {Object}
   */
  getRuntimeOverrides() {
    return cloneValue(this.runtimeOverrides);
  }

  /**
   * Возвращает список preset- и custom-профилей.
   * Повреждённые файлы ProfileStorage пропускает с предупреждением.
   *
   * @returns {{ presets: Object[], custom: Object[] }}
   */
  listProfiles() {
    return {
      presets: this.storage.listProfiles('preset'),
      custom: this.storage.listProfiles('custom'),
    };
  }

  /**
   * Активирует профиль и сохраняет ссылку в active-profile.json.
   * Runtime-переопределения при смене профиля сбрасываются.
   *
   * @param {'preset'|'custom'} scope Область хранения профиля.
   * @param {string} profileId Идентификатор профиля.
   * @returns {Object} Активированный профиль.
   */
  activateProfile(scope, profileId) {
    this.#assertInitialized();

    const profile = this.storage.loadProfile(scope, profileId);
    this.storage.saveActiveProfileReference({
      scope: profile.scope,
      profileId: profile.id,
    });

    this.activeProfile = profile;
    this.runtimeOverrides = {};
    this.dirty = false;
    this.buildConfiguration();

    const active = this.getActiveProfile();
    this.emit('profile-activated', active);
    return active;
  }

  /**
   * Отключает внешний активный профиль.
   * После этого остаются встроенные значения и motion.config.js.
   *
   * @returns {Object} Итоговая конфигурация.
   */
  clearActiveProfile() {
    this.#assertInitialized();

    this.storage.saveActiveProfileReference(null);
    this.activeProfile = null;
    this.runtimeOverrides = {};
    this.dirty = false;

    const configuration = this.buildConfiguration();
    this.emit('profile-activated', null);
    return configuration;
  }

  /**
   * Устанавливает одно runtime-значение по точечному пути.
   * Изменение существует только в памяти до вызова saveProfile().
   *
   * @param {string|string[]} configPath Путь вида "motion.threshold".
   * @param {*} value Новое значение.
   * @returns {Object} Итоговая конфигурация.
   */
  setRuntimeOverride(configPath, value) {
    this.#assertInitialized();

    setByPath(this.runtimeOverrides, configPath, value);
    this.#markRuntimeChanged();
    return this.getEffectiveConfig();
  }

  /**
   * Объединяет сразу несколько runtime-переопределений.
   * Сохранён для совместимости с первой версией ProfileManager.
   *
   * @param {Object} overrides Дерево переопределений.
   * @returns {Object} Итоговая конфигурация.
   */
  setRuntimeOverrides(overrides) {
    this.#assertInitialized();

    if (!isPlainObject(overrides)) {
      throw new TypeError('Runtime-переопределения должны быть обычным объектом');
    }

    this.runtimeOverrides = deepMerge(this.runtimeOverrides, overrides);
    this.#markRuntimeChanged();
    return this.getEffectiveConfig();
  }

  /**
   * Удаляет одно runtime-переопределение.
   *
   * @param {string|string[]} configPath Путь к параметру.
   * @returns {Object} Итоговая конфигурация.
   */
  clearRuntimeOverride(configPath) {
    this.#assertInitialized();

    deleteByPath(this.runtimeOverrides, configPath);
    this.#markRuntimeChanged();
    return this.getEffectiveConfig();
  }

  /**
   * Полностью очищает runtime-переопределения.
   *
   * @returns {Object} Итоговая конфигурация.
   */
  clearRuntimeOverrides() {
    this.#assertInitialized();

    this.runtimeOverrides = {};
    this.#markRuntimeChanged();
    return this.getEffectiveConfig();
  }

  /**
   * Сохраняет custom-профиль.
   *
   * По умолчанию в профиль записывается текущая effective-конфигурация,
   * включая runtime-изменения. Можно передать собственный объект parameters.
   * Preset-профили никогда не перезаписываются.
   *
   * @param {Object} profileData Метаданные сохраняемого профиля.
   * @param {string} profileData.id Идентификатор custom-профиля.
   * @param {string} [profileData.name] Отображаемое имя.
   * @param {string} [profileData.description] Описание.
   * @param {Object} [profileData.parameters] Сохраняемые параметры.
   * @param {boolean} [profileData.activate=true] Активировать после сохранения.
   * @param {string} [profileData.lastChange] Комментарий изменения.
   * @returns {Object} Сохранённый профиль.
   */
  saveProfile(profileData = {}) {
    this.#assertInitialized();

    if (!isPlainObject(profileData)) {
      throw new TypeError('Данные сохраняемого профиля должны быть объектом');
    }

    const id = String(profileData.id ?? this.activeProfile?.id ?? '').trim();
    if (!id) {
      throw new Error('Для сохранения профиля необходимо указать id');
    }

    const existingCustom = this.storage.profileExists('custom', id)
      ? this.storage.loadProfile('custom', id).toJSON()
      : null;

    const now = new Date().toISOString();
    const revision = Number.isInteger(profileData.revision)
      ? profileData.revision
      : (existingCustom?.revision ?? 0) + 1;

    const parameters = isPlainObject(profileData.parameters)
      ? cloneValue(profileData.parameters)
      : this.getEffectiveConfig();

    const saved = this.storage.saveCustomProfile({
      schemaVersion: Number.isInteger(profileData.schemaVersion)
        ? profileData.schemaVersion
        : existingCustom?.schemaVersion
          ?? this.activeProfile?.schemaVersion
          ?? this.defaultProfile.schemaVersion
          ?? 1,
      id,
      name: String(
        profileData.name
          ?? existingCustom?.name
          ?? this.activeProfile?.name
          ?? id,
      ).trim(),
      description: String(
        profileData.description
          ?? existingCustom?.description
          ?? this.activeProfile?.description
          ?? '',
      ),
      basedOn: profileData.basedOn
        ?? existingCustom?.basedOn
        ?? this.activeProfile?.id
        ?? this.defaultProfile.id
        ?? null,
      createdAt: existingCustom?.createdAt ?? profileData.createdAt ?? now,
      updatedAt: now,
      revision,
      lastChange: profileData.lastChange ?? null,
      parameters,
    });

    this.storage.appendHistory(id, {
      savedAt: now,
      revision: saved.revision,
      lastChange: saved.lastChange,
      profile: saved.toJSON(),
    });

    const shouldActivate = profileData.activate !== false;
    if (shouldActivate) {
      this.storage.saveActiveProfileReference({
        scope: 'custom',
        profileId: saved.id,
      });
      this.activeProfile = saved;
      this.runtimeOverrides = {};
      this.dirty = false;
      this.buildConfiguration();
    }

    const result = saved.toJSON();
    this.emit('profile-saved', cloneValue(result));
    return result;
  }

  /**
   * Возвращает копию указанной секции effectiveConfig.
   * Отсутствующая секция представляется пустым объектом.
   *
   * @param {string} sectionName Имя секции.
   * @returns {Object}
   */
  #getSection(sectionName) {
    this.#assertInitialized();
    const section = this.effectiveConfig[sectionName];
    return isPlainObject(section) ? cloneValue(section) : {};
  }

  /**
   * Обновляет признаки runtime-состояния и рассылает события.
   */
  #markRuntimeChanged() {
    this.dirty = countLeafValues(this.runtimeOverrides) > 0;
    this.buildConfiguration();
    this.emit('runtime-changed', this.getRuntimeOverrides());
  }

  /**
   * Безопасно читает legacy motion.config.js.
   * Ошибка внешнего файла никогда не должна останавливать приложение.
   *
   * @param {boolean} logResult Печатать диагностические сообщения.
   * @returns {Object|null}
   */
  #loadLegacyMotionConfig(logResult = false) {
    if (!fs.existsSync(this.legacyMotionConfigPath)) {
      if (logResult) {
        this.logger.warn(
          '[ProfileManager] ⚠ motion.config.js не найден; используются встроенные значения',
        );
      }
      return null;
    }

    try {
      const resolvedPath = require.resolve(this.legacyMotionConfigPath);
      delete require.cache[resolvedPath];
      const config = require(resolvedPath);

      if (!isPlainObject(config)) {
        throw new TypeError('модуль должен экспортировать обычный объект');
      }

      if (logResult) {
        this.logger.log('[ProfileManager] ✓ motion.config.js загружен');
      }

      return cloneValue(config);
    } catch (error) {
      if (logResult) {
        this.logger.warn(
          `[ProfileManager] ⚠ Ошибка motion.config.js: ${error.message}`,
        );
      }
      return null;
    }
  }

  /**
   * Безопасно читает active-profile.json.
   *
   * @returns {{scope: 'preset'|'custom', profileId: string}|null}
   */
  #loadActiveReferenceSafely() {
    try {
      return this.storage.loadActiveProfileReference();
    } catch (error) {
      this.logger.warn(
        `[ProfileManager] ⚠ Ошибка active-profile.json: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Не позволяет читать конфигурацию до initialize()/load().
   */
  #assertInitialized() {
    if (!this.initialized) {
      throw new Error(
        'ProfileManager.initialize() должен быть вызван до работы с конфигурацией',
      );
    }
  }
}

module.exports = ProfileManager;

// Экспортируем чистые вспомогательные функции для модульных тестов
// и будущего HTTP API редактора профилей.
module.exports.deepMerge = deepMerge;
module.exports.getByPath = getByPath;
module.exports.setByPath = setByPath;
module.exports.deleteByPath = deleteByPath;
module.exports.isPlainObject = isPlainObject;
