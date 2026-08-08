'use strict';

require('dotenv').config();

/**
 * Статический реестр источников.
 *
 * Сейчас используется как fallback для локальной разработки.
 * В будущем RuntimeSourceBinding будет приходить по API.
 *
 * Главный принцип:
 *
 *   каждый RTSP-поток может иметь собственный control.driver.
 *
 * Видео и управление могут находиться на разных IP.
 */

const cameraId =
  process.env.CAMERA_ID?.trim() ||
  'flir-m300-main';

const streamId =
  process.env.CAMERA_STREAM_ID?.trim() ||
  'visible-main';

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) ? value : fallback;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(name, fallback = false) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(
    String(value).trim().toLowerCase(),
  );
}

/**
 * Универсальная конфигурация управления именно активным потоком.
 *
 * Новые переменные STREAM_CONTROL_* имеют приоритет.
 * Старые CAMERA_CONTROL_* сохранены для обратной совместимости.
 */
const streamControlDriver =
  process.env.STREAM_CONTROL_DRIVER?.trim() ||
  process.env.CAMERA_CONTROL_DRIVER?.trim() ||
  'console';

const streamControlHost =
  process.env.STREAM_CONTROL_HOST?.trim() ||
  process.env.CAMERA_CONTROL_HOST?.trim() ||
  process.env.CAMERA_HOST?.trim() ||
  '192.168.1.101';

const streamControlPort = integerEnv(
  'STREAM_CONTROL_PORT',
  integerEnv(
    'CAMERA_CONTROL_PORT',
    streamControlDriver.toLowerCase().startsWith('vadir')
      ? 10930
      : 80,
  ),
);

const streamControlEnabled =
  process.env.STREAM_CONTROL_ENABLED !== undefined
    ? booleanEnv('STREAM_CONTROL_ENABLED', false)
    : process.env.CAMERA_CONTROL_ENABLED !== '0';

const allowMotion =
  process.env.STREAM_CONTROL_ALLOW_MOTION !== undefined
    ? booleanEnv('STREAM_CONTROL_ALLOW_MOTION', false)
    : (
      streamControlDriver.toLowerCase().startsWith('vadir')
        ? booleanEnv('VADIR_ALLOW_MOTION', false)
        : booleanEnv('CAMERA_ONVIF_ALLOW_MOTION', false)
    );

