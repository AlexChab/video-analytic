'use strict';

// require('dotenv').config();
require('dotenv').config({
  path: require('node:path').resolve(__dirname, '../../.env'),
});

const VadirCameraDriver = require('../camera/drivers/VadirCameraDriver');

function booleanEnv(name, fallback = false) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(
    String(value).trim().toLowerCase(),
  );
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function readTelemetry(driver) {
  const addresses = ['20PP', '20TP', '40ZP', 'A0ZP'];
  const telemetry = {};

  for (const address of addresses) {
    try {
      const response = await driver.client.query(address);
      telemetry[address] = response.value;
    } catch (error) {
      telemetry[address] = `ERROR: ${error.message}`;
    }
  }

  return telemetry;
}

async function main() {
  const allowMotion = booleanEnv('VADIR_TEST_ALLOW_MOTION', false);
  const direction = String(process.env.VADIR_TEST_DIRECTION || 'RIGHT')
    .trim()
    .toUpperCase();

  const speed = Math.min(
    1,
    Math.max(0.01, numberEnv('VADIR_TEST_SPEED', 0.05)),
  );

  const durationMs = Math.max(
    100,
    Math.round(numberEnv('VADIR_TEST_DURATION_MS', 300)),
  );

  const settleMs = Math.max(
    100,
    Math.round(numberEnv('VADIR_TEST_SETTLE_MS', 300)),
  );

  const driver = new VadirCameraDriver({
    host:
      process.env.VADIR_CONTROL_HOST?.trim() ||
      process.env.VADIR_CAMERA_HOST?.trim() ||
      '192.168.1.106',

    port: Math.round(numberEnv('VADIR_CONTROL_PORT', 10930)),

    allowMotion,
    allowZoom: false,
    pollTelemetry: false,
    logCommands: true,
  });

  console.log('='.repeat(72));
  console.log('[VADIR LIVE] Диагностика TCP и безопасный импульс оси');
  console.log(`[VADIR LIVE] Камера: ${driver.host}:${driver.port}`);
  console.log(
    `[VADIR LIVE] Физическое движение: ${
      allowMotion ? 'РАЗРЕШЕНО' : 'ЗАБЛОКИРОВАНО'
    }`,
  );
  console.log('='.repeat(72));

  let movementStarted = false;

  try {
    await driver.connect();
    console.log('[VADIR LIVE] ✓ TCP-соединение установлено');

    const before = await readTelemetry(driver);
    console.log('[VADIR LIVE] Телеметрия ДО:', before);

    if (!allowMotion) {
      console.log('[VADIR LIVE] Команды движения не отправлялись.');
      return;
    }

    const command = {
      pan: 'STOP',
      tilt: 'STOP',
      zoom: 'STOP',
      panSpeed: 0,
      tiltSpeed: 0,
      zoomSpeed: 0,
      moving: true,
      reason: 'VADIR_AXIS_PULSE_TEST',
    };

    if (direction === 'LEFT' || direction === 'RIGHT') {
      command.pan = direction;
      command.panSpeed = speed;
    } else if (direction === 'UP' || direction === 'DOWN') {
      command.tilt = direction;
      command.tiltSpeed = speed;
    } else {
      throw new Error('VADIR_TEST_DIRECTION: LEFT, RIGHT, UP или DOWN');
    }

    console.log(
      `[VADIR LIVE] Импульс ${direction}; ` +
        `speed=${speed.toFixed(2)}; duration=${durationMs} мс`,
    );

    await driver.move(command);
    movementStarted = true;

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    await driver.stop('VADIR_AXIS_PULSE_FINISHED');
    movementStarted = false;
    console.log('[VADIR LIVE] ✓ STOP отправлен');

    await new Promise((resolve) => setTimeout(resolve, settleMs));

    const after = await readTelemetry(driver);
    console.log('[VADIR LIVE] Телеметрия ПОСЛЕ:', after);

    console.log(
      '[VADIR LIVE] Сравни 20PP/20TP и визуальное направление камеры.',
    );
  } finally {
    if (movementStarted) {
      try {
        await driver.stop('VADIR_TEST_FINALLY_STOP');
        console.log('[VADIR LIVE] ✓ Аварийный STOP из finally');
      } catch (error) {
        console.error(
          `[VADIR LIVE] Не удалось отправить аварийный STOP: ${error.message}`,
        );
      }
    }

    await driver.disconnect();
  }
}

main().catch((error) => {
  console.error(`[VADIR LIVE] ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
});
