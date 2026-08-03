'use strict';

const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
});

const onvif = require('onvif');

const HOST = String(process.env.CAMERA_CONTROL_HOST ?? '').trim();
const PORT = Number(process.env.CAMERA_CONTROL_PORT ?? 80);
const USERNAME = String(process.env.CAMERA_CONTROL_USERNAME ?? '').trim();
const PASSWORD = String(process.env.CAMERA_CONTROL_PASSWORD ?? '');

const CONNECT_TIMEOUT_MS = Number(
  process.env.CAMERA_ONVIF_CONNECT_TIMEOUT_MS ?? 8000,
);

const PROFILE_TOKEN = String(
  process.env.CAMERA_ONVIF_TEST_PROFILE_TOKEN ?? 'MP0',
).trim();

const ALLOW_MOTION =
  String(process.env.CAMERA_ONVIF_TEST_ALLOW_MOTION ?? '0').trim() === '1';

const DIRECTION = String(
  process.env.CAMERA_ONVIF_TEST_DIRECTION ?? 'RIGHT',
).trim().toUpperCase();

const SPEED = clamp(
  Number(process.env.CAMERA_ONVIF_TEST_SPEED ?? 0.05),
  0.01,
  0.15,
);

const DURATION_MS = clamp(
  Number(process.env.CAMERA_ONVIF_TEST_DURATION_MS ?? 250),
  100,
  1000,
);

let camera = null;
let stopping = false;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function validateConfiguration() {
  if (!HOST) {
    throw new Error(
      'Не указан CAMERA_CONTROL_HOST в корневом файле .env.',
    );
  }

  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(`Некорректный CAMERA_CONTROL_PORT: ${PORT}`);
  }

  if (!PROFILE_TOKEN) {
    throw new Error('Не указан CAMERA_ONVIF_TEST_PROFILE_TOKEN.');
  }

  if (!['LEFT', 'RIGHT', 'UP', 'DOWN'].includes(DIRECTION)) {
    throw new Error(
      'CAMERA_ONVIF_TEST_DIRECTION должен быть LEFT, RIGHT, UP или DOWN.',
    );
  }
}

function printHeader() {
  console.log('='.repeat(68));
  console.log('[ONVIF MOVE TEST] Безопасный тест кратковременного движения');
  console.log(`[ONVIF MOVE TEST] Камера: ${HOST}:${PORT}`);
  console.log(`[ONVIF MOVE TEST] Профиль: ${PROFILE_TOKEN}`);
  console.log(`[ONVIF MOVE TEST] Направление: ${DIRECTION}`);
  console.log(`[ONVIF MOVE TEST] Скорость: ${SPEED.toFixed(3)}`);
  console.log(`[ONVIF MOVE TEST] Длительность: ${DURATION_MS} мс`);
  console.log(
    `[ONVIF MOVE TEST] Физическое движение: ${
      ALLOW_MOTION ? 'РАЗРЕШЕНО' : 'ЗАБЛОКИРОВАНО'
    }`,
  );
  console.log('='.repeat(68));
}

function connectCamera() {
  return new Promise((resolve, reject) => {
    let completed = false;

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      reject(
        new Error(`тайм-аут подключения через ${CONNECT_TIMEOUT_MS} мс`),
      );
    }, CONNECT_TIMEOUT_MS);

    try {
      const instance = new onvif.Cam(
        {
          hostname: HOST,
          port: PORT,
          username: USERNAME,
          password: PASSWORD,
          timeout: CONNECT_TIMEOUT_MS,
          preserveAddress: true,
        },
        function onConnected(error) {
          if (completed) return;

          clearTimeout(timer);
          completed = true;

          if (error) {
            reject(error);
            return;
          }

          resolve(this);
        },
      );

      void instance;
    } catch (error) {
      clearTimeout(timer);
      completed = true;
      reject(error);
    }
  });
}

