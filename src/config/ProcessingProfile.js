'use strict';

/**
 * Модель и базовая проверка профиля обработки.
 */
class ProcessingProfile {
  constructor(data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('Профиль обработки должен быть объектом');
    }

    const id = String(data.id ?? '').trim();
    const name = String(data.name ?? '').trim();

    if (!id) {
      throw new Error('Профиль обработки должен содержать id');
    }

    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      throw new Error(`Недопустимый id профиля: ${id}`);
    }

    if (!name) {
      throw new Error('Профиль обработки должен содержать name');
    }

    if (!data.parameters || typeof data.parameters !== 'object') {
      throw new Error('Профиль обработки должен содержать объект parameters');
    }

    this.schemaVersion = Number.isInteger(data.schemaVersion)
      ? data.schemaVersion
      : 1;
    this.id = id;
    this.name = name;
    this.scope = data.scope === 'custom' ? 'custom' : 'preset';
    this.readOnly = this.scope === 'preset' || data.readOnly === true;
    this.description = String(data.description ?? '');
    this.basedOn = data.basedOn ?? null;
    this.createdAt = data.createdAt ?? null;
    this.updatedAt = data.updatedAt ?? null;
    this.revision = Number.isInteger(data.revision) ? data.revision : 1;
    this.lastChange = data.lastChange ?? null;
    this.parameters = structuredClone(data.parameters);
  }

  toJSON() {
    return {
      schemaVersion: this.schemaVersion,
      id: this.id,
      name: this.name,
      scope: this.scope,
      readOnly: this.readOnly,
      description: this.description,
      basedOn: this.basedOn,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      revision: this.revision,
      lastChange: this.lastChange,
      parameters: structuredClone(this.parameters),
    };
  }
}

module.exports = ProcessingProfile;
