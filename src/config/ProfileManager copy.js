'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const DEFAULT_PROCESSING_PROFILE = require('./DefaultProcessingProfile');
const ProfileStorage = require('./ProfileStorage');

/** Объединяет обычные объекты без изменения исходных значений. */
function deepMerge(base, override) {
  const result = structuredClone(base ?? {});

  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return result;
  }

  for (const [key, value] of Object.entries(override)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && result[key]
      && typeof result[key] === 'object'
      && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }

  return result;
}

/**
 * Единая точка получения конфигурации конвейера обработки.
 */
class ProfileManager extends EventEmitter {
  constructor({
    storage = new ProfileStorage(),
    legacyMotionConfigPath = path.join(__dirname, 'motion.config.js'),
  } = {}) {
    super();
    this.storage = storage;
    this.legacyMotionConfigPath = legacyMotionConfigPath;
    this.activeProfile = null;
    this.runtimeOverrides = {};
    this.effectiveParameters = structuredClone(
      DEFAULT_PROCESSING_PROFILE.parameters,
    );
    this.initialized = false;
    this.dirty = false;
  }

  initialize() {
    this.storage.ensureDirectories();

    let parameters = structuredClone(DEFAULT_PROCESSING_PROFILE.parameters);
    console.log('[ProfileManager] ✓ Встроенные значения загружены');

    const legacyMotionConfig = this.#loadLegacyMotionConfig();
    if (legacyMotionConfig) {
      parameters = deepMerge(parameters, { motion: legacyMotionConfig });
      console.log('[ProfileManager] ✓ motion.config.js загружен');
    }

    const activeReference = this.#loadActiveReferenceSafely();
    if (activeReference) {
      try {
        this.activeProfile = this.storage.loadProfile(
          activeReference.scope,
          activeReference.profileId,
        );
        parameters = deepMerge(parameters, this.activeProfile.parameters);
        console.log(
          `[ProfileManager] ✓ Активный профиль: ${activeReference.scope}/${activeReference.profileId}`,
        );
        this.emit('profile-loaded', this.getActiveProfile());
      } catch (error) {
        this.activeProfile = null;
        console.warn(`[ProfileManager] ⚠ Активный профиль не загружен: ${error.message}`);
      }
    } else {
      console.log('[ProfileManager] ℹ Активный профиль не выбран; используется motion.config.js');
    }

    this.effectiveParameters = deepMerge(parameters, this.runtimeOverrides);
    this.initialized = true;
    this.emit('configuration-changed', this.getEffectiveConfig());
    return this.getEffectiveConfig();
  }

  getEffectiveConfig() {
    this.#assertInitialized();
    return structuredClone(this.effectiveParameters);
  }

  getMotionConfig() {
    this.#assertInitialized();
    const motion = structuredClone(this.effectiveParameters.motion ?? {});

    // Поддерживаем старое имя minBoxArea и новое единое имя minArea.
    if (!Number.isFinite(Number(motion.minArea)) && Number.isFinite(Number(motion.minBoxArea))) {
      motion.minArea = Number(motion.minBoxArea);
    }

    return motion;
  }

  getActiveProfile() {
    return this.activeProfile ? this.activeProfile.toJSON() : null;
  }

  getStatus() {
    return {
      initialized: this.initialized,
      activeProfile: this.getActiveProfile(),
      dirty: this.dirty,
      runtimeOverrides: structuredClone(this.runtimeOverrides),
    };
  }

  activateProfile(scope, profileId) {
    this.activeProfile = this.storage.loadProfile(scope, profileId);
    this.storage.saveActiveProfileReference({ scope, profileId });
    this.runtimeOverrides = {};
    this.dirty = false;
    this.#rebuild();
    this.emit('profile-activated', this.getActiveProfile());
    return this.getActiveProfile();
  }

  clearActiveProfile() {
    this.activeProfile = null;
    this.storage.saveActiveProfileReference(null);
    this.runtimeOverrides = {};
    this.dirty = false;
    this.#rebuild();
  }

  setRuntimeOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new TypeError('Runtime-переопределения должны быть объектом');
    }
    this.runtimeOverrides = deepMerge(this.runtimeOverrides, overrides);
    this.dirty = Object.keys(this.runtimeOverrides).length > 0;
    this.#rebuild();
    this.emit('runtime-changed', structuredClone(this.runtimeOverrides));
    return this.getEffectiveConfig();
  }

  clearRuntimeOverrides() {
    this.runtimeOverrides = {};
    this.dirty = false;
    this.#rebuild();
  }

  #rebuild() {
    let parameters = structuredClone(DEFAULT_PROCESSING_PROFILE.parameters);
    const legacy = this.#loadLegacyMotionConfig(false);
    if (legacy) parameters = deepMerge(parameters, { motion: legacy });
    if (this.activeProfile) parameters = deepMerge(parameters, this.activeProfile.parameters);
    this.effectiveParameters = deepMerge(parameters, this.runtimeOverrides);
    this.emit('configuration-changed', this.getEffectiveConfig());
  }

  #loadLegacyMotionConfig(logErrors = true) {
    if (!fs.existsSync(this.legacyMotionConfigPath)) {
      if (logErrors) {
        console.warn('[ProfileManager] ⚠ motion.config.js не найден; используются встроенные значения');
      }
      return null;
    }

    try {
      const resolvedPath = require.resolve(this.legacyMotionConfigPath);
      delete require.cache[resolvedPath];
      const config = require(resolvedPath);
      return config && typeof config === 'object' ? config : null;
    } catch (error) {
      if (logErrors) {
        console.warn(`[ProfileManager] ⚠ Ошибка motion.config.js: ${error.message}`);
      }
      return null;
    }
  }

  #loadActiveReferenceSafely() {
    try {
      return this.storage.loadActiveProfileReference();
    } catch (error) {
      console.warn(`[ProfileManager] ⚠ Ошибка active-profile.json: ${error.message}`);
      return null;
    }
  }

  #assertInitialized() {
    if (!this.initialized) {
      throw new Error('ProfileManager.initialize() должен быть вызван до чтения конфигурации');
    }
  }
}

module.exports = ProfileManager;
module.exports.deepMerge = deepMerge;
