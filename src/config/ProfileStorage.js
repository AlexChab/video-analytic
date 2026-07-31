'use strict';


const logger = require('../utils/Logger');
const fs = require('node:fs');
const path = require('node:path');
const ProcessingProfile = require('./ProcessingProfile');

/**
 * Изолирует все операции с файлами профилей.
 * Класс не знает ничего о MotionDetector и не объединяет конфигурации.
 */
class ProfileStorage {
  constructor({ rootDirectory = path.join(__dirname, 'processing-profiles') } = {}) {
    this.rootDirectory = rootDirectory;
    this.presetsDirectory = path.join(rootDirectory, 'presets');
    this.customDirectory = path.join(rootDirectory, 'custom');
    this.historyDirectory = path.join(rootDirectory, 'history');
    this.activeProfilePath = path.join(rootDirectory, 'active-profile.json');
  }

  ensureDirectories() {
    for (const directory of [
      this.presetsDirectory,
      this.customDirectory,
      this.historyDirectory,
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  loadProfile(scope, profileId) {
    const filePath = this.#profilePath(scope, profileId);
    const raw = fs.readFileSync(filePath, 'utf8');
    return new ProcessingProfile(JSON.parse(raw));
  }

  profileExists(scope, profileId) {
    return fs.existsSync(this.#profilePath(scope, profileId));
  }

  listProfiles(scope) {
    const directory = this.#scopeDirectory(scope);
    if (!fs.existsSync(directory)) return [];

    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        try {
          return this.loadProfile(scope, path.basename(entry.name, '.json')).toJSON();
        } catch (error) {
          logger.warn(`[ProfileStorage] Пропущен повреждённый профиль ${entry.name}: ${error.message}`);
          return null;
        }
      })
      .filter(Boolean);
  }

  loadActiveProfileReference() {
    if (!fs.existsSync(this.activeProfilePath)) return null;
    const data = JSON.parse(fs.readFileSync(this.activeProfilePath, 'utf8'));

    if (!data?.scope || !data?.profileId) return null;
    return {
      scope: data.scope === 'custom' ? 'custom' : 'preset',
      profileId: String(data.profileId),
    };
  }

  saveActiveProfileReference(reference) {
    this.ensureDirectories();
    this.#writeJsonAtomic(this.activeProfilePath, reference ?? {
      scope: null,
      profileId: null,
    });
  }

  saveCustomProfile(profileData) {
    const profile = new ProcessingProfile({
      ...profileData,
      scope: 'custom',
      readOnly: false,
    });
    this.ensureDirectories();
    const filePath = this.#profilePath('custom', profile.id);
    this.#writeJsonAtomic(filePath, profile.toJSON());
    return profile;
  }

  appendHistory(profileId, record) {
    this.ensureDirectories();
    const safeId = this.#safeId(profileId);
    const filePath = path.join(this.historyDirectory, `${safeId}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  #profilePath(scope, profileId) {
    return path.join(this.#scopeDirectory(scope), `${this.#safeId(profileId)}.json`);
  }

  #scopeDirectory(scope) {
    if (scope === 'preset') return this.presetsDirectory;
    if (scope === 'custom') return this.customDirectory;
    throw new Error(`Неизвестная область профиля: ${scope}`);
  }

  #safeId(profileId) {
    const id = String(profileId ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      throw new Error(`Недопустимый id профиля: ${id}`);
    }
    return id;
  }

  #writeJsonAtomic(filePath, value) {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  }
}

module.exports = ProfileStorage;
