'use strict';

require('dotenv').config();

/**
 * Реестр физических камер и связанных с ними видеопотоков.
 *
 * Пока используется одна FLIR M300 и совместимость с CAMERA_RTSP_URL.
 * При добавлении новых устройств каждая камера получает собственный id,
 * набор streams и отдельную секцию control.
 */
const cameraId = process.env.CAMERA_ID?.trim() || 'flir-m300-main';
const streamId = process.env.CAMERA_STREAM_ID?.trim() || 'visible-main';

module.exports = {
  activeCameraId: cameraId,
  activeStreamId: streamId,

  devices: [
    {
      id: cameraId,
      name: process.env.CAMERA_NAME?.trim() || 'FLIR M300 — основная',
      manufacturer: 'Teledyne FLIR',
      model: 'M300 Series',
      host: process.env.CAMERA_HOST?.trim() || '192.168.1.101',

      streams: [
        {
          id: streamId,
          type: process.env.CAMERA_STREAM_TYPE?.trim() || 'visible',
          role: 'analytics',
          rtspUrl: process.env.CAMERA_RTSP_URL?.trim() ||
            'rtsp://192.168.1.101:554/video1',
        },
      ],

      control: {
        enabled: process.env.CAMERA_CONTROL_ENABLED !== '0',
        driver: process.env.CAMERA_CONTROL_DRIVER?.trim() || 'console',
        options: {
          host: process.env.CAMERA_CONTROL_HOST?.trim() ||
            process.env.CAMERA_HOST?.trim() ||
            '192.168.1.101',
          port: Number.parseInt(process.env.CAMERA_CONTROL_PORT || '80', 10),
          username: process.env.CAMERA_CONTROL_USERNAME || '',
          password: process.env.CAMERA_CONTROL_PASSWORD || '',
          profileToken: process.env.CAMERA_ONVIF_PROFILE_TOKEN?.trim() || 'MP0',
          connectTimeoutMs: Number.parseInt(
            process.env.CAMERA_ONVIF_CONNECT_TIMEOUT_MS || '8000',
            10,
          ),
          moveTimeoutMs: Number.parseInt(
            process.env.CAMERA_ONVIF_MOVE_TIMEOUT_MS || '1500',
            10,
          ),
          allowMotion: process.env.CAMERA_ONVIF_ALLOW_MOTION === '1',
          logCommands: process.env.CAMERA_ONVIF_LOG_COMMANDS !== '0',
        },
        dispatcher: {
          minIntervalMs: Number.parseInt(
            process.env.CAMERA_COMMAND_INTERVAL_MS || '100',
            10,
          ),
          repeatIntervalMs: Number.parseInt(
            process.env.CAMERA_COMMAND_REPEAT_MS || '500',
            10,
          ),
          commandTimeoutMs: Number.parseInt(
            process.env.CAMERA_COMMAND_TIMEOUT_MS || '9000',
            10,
          ),
        },
        axes: {
          invertPan: process.env.CAMERA_INVERT_PAN === '1',
          invertTilt: process.env.CAMERA_INVERT_TILT === '1',
          minPanSpeed: Number(process.env.CAMERA_MIN_PAN_SPEED || 0.15),
          maxPanSpeed: Number(process.env.CAMERA_MAX_PAN_SPEED || 1),
          minTiltSpeed: Number(process.env.CAMERA_MIN_TILT_SPEED || 0.15),
          maxTiltSpeed: Number(process.env.CAMERA_MAX_TILT_SPEED || 1),
        },
      },
    },
  ],
};