function callOnvif(cam, methodName, ...args) {
  return new Promise((resolve, reject) => {
    const method = cam?.[methodName];

    if (typeof method !== 'function') {
      reject(new Error(`ONVIF-метод ${methodName} не поддерживается`));
      return;
    }

    let completed = false;

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      reject(
        new Error(`${methodName}: тайм-аут через ${CONNECT_TIMEOUT_MS} мс`),
      );
    }, CONNECT_TIMEOUT_MS);

    const callback = (error, result, xml) => {
      if (completed) return;

      clearTimeout(timer);
      completed = true;

      if (error) {
        reject(error);
        return;
      }

      resolve({ result, xml });
    };

    try {
      method.call(cam, ...args, callback);
    } catch (error) {
      clearTimeout(timer);
      completed = true;
      reject(error);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function movementVector() {
  switch (DIRECTION) {
    case 'LEFT':
      return { x: -SPEED, y: 0, zoom: 0 };
    case 'RIGHT':
      return { x: SPEED, y: 0, zoom: 0 };
    case 'UP':
      return { x: 0, y: SPEED, zoom: 0 };
    case 'DOWN':
      return { x: 0, y: -SPEED, zoom: 0 };
    default:
      return { x: 0, y: 0, zoom: 0 };
  }
}

async function getStatus(label) {
  try {
    const { result } = await callOnvif(camera, 'getStatus', {
      profileToken: PROFILE_TOKEN,
    });

    console.log(`[ONVIF MOVE TEST] ${label}:`);
    console.dir(result, {
      depth: 5,
      colors: false,
    });

    return result;
  } catch (error) {
    console.log(
      `[ONVIF MOVE TEST] ${label}: GetStatus недоступен — ${error.message}`,
    );
    return null;
  }
}

async function sendStop(reason) {
  if (!camera || stopping) return;

  stopping = true;

  try {
    await callOnvif(camera, 'stop', {
      profileToken: PROFILE_TOKEN,
      panTilt: true,
      zoom: true,
    });

    console.log(`[ONVIF MOVE TEST] ✓ STOP отправлен (${reason})`);
  } catch (error) {
    console.error(
      `[ONVIF MOVE TEST] ОШИБКА отправки STOP (${reason}): ${error.message}`,
    );
  } finally {
    stopping = false;
  }
}

async function emergencyShutdown(signal) {
  console.log(`\n[ONVIF MOVE TEST] Получен ${signal}. Отправляем аварийный STOP...`);
  await sendStop(signal);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => {
  emergencyShutdown('SIGINT').catch(() => process.exit(130));
});

process.once('SIGTERM', () => {
  emergencyShutdown('SIGTERM').catch(() => process.exit(143));
});

async function main() {
  validateConfiguration();
  printHeader();

  camera = await connectCamera();

  console.log('[ONVIF MOVE TEST] ✓ ONVIF-соединение установлено');

  await getStatus('Положение ДО теста');

  if (!ALLOW_MOTION) {
    console.log('');
    console.log('[ONVIF MOVE TEST] Движение не выполнялось.');
    console.log(
      '[ONVIF MOVE TEST] Для физического теста установите в .env:',
    );
    console.log('CAMERA_ONVIF_TEST_ALLOW_MOTION=1');
    return;
  }

  const vector = movementVector();

  console.log('');
  console.log(
    `[ONVIF MOVE TEST] Отправка ContinuousMove: ` +
    `x=${vector.x.toFixed(3)}, y=${vector.y.toFixed(3)}, ` +
    `zoom=${vector.zoom.toFixed(3)}`,
  );

  try {
    await callOnvif(camera, 'continuousMove', {
      profileToken: PROFILE_TOKEN,
      x: vector.x,
      y: vector.y,
      zoom: vector.zoom,

      // Библиотека agsh/onvif принимает timeout в миллисекундах
      // и преобразует его в ONVIF Duration.
      timeout: DURATION_MS + 500,
    });

    console.log('[ONVIF MOVE TEST] ✓ ContinuousMove принят камерой');

    await sleep(DURATION_MS);
  } finally {
    // STOP отправляется независимо от результата ожидания или движения.
    await sendStop('TEST_FINISHED');
  }

  await sleep(300);
  await getStatus('Положение ПОСЛЕ теста');

  console.log('');
  console.log('='.repeat(68));
  console.log('[ONVIF MOVE TEST] Тест завершён.');
  console.log('[ONVIF MOVE TEST] Камера должна быть остановлена.');
  console.log('='.repeat(68));
}

main().catch(async (error) => {
  console.error(`\n[ONVIF MOVE TEST] ОШИБКА: ${error.message}`);

  await sendStop('ERROR');

  if (process.env.ONVIF_TEST_DEBUG === '1') {
    console.error(error.stack);
  }

  process.exitCode = 1;
});