module.exports = {
  activeCameraId: cameraId,
  activeStreamId: streamId,

  devices: [
    {
      id: cameraId,
      name:
        process.env.CAMERA_NAME?.trim() ||
        'Основная камера',
      manufacturer:
        process.env.CAMERA_MANUFACTURER?.trim() ||
        'Unknown',
      model:
        process.env.CAMERA_MODEL?.trim() ||
        'Unknown',
      host:
        process.env.CAMERA_HOST?.trim() ||
        '192.168.1.101',

      streams: [
        {
          id: streamId,
          sourceId:
            process.env.SOURCE_ID?.trim() ||
            `${cameraId}:${streamId}`,
          type:
            process.env.CAMERA_STREAM_TYPE?.trim() ||
            'visible',
          role: 'analytics',

          /*
           * RTSP относится только к видеопотоку.
           * Он не обязан совпадать с адресом управления.
           */
          rtspUrl:
            process.env.CAMERA_RTSP_URL?.trim() ||
            'rtsp://192.168.1.101:554/video1',

          /*
           * Управление назначается конкретному потоку.
           */
          control: {
            enabled: streamControlEnabled,
            driver: streamControlDriver,

            options: {
              host: streamControlHost,
              port: streamControlPort,

              username:
                process.env.STREAM_CONTROL_USERNAME ??
                process.env.CAMERA_CONTROL_USERNAME ??
                '',

              password:
                process.env.STREAM_CONTROL_PASSWORD ??
                process.env.CAMERA_CONTROL_PASSWORD ??
                '',

              profileToken:
                process.env.STREAM_ONVIF_PROFILE_TOKEN?.trim() ||
                process.env.CAMERA_ONVIF_PROFILE_TOKEN?.trim() ||
                'MP0',

              connectTimeoutMs: integerEnv(
                'STREAM_CONTROL_CONNECT_TIMEOUT_MS',
                integerEnv(
                  'CAMERA_ONVIF_CONNECT_TIMEOUT_MS',
                  8000,
                ),
              ),

              moveTimeoutMs: integerEnv(
                'STREAM_CONTROL_MOVE_TIMEOUT_MS',
                integerEnv(
                  'CAMERA_ONVIF_MOVE_TIMEOUT_MS',
                  1500,
                ),
              ),

              responseTimeoutMs: integerEnv(
                'VADIR_RESPONSE_TIMEOUT_MS',
                2000,
              ),

              reconnectDelayMs: integerEnv(
                'VADIR_RECONNECT_DELAY_MS',
                1000,
              ),

              allowMotion,
              allowZoom:
                streamControlDriver
                  .toLowerCase()
                  .startsWith('vadir')
                  ? booleanEnv('VADIR_ALLOW_ZOOM', false)
                  : false,

              logCommands:
                process.env.STREAM_CONTROL_LOG_COMMANDS !== '0' &&
                process.env.VADIR_LOG_COMMANDS !== '0',

              pollTelemetry:
                booleanEnv('VADIR_POLL_TELEMETRY', false),

              maxPanRate:
                numberEnv('VADIR_MAX_PAN_RATE', 15.70),
              maxTiltRate:
                numberEnv('VADIR_MAX_TILT_RATE', 10.46),
              maxZoomRate:
                numberEnv('VADIR_MAX_ZOOM_RATE', 50),
            },

            dispatcher: {
              minIntervalMs: integerEnv(
                'STREAM_COMMAND_INTERVAL_MS',
                integerEnv(
                  'CAMERA_COMMAND_INTERVAL_MS',
                  100,
                ),
              ),

              repeatIntervalMs: integerEnv(
                'STREAM_COMMAND_REPEAT_MS',
                integerEnv(
                  'CAMERA_COMMAND_REPEAT_MS',
                  500,
                ),
              ),

              commandTimeoutMs: integerEnv(
                'STREAM_COMMAND_TIMEOUT_MS',
                integerEnv(
                  'CAMERA_COMMAND_TIMEOUT_MS',
                  streamControlDriver
                    .toLowerCase()
                    .startsWith('vadir')
                    ? 2500
                    : 9000,
                ),
              ),
            },

            axes: {
              invertPan:
                booleanEnv('STREAM_INVERT_PAN') ||
                booleanEnv('CAMERA_INVERT_PAN'),

              invertTilt:
                booleanEnv('STREAM_INVERT_TILT') ||
                booleanEnv('CAMERA_INVERT_TILT'),

              minPanSpeed: numberEnv(
                'STREAM_MIN_PAN_SPEED',
                numberEnv('CAMERA_MIN_PAN_SPEED', 0.04),
              ),

              maxPanSpeed: numberEnv(
                'STREAM_MAX_PAN_SPEED',
                numberEnv('CAMERA_MAX_PAN_SPEED', 0.30),
              ),

              minTiltSpeed: numberEnv(
                'STREAM_MIN_TILT_SPEED',
                numberEnv('CAMERA_MIN_TILT_SPEED', 0.02),
              ),

              maxTiltSpeed: numberEnv(
                'STREAM_MAX_TILT_SPEED',
                numberEnv('CAMERA_MAX_TILT_SPEED', 0.10),
              ),
            },
          },
        },
      ],

      /*
       * Device-level control больше не используется основной конфигурацией.
       * CameraRegistry всё ещё поддерживает его как fallback для старых
       * конфигурационных файлов.
       */
    },
  ],
};
