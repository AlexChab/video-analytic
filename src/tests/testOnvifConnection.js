'use strict';

/**
 * Безопасная диагностика ONVIF-камеры.
 *
 * Скрипт только подключается к камере и читает сведения об устройстве,
 * профилях, потоках и PTZ-возможностях. Команды движения не отправляются.
 *
 * Запуск из корня проекта:
 *   node tests/testOnvifConnection.js
 */

require('dotenv').config();

const { Cam } = require('onvif');

const host = String(
  process.env.CAMERA_CONTROL_HOST || process.env.CAMERA_HOST || '',
).trim();
const port = positiveInteger(process.env.CAMERA_CONTROL_PORT, 80);
const username = String(process.env.CAMERA_CONTROL_USERNAME || '');
const password = String(process.env.CAMERA_CONTROL_PASSWORD || '');
const timeoutMs = positiveInteger(
  process.env.CAMERA_ONVIF_CONNECT_TIMEOUT_MS,
  5000,
);

if (!host) {
  console.error(
    '[ONVIF TEST] Не указан адрес камеры. Добавьте CAMERA_CONTROL_HOST в .env.',
  );
  process.exitCode = 1;
  return;
}

main().catch((error) => {
  console.error('\n[ONVIF TEST] ОШИБКА:', formatError(error));
  process.exitCode = 1;
});

async function main() {
  console.log('============================================================');
  console.log('[ONVIF TEST] Безопасная диагностика камеры');
  console.log(`[ONVIF TEST] Адрес: ${host}:${port}`);
  console.log(`[ONVIF TEST] Пользователь: ${username || '(не задан)'}`);
  console.log('[ONVIF TEST] Команды движения ОТКЛЮЧЕНЫ');
  console.log('============================================================');

  const camera = await connectCamera();
  console.log('[ONVIF TEST] ✓ ONVIF-соединение установлено');

  const deviceInformation = await optionalCall(
    camera,
    'getDeviceInformation',
    {},
  );
  printDeviceInformation(deviceInformation);

  const services = await optionalCall(camera, 'getServices', {
    includeCapability: true,
  });
  printServices(services);

  const capabilities = await optionalCall(camera, 'getCapabilities', {});
  printCapabilities(capabilities, camera);

  const profilesResult = await optionalCall(camera, 'getProfiles', {});
  const profiles = normalizeProfiles(profilesResult, camera);
  printProfiles(profiles);

  await printStreamUris(camera, profiles);
  await printPtzStatus(camera, profiles);

  console.log('\n============================================================');
  console.log('[ONVIF TEST] Диагностика завершена. Камера не перемещалась.');
  console.log('============================================================');
}

function connectCamera() {
  return new Promise((resolve, reject) => {
    let camera;

    const connectionTimer = setTimeout(() => {
      reject(new Error(`тайм-аут подключения через ${timeoutMs} мс`));
    }, timeoutMs + 1000);

    try {
      camera = new Cam(
        {
          hostname: host,
          port,
          username,
          password,
          timeout: timeoutMs,
          preserveAddress: true,
        },
        (error) => {
          clearTimeout(connectionTimer);

          if (error) {
            reject(new Error(`ошибка подключения: ${error.message}`));
            return;
          }

          resolve(camera);
        },
      );
    } catch (error) {
      clearTimeout(connectionTimer);
      reject(error);
    }
  });
}

/**
 * Вызывает callback-метод пакета onvif и не прерывает весь тест,
 * если конкретная дополнительная команда камерой не поддерживается.
 */
async function optionalCall(camera, methodName, options) {
  if (typeof camera?.[methodName] !== 'function') {
    console.log(`[ONVIF TEST] ℹ Метод ${methodName} отсутствует в клиенте`);
    return null;
  }

  try {
    return await callOnvif(camera, methodName, options);
  } catch (error) {
    console.log(`[ONVIF TEST] ⚠ ${methodName}: ${formatError(error)}`);
    return null;
  }
}

function callOnvif(camera, methodName, options = {}) {
  return new Promise((resolve, reject) => {
    const method = camera[methodName];

    method.call(camera, options, (error, result, xml) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result ?? xml ?? null);
    });
  });
}

function printDeviceInformation(info) {
  console.log('\n--- Устройство ---');

  if (!info) {
    console.log('Сведения об устройстве не получены.');
    return;
  }

  const source = info.data || info;
  console.log(`Производитель : ${value(source.manufacturer)}`);
  console.log(`Модель        : ${value(source.model)}`);
  console.log(`Прошивка      : ${value(source.firmwareVersion)}`);
  console.log(`Серийный №    : ${value(source.serialNumber)}`);
  console.log(`Hardware ID   : ${value(source.hardwareId)}`);
}

