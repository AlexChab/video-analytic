'use strict';

const assert = require('node:assert/strict');
const VadirCameraDriver = require('../camera/drivers/VadirCameraDriver');

class FakeVadirClient {
  constructor() {
    this.connected = true;
    this.motionCalls = [];
    this.zoomCalls = [];
    this.telemetry = {};
  }

  async setMotion(panRate, tiltRate) {
    this.motionCalls.push({ panRate, tiltRate });
  }

  async setDayZoomRate(rate) {
    this.zoomCalls.push(rate);
  }

  async stopMotion() {
    this.motionCalls.push({ panRate: 0, tiltRate: 0 });
  }

  async stopZoom() {
    this.zoomCalls.push(0);
  }

  async close() {
    this.connected = false;
  }

  on() {}
  startPolling() {}
}

function createDriver({ allowMotion = true, allowZoom = false } = {}) {
  const driver = new VadirCameraDriver({
    host: '127.0.0.1',
    port: 10930,
    allowMotion,
    allowZoom,
    logCommands: false,
    maxPanRate: 15.70,
    maxTiltRate: 10.46,
    maxZoomRate: 50,
  });

  const fakeClient = new FakeVadirClient();
  driver.client = fakeClient;
  driver.connected = true;

  return { driver, fakeClient };
}

async function testDirectionMapping() {
  const { driver, fakeClient } = createDriver();

  await driver.move({
    pan: 'RIGHT',
    tilt: 'UP',
    zoom: 'STOP',
    panSpeed: 0.5,
    tiltSpeed: 0.25,
    zoomSpeed: 0,
    moving: true,
    reason: 'UNIT_TEST',
  });

  assert.equal(fakeClient.motionCalls.length, 1);
  assert.equal(fakeClient.motionCalls[0].panRate, 7.85);
  assert.equal(fakeClient.motionCalls[0].tiltRate, 2.615);

  await driver.move({
    pan: 'LEFT',
    tilt: 'DOWN',
    zoom: 'STOP',
    panSpeed: 0.1,
    tiltSpeed: 0.1,
    zoomSpeed: 0,
    moving: true,
    reason: 'UNIT_TEST',
  });

  assert.equal(fakeClient.motionCalls[1].panRate, -1.57);
  assert.equal(fakeClient.motionCalls[1].tiltRate, -1.046);
}

async function testClampAndStop() {
  const { driver, fakeClient } = createDriver();

  await driver.move({
    pan: 'RIGHT',
    tilt: 'UP',
    panSpeed: 5,
    tiltSpeed: -1,
    moving: true,
    reason: 'CLAMP_TEST',
  });

  assert.equal(fakeClient.motionCalls[0].panRate, 15.70);
  assert.equal(fakeClient.motionCalls[0].tiltRate, 0);

  await driver.move({
    pan: 'RIGHT',
    tilt: 'UP',
    panSpeed: 1,
    tiltSpeed: 1,
    moving: false,
    reason: 'STOP_TEST',
  });

  assert.deepEqual(
    fakeClient.motionCalls[1],
    { panRate: 0, tiltRate: 0 },
  );
}

async function testDryRunDoesNotMove() {
  const { driver, fakeClient } = createDriver({
    allowMotion: false,
  });

  const result = await driver.move({
    pan: 'RIGHT',
    tilt: 'STOP',
    panSpeed: 0.2,
    tiltSpeed: 0,
    moving: true,
    reason: 'DRY_TEST',
  });

  assert.equal(result.dryRun, true);
  assert.equal(fakeClient.motionCalls.length, 0);
}

async function testZoomLock() {
  const { driver, fakeClient } = createDriver({
    allowMotion: true,
    allowZoom: false,
  });

  await driver.move({
    pan: 'STOP',
    tilt: 'STOP',
    zoom: 'IN',
    panSpeed: 0,
    tiltSpeed: 0,
    zoomSpeed: 0.5,
    moving: false,
    reason: 'ZOOM_LOCK_TEST',
  });

  // При запрещённом zoom драйвер не отправляет ненулевую скорость.
  assert.deepEqual(fakeClient.zoomCalls, []);
}

async function main() {
  console.log('[VADIR DRIVER] Начало тестов');

  await testDirectionMapping();
  console.log('[VADIR DRIVER] ✓ Направления и коэффициенты');

  await testClampAndStop();
  console.log('[VADIR DRIVER] ✓ Ограничение скорости и STOP');

  await testDryRunDoesNotMove();
  console.log('[VADIR DRIVER] ✓ Dry-run не двигает камеру');

  await testZoomLock();
  console.log('[VADIR DRIVER] ✓ Zoom остаётся заблокированным');

  console.log('[VADIR DRIVER] ✓ Все тесты пройдены');
}

main().catch((error) => {
  console.error(`[VADIR DRIVER] ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
