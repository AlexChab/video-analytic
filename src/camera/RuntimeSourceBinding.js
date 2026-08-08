'use strict';

/**
 * Неизменяемая связка видеопотока и драйвера управления.
 *
 * Видео и управление независимы:
 *
 * - stream.rtspUrl может вести на один IP;
 * - control.options.host может вести на другой IP;
 * - связь между ними определяется только этим binding.
 *
 * В следующем этапе такой же объект сможет приходить по API.
 */
class RuntimeSourceBinding {
  constructor({
    sourceId,
    device,
    stream,
    control = null,
    origin = 'STATIC_REGISTRY',
  }) {
    if (!device?.id) {
      throw new Error('RuntimeSourceBinding: device.id обязателен');
    }

    if (!stream?.id) {
      throw new Error('RuntimeSourceBinding: stream.id обязателен');
    }

    const resolvedSourceId = String(
      sourceId ?? `${device.id}:${stream.id}`,
    ).trim();

    if (!resolvedSourceId) {
      throw new Error('RuntimeSourceBinding: sourceId обязателен');
    }

    this.sourceId = resolvedSourceId;
    this.device = RuntimeSourceBinding.#clone(device);
    this.stream = RuntimeSourceBinding.#clone(stream);
    this.control = control
      ? RuntimeSourceBinding.#clone(control)
      : null;
    this.origin = String(origin || 'STATIC_REGISTRY');

    Object.freeze(this.device);
    Object.freeze(this.stream);

    if (this.control) {
      if (this.control.options) Object.freeze(this.control.options);
      if (this.control.dispatcher) Object.freeze(this.control.dispatcher);
      if (this.control.axes) Object.freeze(this.control.axes);
      Object.freeze(this.control);
    }

    Object.freeze(this);
  }

  get controlEnabled() {
    return Boolean(this.control) && this.control.enabled !== false;
  }

  get controlDriverName() {
    if (!this.controlEnabled) return 'console';
    return String(this.control.driver || 'console');
  }

  toJSON() {
    return {
      sourceId: this.sourceId,
      origin: this.origin,
      device: { ...this.device },
      stream: { ...this.stream },
      control: this.control
        ? {
          ...this.control,
          options: { ...(this.control.options ?? {}) },
          dispatcher: { ...(this.control.dispatcher ?? {}) },
          axes: { ...(this.control.axes ?? {}) },
        }
        : null,
      controlEnabled: this.controlEnabled,
      controlDriverName: this.controlDriverName,
    };
  }

  static #clone(value) {
    if (!value || typeof value !== 'object') return value;

    return {
      ...value,
      ...(value.options
        ? { options: { ...value.options } }
        : {}),
      ...(value.dispatcher
        ? { dispatcher: { ...value.dispatcher } }
        : {}),
      ...(value.axes
        ? { axes: { ...value.axes } }
        : {}),
    };
  }
}

module.exports = RuntimeSourceBinding;
