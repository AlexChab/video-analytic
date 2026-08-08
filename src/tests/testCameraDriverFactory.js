'use strict';

const assert = require('node:assert/strict');
const CameraDriverFactory = require('../camera/CameraDriverFactory');

function main() {
  const consoleDriver = CameraDriverFactory.create('console');
  assert.equal(consoleDriver.constructor.name, 'ConsoleCameraDriver');

  const vadirDriver = CameraDriverFactory.create('vadir', {
    host: '127.0.0.1',
    port: 10930,
    allowMotion: false,
  });
  assert.equal(vadirDriver.constructor.name, 'VadirCameraDriver');

  assert.throws(
    () => CameraDriverFactory.create('unknown-driver'),
    /Неизвестный драйвер/,
  );

  console.log('[DRIVER FACTORY] ✓ console');
  console.log('[DRIVER FACTORY] ✓ vadir');
  console.log('[DRIVER FACTORY] ✓ неизвестный драйвер отклоняется');
}

try {
  main();
} catch (error) {
  console.error(`[DRIVER FACTORY] ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
}
