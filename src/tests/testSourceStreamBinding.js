'use strict';

const assert = require('node:assert/strict');
const CameraRegistry = require('../camera/CameraRegistry');

function main() {
  const registry = new CameraRegistry({
    activeCameraId: 'device-a',
    activeStreamId: 'stream-2',

    devices: [
      {
        id: 'device-a',

        control: {
          enabled: true,
          driver: 'onvif',
          options: { host: '10.0.0.10' },
        },

        streams: [
          {
            id: 'stream-1',
            rtspUrl: 'rtsp://10.0.0.20/one',
          },
          {
            id: 'stream-2',
            sourceId: 'source-vadir',
            rtspUrl: 'rtsp://10.0.0.30/two',
            control: {
              enabled: true,
              driver: 'vadir',
              options: {
                host: '192.168.1.106',
                port: 10930,
              },
            },
          },
        ],
      },
    ],
  });

  const binding = registry.getActiveBinding();

  assert.equal(binding.sourceId, 'source-vadir');
  assert.equal(binding.stream.rtspUrl, 'rtsp://10.0.0.30/two');
  assert.equal(binding.controlDriverName, 'vadir');
  assert.equal(binding.control.options.host, '192.168.1.106');
  assert.equal(binding.control.options.port, 10930);

  const fallback = registry.getStream('device-a', 'stream-1');
  assert.equal(fallback.controlDriverName, 'onvif');
  assert.equal(fallback.control.options.host, '10.0.0.10');

  console.log('[SOURCE BINDING] ✓ stream.control имеет приоритет');
  console.log('[SOURCE BINDING] ✓ device.control работает как fallback');
  console.log('[SOURCE BINDING] ✓ видео и управление используют разные IP');
}

try {
  main();
} catch (error) {
  console.error(`[SOURCE BINDING] ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
}
