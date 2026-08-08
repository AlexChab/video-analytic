'use strict';

require('dotenv').config();

const VadirCameraDriver = require(
  '../camera/drivers/VadirCameraDriver',
);

function booleanEnv(name, fallback = false) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(
    String(value).trim().toLowerCase(),
  );
}

async function main() {
  const allowMotion = booleanEnv('VADIR_TEST_ALLOW_MOTION', false);
  const testDirection = String(
    process.env.VADIR_TEST_DIRECTION || 'RIGHT',
  ).trim().toUpperCase();

  const testSpeed = Math.min(
    1,
    Math.max(0.01, Number(process.env.VADIR_TEST_SPEED || 0.10)),
  );

  const testDurationMs = Math.max(
    100,
    Number.parseInt(
      process.env.VADIR_TEST_DURATION_MS || '500',
      10,
    ),
  );

  const driver = new VadirCameraDriver({
    host:
      process.env.VADIR_CONTROL_HOST?.trim() ||
      process.env.VADIR_CAMERA_HOST?.trim() ||
      '192.168.1.106',

    port: Number.parseInt(
      process.env.VADIR_CONTROL_PORT || '10930',
      10,
    ),

    allowMotion,
    allowZoom: false,
    pollTelemetry: false,
    logCommands: true,
  });

  console.log('='.repeat(68));
  console.log('[VADIR TEST] Безопасная диагностика TCP-управления');
  console.log(
    `[VADIR TEST] Камера: ${driver.host}:${driver.port}`,
  );
  console.log(
    `[VADIR TEST] Физическое движение: ${
      allowMotion ? 'РАЗРЕШЕНО' : 'ЗАБЛОКИРОВАНО'
    }`,
  );
  console.log('='.repeat(68));

  try {
    await driver.connect();
    console.log('[VADIR TEST] ✓ TCP-соединение установлено');

    const queries = ['20PP', '20TP', '40ZP', 'A0ZP'];

    for (const address of queries) {
      try {
        const response = await driver.client.query(address);
        console.log(
          `[VADIR TEST] ${address} = ${response.value}`,
        );
      } catch (error) {
        console.log(
          `[VADIR TEST] ${address}: запрос не выполнен — ${error.message}`,
        );
      }
    }

    if (!allowMotion) {
      console.log(
        '[VADIR TEST] Команды движения не отправлялись.',
      );
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
      reason: 'VADIR_SAFE_TEST',
    };

    if (testDirection === 'LEFT' || testDirection === 'RIGHT') {
      command.pan = testDirection;
      command.panSpeed = testSpeed;
    } else if (testDirection === 'UP' || testDirection === 'DOWN') {
      command.tilt = testDirection;
      command.tiltSpeed = testSpeed;
    } else {
      throw new Error(
        'VADIR_TEST_DIRECTION: LEFT, RIGHT, UP или DOWN',
      );
    }

    console.log(
      `[VADIR TEST] Движение ${testDirection}; ` +
      `скорость=${testSpeed.toFixed(2)}; ` +
      `длительность=${testDurationMs} мс`,
    );

    await driver.move(command);

    await new Promise((resolve) => {
      setTimeout(resolve, testDurationMs);
    });

    await driver.stop('VADIR_TEST_FINISHED');
    console.log('[VADIR TEST] ✓ STOP отправлен');
  } finally {
    await driver.disconnect();
  }
}

main().catch((error) => {
  console.error(`[VADIR TEST] ОШИБКА: ${error.message}`);
  process.exitCode = 1;
});
