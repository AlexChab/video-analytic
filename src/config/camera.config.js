require('dotenv').config();

/**
 * Читает обязательную строковую переменную окружения.
 *
 * @param {string} name Название переменной.
 * @returns {string}
 */
function getRequiredString(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения: ${name}`);
  }

  return value;
}

/**
 * Читает положительное целое число из переменной окружения.
 *
 * @param {string} name Название переменной.
 * @returns {number}
 */
function getPositiveInteger(name) {
  const rawValue = getRequiredString(name);
  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Переменная ${name} должна содержать положительное целое число`,
    );
  }

  return value;
}

const host = getRequiredString('CAMERA_HOST');
const port = getPositiveInteger('CAMERA_RTSP_PORT');
const username = getRequiredString('CAMERA_USERNAME');
const password = getRequiredString('CAMERA_PASSWORD');

const configuredPath = getRequiredString('CAMERA_RTSP_PATH');
const streamPath = configuredPath.startsWith('/')
  ? configuredPath
  : `/${configuredPath}`;

const transport = (process.env.RTSP_TRANSPORT || 'tcp').toLowerCase();

if (!['tcp', 'udp'].includes(transport)) {
  throw new Error('RTSP_TRANSPORT должен иметь значение tcp или udp');
}

/**
 * Кодируем логин и пароль, чтобы специальные символы не ломали RTSP URL.
 */
const encodedUsername = encodeURIComponent(username);
const encodedPassword = encodeURIComponent(password);

/**
 * Полный адрес используется только для подключения.
 * Его нельзя выводить в журналы, поскольку внутри находится пароль.
 */
const rtspUrl =
  `rtsp://${encodedUsername}:${encodedPassword}` +
  `@${host}:${port}${streamPath}`;

/**
 * Безопасный адрес используется для журналов.
 */
const safeRtspUrl =
  `rtsp://${encodedUsername}:***` + `@${host}:${port}${streamPath}`;

module.exports = {
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',

  camera: {
    host,
    port,
    username,
    rtspUrl,
    safeRtspUrl,
    transport,
  },

  frame: {
    width: getPositiveInteger('FRAME_WIDTH'),
    height: getPositiveInteger('FRAME_HEIGHT'),
    fps: getPositiveInteger('FRAME_FPS'),
    channels: 3,
    pixelFormat: 'bgr24',
  },
};
