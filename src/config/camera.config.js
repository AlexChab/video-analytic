'use strict';

require('dotenv').config();

/**
 * Читает положительное целое число из переменной окружения.
 * Если переменная не задана, используется значение по умолчанию.
 *
 * @param {string} name Название переменной окружения.
 * @param {number} defaultValue Значение по умолчанию.
 * @returns {number}
 */
function getPositiveInteger(name, defaultValue) {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Переменная ${name} должна содержать положительное целое число`,
    );
  }

  return value;
}

/**
 * Проверяет RTSP URL и возвращает его в нормализованном виде.
 *
 * Камера может работать как без авторизации:
 *   rtsp://192.168.1.101:554/video1
 *
 * так и с авторизацией:
 *   rtsp://user:password@192.168.1.101:554/video1
 *
 * @param {string} value RTSP URL.
 * @returns {string}
 */
function normalizeRtspUrl(value) {
  const rtspUrl = value.trim();

  if (!/^rtsps?:\/\//i.test(rtspUrl)) {
    throw new Error(
      'CAMERA_RTSP_URL должен начинаться с rtsp:// или rtsps://',
    );
  }

  return rtspUrl;
}

/**
 * Создаёт безопасный вариант адреса для журналирования.
 * Если в URL присутствуют логин и пароль, пароль заменяется на ***.
 * Для камеры без авторизации адрес остаётся без изменений.
 *
 * @param {string} rtspUrl Полный RTSP URL.
 * @returns {string}
 */
function createSafeRtspUrl(rtspUrl) {
  try {
    const parsedUrl = new URL(rtspUrl);

    if (parsedUrl.password) {
      parsedUrl.password = '***';
    }

    return parsedUrl.toString();
  } catch {
    // Сам URL уже проверен выше. Резервная маскировка нужна только
    // на случай особенностей конкретной версии Node.js.
    return rtspUrl.replace(
      /^(rtsps?:\/\/[^:@/]+):[^@/]+@/i,
      '$1:***@',
    );
  }
}

/**
 * Основной RTSP-источник.
 *
 * Для текущей камеры авторизация не требуется, поэтому достаточно адреса:
 *   rtsp://192.168.1.101:554/video1
 *
 * При необходимости адрес можно переопределить через CAMERA_RTSP_URL
 * в файле .env, не изменяя исходный код.
 */
const rtspUrl = normalizeRtspUrl(
  process.env.CAMERA_RTSP_URL || 'rtsp://192.168.1.101:554/video1',
);

const transport = (process.env.RTSP_TRANSPORT || 'tcp')
  .trim()
  .toLowerCase();

if (!['tcp', 'udp'].includes(transport)) {
  throw new Error('RTSP_TRANSPORT должен иметь значение tcp или udp');
}

module.exports = {
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',

  camera: {
    /** Полный адрес подключения к RTSP-потоку. */
    rtspUrl,

    /** Адрес для журналирования без открытого пароля. */
    safeRtspUrl: createSafeRtspUrl(rtspUrl),

    /** RTSP-транспорт. Для локальной сети по умолчанию используется TCP. */
    transport,
  },

  frame: {
    width: getPositiveInteger('FRAME_WIDTH', 1920),
    height: getPositiveInteger('FRAME_HEIGHT', 1080),
    fps: getPositiveInteger('FRAME_FPS', 25),
    channels: 3,
    pixelFormat: 'bgr24',
  },
};
