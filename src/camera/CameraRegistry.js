'use strict';

const RuntimeSourceBinding = require('./RuntimeSourceBinding');

/** Связывает физическое устройство, его RTSP-потоки и драйвер управления. */
class CameraRegistry {
  constructor(configuration) {
    if (!configuration || !Array.isArray(configuration.devices)) {
      throw new TypeError('CameraRegistry требует devices[]');
    }
    this.configuration = configuration;
    this.devices = new Map();

    for (const device of configuration.devices) {
      if (!device?.id) throw new Error('Каждая камера должна иметь id');
      if (this.devices.has(device.id)) {
        throw new Error(`Повторяющийся id камеры: ${device.id}`);
      }
      this.devices.set(device.id, device);
    }
  }

  getDevice(id = this.configuration.activeCameraId) {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Камера не найдена: ${id}`);
    return device;
  }

  getStream(cameraId, streamId = this.configuration.activeStreamId) {
    const device = this.getDevice(cameraId);
    const stream = device.streams?.find((item) => item.id === streamId);
    if (!stream) {
      throw new Error(`Поток ${streamId} не найден у камеры ${device.id}`);
    }
    const control = stream.control ?? device.control ?? null;

    return new RuntimeSourceBinding({
      sourceId: stream.sourceId ?? `${device.id}:${stream.id}`,
      device,
      stream,
      control,
      origin: 'STATIC_REGISTRY',
    });
  }

  getActiveBinding() {
    return this.getStream(
      this.configuration.activeCameraId,
      this.configuration.activeStreamId,
    );
  }

  listDevices() {
    return Array.from(this.devices.values()).map((device) => ({
      id: device.id,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      streams: (device.streams ?? []).map((stream) => ({
        ...stream,
        controlDriver:
          stream.control?.driver ??
          device.control?.driver ??
          null,
        controlEnabled:
          (stream.control ?? device.control)?.enabled !== false,
      })),
      controlDriver: device.control?.driver ?? null,
    }));
  }
}

module.exports = CameraRegistry;