function printServices(servicesResult) {
  console.log('\n--- ONVIF-сервисы ---');

  const services = Array.isArray(servicesResult)
    ? servicesResult
    : servicesResult?.services || servicesResult?.data || [];

  if (!Array.isArray(services) || services.length === 0) {
    console.log('Список сервисов не получен.');
    return;
  }

  for (const service of services) {
    const namespace = service.namespace || service.Namespace || '(без namespace)';
    const xaddr = service.xaddr || service.XAddr || '(без XAddr)';
    console.log(`- ${namespace}`);
    console.log(`  ${xaddr}`);
  }
}

function printCapabilities(capabilitiesResult, camera) {
  console.log('\n--- Возможности ---');

  const capabilities = capabilitiesResult?.data || capabilitiesResult || {};
  const ptzXAddr =
    capabilities?.PTZ?.XAddr ||
    capabilities?.ptz?.xAddr ||
    camera?.ptzUrl ||
    null;
  const mediaXAddr =
    capabilities?.Media?.XAddr ||
    capabilities?.media?.xAddr ||
    camera?.media2Url ||
    camera?.mediaUrl ||
    null;

  console.log(`Media service : ${value(mediaXAddr)}`);
  console.log(`PTZ service   : ${value(ptzXAddr)}`);
  console.log(`PTZ доступен  : ${ptzXAddr ? 'ДА' : 'не подтверждено'}`);
}

function normalizeProfiles(result, camera) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.profiles)) return result.profiles;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(camera?.profiles)) return camera.profiles;

  const active = camera?.activeSource;
  return active ? [active] : [];
}

function printProfiles(profiles) {
  console.log('\n--- Media profiles ---');

  if (!profiles.length) {
    console.log('Профили не получены.');
    return;
  }

  profiles.forEach((profile, index) => {
    const token = profile.token || profile.profileToken || profile.$?.token;
    const name = profile.name || profile.Name || `Profile ${index + 1}`;
    const video =
      profile.videoEncoderConfiguration ||
      profile.videoEncoder ||
      profile.source ||
      {};
    const resolution = video.resolution || video.Resolution || {};

    console.log(`[${index + 1}] ${name}`);
    console.log(`    token      : ${value(token)}`);
    if (resolution.width || resolution.height) {
      console.log(
        `    resolution : ${value(resolution.width)}x${value(resolution.height)}`,
      );
    }
  });
}

async function printStreamUris(camera, profiles) {
  console.log('\n--- RTSP URI профилей ---');

  if (!profiles.length || typeof camera.getStreamUri !== 'function') {
    console.log('Получение Stream URI недоступно.');
    return;
  }

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const profileToken =
      profile.token || profile.profileToken || profile.$?.token;

    if (!profileToken) continue;

    try {
      const result = await callOnvif(camera, 'getStreamUri', {
        protocol: 'RTSP',
        profileToken,
      });
      const uri = result?.uri || result?.Uri || result?.mediaUri?.uri;
      console.log(`[${index + 1}] ${maskCredentials(value(uri))}`);
    } catch (error) {
      console.log(`[${index + 1}] ошибка: ${formatError(error)}`);
    }
  }
}

async function printPtzStatus(camera, profiles) {
  console.log('\n--- PTZ status ---');

  if (typeof camera.getStatus !== 'function') {
    console.log('Метод GetStatus отсутствует в клиенте.');
    return;
  }

  const activeToken =
    camera?.activeSource?.profileToken ||
    profiles[0]?.token ||
    profiles[0]?.profileToken ||
    profiles[0]?.$?.token;

  if (!activeToken) {
    console.log('Не найден profileToken для запроса PTZ status.');
    return;
  }

  try {
    const status = await callOnvif(camera, 'getStatus', {
      profileToken: activeToken,
    });
    console.dir(status, { depth: 5, colors: false });
  } catch (error) {
    console.log(`GetStatus недоступен: ${formatError(error)}`);
  }
}

function maskCredentials(uri) {
  return String(uri).replace(/:\/\/([^/@:]+):([^/@]+)@/g, '://***:***@');
}

function value(input) {
  if (input === undefined || input === null || input === '') return '(нет данных)';
  return String(input);
}

function positiveInteger(input, fallback) {
  const number = Number.parseInt(input, 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatError(error) {
  if (!error) return 'неизвестная ошибка';
  return error.message || String(error);
}
