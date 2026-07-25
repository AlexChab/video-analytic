// Добавляем каталог с DLL OpenCV в PATH.
// Это необходимо, чтобы Windows могла найти opencv_world4100.dll.
process.env.PATH =
  'C:\\project\\opencv\\install-contrib\\x64\\vc17\\bin;' + process.env.PATH;

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config/camera.config');
const RtspReader = require('./video/RtspReader');
const FrameParser = require('./video/FrameParser');

const saveFrameAsJpeg = require('./utils/saveFrameAsJpeg');
const FrameProcessor = require('./processing/FrameProcessor');
const cv = require('@u4/opencv4nodejs');

/**
 * Каталог для тестовых кадров.
 */
const outputDirectory = path.resolve(__dirname, '..', 'output');
const testFramePath = path.join(outputDirectory, 'first-frame.jpg');

fs.mkdirSync(outputDirectory, {
  recursive: true,
});

/**
 * Создаем модуль получения бинарного потока от FFmpeg.
 */
const reader = new RtspReader({
  ffmpegPath: config.ffmpegPath,
  rtspUrl: config.camera.rtspUrl,
  safeRtspUrl: config.camera.safeRtspUrl,
  transport: config.camera.transport,
  width: config.frame.width,
  height: config.frame.height,
  fps: config.frame.fps,
});

/**
 * Создаем парсер отдельных кадров.
 */
const parser = new FrameParser({
  width: config.frame.width,
  height: config.frame.height,
  channels: config.frame.channels,
});

const frameProcessor = new FrameProcessor({
  width: config.frame.width,
  height: config.frame.height,
});

let framesSinceLastReport = 0;
let totalFrames = 0;
let firstFrameSaved = false;
let savingFirstFrame = false;
let shuttingDown = false;
let previewWindowEnabled = true;

/**
 * Передаем все бинарные данные FFmpeg в FrameParser.
 */
reader.on('data', (chunk) => {
  parser.push(chunk);
});

/**
 * Обрабатываем каждый полностью собранный кадр.
 */

parser.on('frame', async (frameBuffer, metadata) => {
  totalFrames += 1;
  framesSinceLastReport += 1;

  let processingResult;

  try {
    processingResult = frameProcessor.process(frameBuffer, metadata);
  } catch (error) {
    console.error(
      `[OpenCV] Ошибка обработки кадра ` + `${metadata.number}:`,
      error.message,
    );

    return;
  }

  /**
   * Отображаем обработанный видеопоток.
   */
  try {
    cv.imshow('Video Analytics - CSRT / PTZ', processingResult.frame);

    const pressedKey = cv.waitKey(1);

    if (pressedKey === 27) {
      console.log('[Видео] Нажата ESC.');

      shutdown('escape');
      return;
    }
  } catch (error) {
    console.error('[Видео] Ошибка вывода:', error.message);
  }

  const processedFrame = processingResult.frameBuffer;

  /**
   * Сохраняем первый кадр после захвата цели.
   */
  if (
    processingResult.tracking.state === 'TRACKING' &&
    !firstFrameSaved &&
    !savingFirstFrame
  ) {
    savingFirstFrame = true;

    try {
      await saveFrameAsJpeg({
        ffmpegPath: config.ffmpegPath,
        frameBuffer: processedFrame,
        width: metadata.width,
        height: metadata.height,
        outputPath: testFramePath,
      });

      firstFrameSaved = true;

      console.log(
        '[Видео] Кадр с захваченной целью ' + `сохранён: ${testFramePath}`,
      );
    } catch (error) {
      console.error('[Видео] Ошибка сохранения кадра:', error.message);
    } finally {
      savingFirstFrame = false;
    }
  }
});

reader.on('log', (message) => {
  console.log(`[RTSP] ${message}`);
});

reader.on('ffmpegLog', (message) => {
  console.warn(`[FFmpeg] ${message}`);
});

reader.on('error', (error) => {
  console.error('[RTSP] Ошибка запуска FFmpeg:', error.message);
});

reader.on('close', ({ code, signal, expected }) => {
  if (expected) {
    console.log('[RTSP] FFmpeg остановлен');
    return;
  }

  console.error(
    `[RTSP] FFmpeg неожиданно завершился. ` +
      `Код: ${code}, сигнал: ${signal || 'нет'}`,
  );
});

/**
 * Раз в секунду показываем реальное количество полученных кадров.
 */
const fpsTimer = setInterval(() => {
  console.log(
    `[Видео] FPS: ${framesSinceLastReport}, ` +
      `всего кадров: ${totalFrames}, ` +
      `размер кадра: ${parser.frameSize} байт`,
  );

  framesSinceLastReport = 0;
}, 1000);

/**
 * Корректно завершаем дочерний FFmpeg при остановке приложения.
 */
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\nПолучен сигнал ${signal}. Завершение работы...`);

  clearInterval(fpsTimer);
  reader.stop();

  /**
   * Даем FFmpeg короткое время на корректное завершение.
   */
  const forceExitTimer = setTimeout(() => {
    process.exit(0);
  }, 2000);

  if (typeof cv.destroyAllWindows === 'function') {
    cv.destroyAllWindows();
  }

  forceExitTimer.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  console.error('Необработанная ошибка:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (error) => {
  console.error('Необработанное отклонение Promise:', error);
  shutdown('unhandledRejection');
});

console.log('Запуск захвата видеопотока...');
console.log(
  `Выходной формат: ${config.frame.width}x${config.frame.height}, ` +
    `${config.frame.pixelFormat}`,
);
console.log(`Ожидаемый FPS камеры: ${config.frame.fps}`);
console.log(`Размер одного кадра: ${parser.frameSize} байт`);

reader.start();
