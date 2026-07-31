'use strict';


const logger = require('./utils/Logger');
/**
 * Добавляем каталог с DLL OpenCV в PATH.
 *
 * Это необходимо сделать до подключения opencv4nodejs,
 * чтобы Windows смогла найти opencv_world4100.dll
 * и другие динамические библиотеки OpenCV.
 **/

/**
 * Отключаем внутренний учёт внешней памяти cv.Mat.
 *
 * На некоторых версиях Node.js, особенно Node 22,
 * механизм external memory tracking нативного модуля
 * может конфликтовать со сборщиком мусора V8 и приводить
 * к аварийному завершению процесса:
 *
 * Check failed: marking_done_
 */

process.env.PATH =
  'C:\\project\\opencv\\install-contrib\\x64\\vc17\\bin;' + process.env.PATH;
process.env.OPENCV4NODEJS_DISABLE_EXTERNAL_MEM_TRACKING = '1';

const fs = require('node:fs');
const path = require('node:path');
const cv = require('@u4/opencv4nodejs');
const config = require('./config/camera.config');
const trackingConfig = require('./config/tracking.config');
const ProfileManager = require('./config/ProfileManager');
const RtspReader = require('./video/RtspReader');
const FrameParser = require('./video/FrameParser');
const FrameProcessor = require('./processing/FrameProcessor');
const saveFrameAsJpeg = require('./utils/saveFrameAsJpeg');
const LatestFrameBuffer = require('./video/LatestFrameBuffer');
const ManualTrackingControl = require('./tracking/ManualTrackingControl');
const TrackingApiServer = require('./api/TrackingApiServer');

/**
 * Буфер хранит только последний полученный кадр.
 *
 * Если аналитика работает медленнее камеры,
 * старые кадры автоматически заменяются новыми.
 */
const latestFrameBuffer = new LatestFrameBuffer();

/** Общее состояние команд ручного сопровождения. */
const manualTrackingControl = new ManualTrackingControl();

/**
 * Единый менеджер конфигурации обработки.
 * Он безопасно объединяет встроенные значения, motion.config.js,
 * активный профиль и будущие runtime-переопределения.
 */

const profileManager = new ProfileManager();
profileManager.initialize();

// view method  profileManager

// logger.info('\n===== ProfileManager =====');
// logger.info(Object.getOwnPropertyNames(Object.getPrototypeOf(profileManager)));
// logger.info('==========================\n');

/**
 * Название окна предпросмотра.
 *
 * Одна и та же строка должна использоваться в:
 *
 * - cv.imshow();
 * - cv.getWindowProperty();
 * - cv.destroyWindow().
 */
const previewWindowName = 'Video Analytics - Motion Detection';
/**
 * Создаём окно заранее, чтобы оно было масштабируемым.
 */
if (typeof cv.namedWindow === 'function') {
  cv.namedWindow(previewWindowName, cv.WINDOW_NORMAL);

  if (typeof cv.resizeWindow === 'function') {
    cv.resizeWindow(previewWindowName, 960, 540);
  }
}

/**
 * Время получения последнего куска данных от FFmpeg.
 */
let lastDataReceivedAt = Date.now();

/**
 * Время получения последнего полностью собранного видеокадра.
 * В отличие от lastDataReceivedAt учитывает не просто байты stdout,
 * а именно готовый кадр размером width × height × 3.
 */
let lastFrameReceivedAt = null;

/**
 * Таймер отложенного перезапуска FFmpeg.
 */
let readerRestartTimer = null;

/**
 * Защита от нескольких одновременных запросов перезапуска.
 */
let readerRestartScheduled = false;

/**
 * Причина последнего перезапуска FFmpeg.
 */
let lastRestartReason = 'нет';

/**
 * Каталог для сохранения тестовых кадров.
 */
const outputDirectory = path.resolve(__dirname, '..', 'output');

/**
 * Путь к первому кадру, на котором цель была
 * успешно захвачена системой сопровождения.
 */
const testFramePath = path.join(outputDirectory, 'first-frame.jpg');

/**
 * Максимальная частота запуска видеоаналитики.
 *
 * CSRT обычно нет необходимости обновлять с частотой 25–30 FPS.
 * Для начала используем 10 кадров в секунду.
 */
const analyticsFps = 10;

/**
 * Минимальный интервал между запусками обработки.
 */
const analyticsIntervalMs = 1000 / analyticsFps;

/**
 * Показывает, что цикл обработки сейчас занят.
 */
let processingFrame = false;

/**
 * Идентификатор таймера цикла обработки.
 */
let processingTimer = null;

/**
 * Счётчик реально обработанных кадров.
 */
let processedFramesSinceLastReport = 0;

/**
 * Количество кадров, отброшенных из-за слишком большого возраста.
 */
let staleFramesDropped = 0;

/**
 * Максимально допустимый возраст кадра.
 *
 * Даже самый свежий кадр из буфера может оказаться старым,
 * например, если OpenCV временно завис или система была перегружена.
 *
 * Такой кадр уже не должен влиять на PTZ.
 */
const maximumFrameAgeMs = 250;

/**
 * Создаём каталог output, если он ещё не существует.
 */
fs.mkdirSync(outputDirectory, {
  recursive: true,
});

/**
 * Создаём модуль получения бинарного видеопотока
 * от FFmpeg.
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
 * Создаём парсер отдельных кадров.
 *
 * FFmpeg передаёт непрерывный поток байтов,
 * а FrameParser собирает из него полные BGR24-кадры.
 */
const parser = new FrameParser({
  width: config.frame.width,
  height: config.frame.height,
  channels: config.frame.channels,
});

/**
 * Создаём основной координатор видеоаналитики.
 *
 * Внутри FrameProcessor выполняются:
 *
 * - детекция движения;
 * - выбор цели;
 * - сопровождение CSRT;
 * - расчёт PTZ-команд;
 * - отрисовка рамок и служебной информации.
 */
const frameProcessor = new FrameProcessor({
  width: config.frame.width,
  height: config.frame.height,

  // Все режимы и параметры захвата находятся в одном файле:
  // src/config/tracking.config.js
  trackingConfig,
  profileManager,
  manualControl: manualTrackingControl,
});
/** HTTP API выбора цели по ID или координатам исходного RTSP-кадра. */
const trackingApiServer = new TrackingApiServer({
  host: trackingConfig.apiHost,
  port: trackingConfig.apiPort,
  control: manualTrackingControl,
  profileManager,
  frameWidth: config.frame.width,
  frameHeight: config.frame.height,
});

/**
 * Количество кадров, полученных за последнюю секунду.
 */
let framesSinceLastReport = 0;

/**
 * Общее количество полученных кадров.
 */
let totalFrames = 0;

/**
 * Флаг сохранения первого кадра с захваченной целью.
 */
let firstFrameSaved = false;

/**
 * Защищает от одновременного запуска нескольких
 * операций сохранения одного и того же кадра.
 */
let savingFirstFrame = false;

/**
 * Показывает, что приложение уже завершает работу.
 *
 * Защищает shutdown() от повторного выполнения.
 */
let shuttingDown = false;

/**
 * Управляет выводом окна OpenCV.
 *
 * После закрытия окна через крестик этот флаг
 * устанавливается в false, чтобы следующий кадр
 * не создал окно заново.
 */
let previewWindowEnabled = true;

/**
 * Показывает, что хотя бы один кадр уже был
 * выведен в окно OpenCV.
 *
 * Это нужно, чтобы не проверять состояние окна
 * до его создания.
 */
let previewWindowCreated = false;

/**
 * Защита от одновременной обработки нескольких кадров.
 *
 * Обработчик события frame является асинхронным.
 * Если сохранение JPEG или другая операция задержится,
 * следующий кадр может прийти раньше завершения предыдущего.
 *
 * Для демонстрационного режима безопаснее пропустить
 * один кадр, чем одновременно обрабатывать несколько Mat.
 */
/**
 * Предыдущее суммарное количество кадров,
 * вытесненных из LatestFrameBuffer.
 *
 * Используется для расчёта числа пропущенных кадров
 * за последнюю секунду, а не за всё время работы.
 */
let previousDroppedFrames = 0;
let previousParserDroppedFrames = 0;
let previousStaleFramesDropped = 0;
let previousFfmpegErrors = 0;

/**
 * Количество последних сообщений FFmpeg, сохраняемых для диагностики.
 *
 * FFmpeg пишет предупреждения и ошибки в stderr. При неожиданном завершении
 * последние строки обычно содержат точную причину: разрыв RTSP, тайм-аут,
 * повреждённый пакет, ошибка декодирования и т. п.
 */
const ffmpegLogHistoryLimit = 30;

/** Последние диагностические сообщения FFmpeg. */
const ffmpegLogHistory = [];

/**
 * Добавляет сообщение FFmpeg в кольцевой диагностический буфер.
 *
 * @param {string} message Сообщение из stderr FFmpeg.
 */
function rememberFfmpegLog(message) {
  const normalizedMessage = String(message).trim();

  if (!normalizedMessage) {
    return;
  }

  ffmpegLogHistory.push(normalizedMessage);

  if (ffmpegLogHistory.length > ffmpegLogHistoryLimit) {
    ffmpegLogHistory.shift();
  }
}

/** Выводит последние сообщения FFmpeg после аварийного завершения. */
function printRecentFfmpegLogs() {
  logger.error('========== Последние сообщения FFmpeg ==========');

  if (ffmpegLogHistory.length === 0) {
    logger.error('[FFmpeg] Диагностические сообщения отсутствуют.');
  } else {
    for (const message of ffmpegLogHistory) {
      logger.error(`[FFmpeg] ${message}`);
    }
  }

  logger.error('================================================');
}
/**
 * Передаём все бинарные данные FFmpeg
 * в парсер кадров.
 */
reader.on('data', (chunk) => {
  if (shuttingDown) {
    return;
  }
  lastDataReceivedAt = Date.now();
  parser.push(chunk);
});

/**
 * Проверяет, открыто ли окно предпросмотра.
 *
 * Некоторые сборки opencv4nodejs не экспортируют
 * getWindowProperty() или WND_PROP_VISIBLE.
 * В таком случае функция возвращает true,
 * и окно продолжает работать через обычный waitKey().
 *
 * @returns {boolean}
 */
function isPreviewWindowVisible() {
  if (!previewWindowCreated) {
    return false;
  }

  if (
    typeof cv.getWindowProperty !== 'function' ||
    typeof cv.WND_PROP_VISIBLE === 'undefined'
  ) {
    return true;
  }

  try {
    const visibility = cv.getWindowProperty(
      previewWindowName,
      cv.WND_PROP_VISIBLE,
    );

    /**
     * OpenCV обычно возвращает:
     *
     * 1 — окно видно;
     * 0 — окно закрыто;
     * отрицательное значение — окно не существует.
     */
    return visibility >= 1;
  } catch (error) {
    /**
     * После закрытия окна некоторые версии OpenCV
     * выбрасывают исключение вместо возврата нуля.
     */
    return false;
  }
}

/**
 * Закрывает только окно предпросмотра.
 *
 * RTSP, аналитика и PTZ-логи после этого могут продолжать
 * работать, если приложение не завершает работу полностью.
 *
 * @param {string} reason Причина закрытия окна.
 */
function closePreviewWindow(reason) {
  if (!previewWindowEnabled && !previewWindowCreated) {
    return;
  }

  previewWindowEnabled = false;

  try {
    if (previewWindowCreated && typeof cv.destroyWindow === 'function') {
      cv.destroyWindow(previewWindowName);
    }
  } catch (error) {
    /**
     * Окно уже могло быть закрыто пользователем,
     * поэтому такая ошибка не является критической.
     */
  }

  try {
    /**
     * Даём HighGUI возможность обработать
     * событие уничтожения окна.
     */
    if (typeof cv.waitKey === 'function') {
      cv.waitKey(1);
    }
  } catch (error) {
    /**
     * Игнорируем ошибки при финальном обновлении окна.
     */
  }

  previewWindowCreated = false;

  logger.info(`[Видео] Окно предпросмотра закрыто: ${reason}.`);
}

/**
 * Выводит обработанный кадр в окно OpenCV.
 *
 * @param {object} frame OpenCV Mat.
 * @returns {'continue'|'shutdown'}
 */
function showPreviewFrame(frame) {
  if (shuttingDown || !previewWindowEnabled) {
    return 'continue';
  }

  try {
    /**
     * Если окно уже существовало, сначала проверяем,
     * не закрыл ли его пользователь крестиком.
     *
     * Проверка выполняется до imshow(), иначе imshow()
     * может заново создать только что закрытое окно.
     */
    if (previewWindowCreated && !isPreviewWindowVisible()) {
      closePreviewWindow('пользователь нажал крестик');

      return 'continue';
    }

    // test frame change

    // frame.drawCircle(
    //   new cv.Point2(
    //     Math.floor(Math.random() * 500),
    //     Math.floor(Math.random() * 300),
    //   ),
    //   4,
    //   new cv.Vec3(0, 255, 255),
    //   -1,
    // );

    // cv.imshow(previewWindowName, frame);

    // previewWindowCreated = true;

    // const pressedKey = cv.waitKey(1);

    cv.imshow(previewWindowName, frame);

    previewWindowCreated = true;

    /**
     * waitKey() обязателен для обработки событий HighGUI:
     *
     * - обновления изображения;
     * - клавиатуры;
     * - закрытия окна.
     */
    const pressedKey = cv.waitKey(1);

    /**
     * Код клавиши ESC равен 27.
     *
     * В текущей версии ESC завершает всё приложение,
     * включая RTSP, FFmpeg и видеоаналитику.
     */
    if (pressedKey === 27) {
      logger.info('[Видео] Нажата клавиша ESC.');

      return 'shutdown';
    }

    /**
     * После waitKey() повторно проверяем окно,
     * поскольку событие закрытия могло быть обработано
     * именно во время waitKey().
     */
    if (!isPreviewWindowVisible()) {
      closePreviewWindow('пользователь нажал крестик');
    }
  } catch (error) {
    /**
     * При закрытии окна через крестик некоторые сборки
     * OpenCV выбрасывают исключение из imshow(),
     * waitKey() или getWindowProperty().
     *
     * Отключаем предпросмотр, чтобы окно не появилось снова.
     */
    previewWindowEnabled = false;
    previewWindowCreated = false;

    logger.warn('[Видео] Предпросмотр остановлен:', error.message);
  }

  return 'continue';
}

/**
 * Обрабатываем каждый полностью собранный кадр.
 */
// parser.on('frame', async (frameBuffer, metadata) => {
//   if (shuttingDown) {
//     return;
//   }

//   /**
//    * Если предыдущий кадр ещё обрабатывается,
//    * пропускаем текущий.
//    *
//    * Это не даёт накапливаться очереди кадров
//    * и увеличиваться задержке видеопотока.
//    */
//   if (processingFrame) {
//     return;
//   }

//   processingFrame = true;

//   totalFrames += 1;
//   framesSinceLastReport += 1;

//   try {
//     let processingResult;

//     try {
//       processingResult = frameProcessor.process(frameBuffer, metadata);
//     } catch (error) {
//       logger.error(
//         `[OpenCV] Ошибка обработки кадра ` + `${metadata.number}:`,
//         error.message,
//       );

//       return;
//     }

//     /**
//      * Выводим обработанный кадр.
//      */
//     const previewResult = showPreviewFrame(processingResult.frame);

//     /**
//      * ESC завершает работу всего приложения.
//      */
//     if (previewResult === 'shutdown') {
//       shutdown('ESC');
//       return;
//     }

//     const processedFrame = processingResult.frameBuffer;

//     /**
//      * Сохраняем первый кадр после успешного
//      * захвата цели.
//      */
//     if (
//       processingResult.tracking.state === 'TRACKING' &&
//       !firstFrameSaved &&
//       !savingFirstFrame
//     ) {
//       savingFirstFrame = true;

//       try {
//         await saveFrameAsJpeg({
//           ffmpegPath: config.ffmpegPath,
//           frameBuffer: processedFrame,
//           width: metadata.width,
//           height: metadata.height,
//           outputPath: testFramePath,
//         });

//         firstFrameSaved = true;

//         logger.info(
//           '[Видео] Кадр с захваченной целью ' + `сохранён: ${testFramePath}`,
//         );
//       } catch (error) {
//         logger.error('[Видео] Ошибка сохранения кадра:', error.message);
//       } finally {
//         savingFirstFrame = false;
//       }
//     }
//   } finally {
//     processingFrame = false;
//   }
// });

/**
 * FrameParser по-прежнему собирает все кадры из бинарного потока,
 * однако на видеоаналитику передаётся только самый свежий кадр.
 */
parser.on('frame', (frameBuffer, metadata) => {
  if (shuttingDown) {
    return;
  }

  totalFrames += 1;
  framesSinceLastReport += 1;
  lastFrameReceivedAt = Date.now();
  /**
   * Новый кадр заменяет предыдущий ожидающий кадр.
   *
   * Здесь нет await и тяжёлой обработки.
   * Обработчик должен как можно быстрее освободить EventEmitter.
   */
  latestFrameBuffer.push(frameBuffer, metadata);
});
/**
 * Обрабатывает один самый свежий кадр из буфера.
 *
 * Функция никогда не создаёт очередь задач:
 *
 * - если обработка уже выполняется, новый запуск прекращается;
 * - после завершения следующий тик возьмёт самый свежий кадр;
 * - все промежуточные кадры автоматически пропускаются.
 */
async function processLatestFrame() {
  if (shuttingDown || processingFrame) {
    return;
  }

  /**
   * Забираем самый свежий кадр.
   *
   * take() сразу очищает буфер, поэтому во время обработки
   * туда уже может поступить следующий свежий кадр.
   */
  const bufferedFrame = latestFrameBuffer.take();

  if (!bufferedFrame) {
    return;
  }

  /**
   * Вычисляем возраст кадра на момент начала обработки.
   */
  const frameAgeMs = performance.now() - bufferedFrame.receivedAt;

  /**
   * Не обрабатываем слишком старые кадры.
   *
   * Для PTZ старый кадр опасен: камера будет поворачиваться
   * к позиции, в которой объекта уже может не быть.
   */
  if (frameAgeMs > maximumFrameAgeMs) {
    staleFramesDropped += 1;
    return;
  }

  processingFrame = true;

  try {
    let processingResult;

    try {
      processingResult = frameProcessor.process(
        bufferedFrame.frameBuffer,
        bufferedFrame.metadata,
      );
    } catch (error) {
      logger.error(
        '[OpenCV] Ошибка обработки кадра ' +
          `${bufferedFrame.metadata.number ?? 'неизвестно'}:`,
        error.message,
      );

      return;
    }

    processedFramesSinceLastReport += 1;

    /**
     * Отображаем обработанный видеокадр.
     */
    const previewResult = showPreviewFrame(processingResult.frame);

    if (previewResult === 'shutdown') {
      shutdown('ESC');
      return;
    }

    /**
     * Сохраняем первый кадр после успешного захвата цели.
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

          frameBuffer: processingResult.frameBuffer,

          width: bufferedFrame.metadata.width,

          height: bufferedFrame.metadata.height,

          outputPath: testFramePath,
        });

        firstFrameSaved = true;

        logger.info(
          '[Видео] Кадр с захваченной целью ' + `сохранён: ${testFramePath}`,
        );
      } catch (error) {
        logger.error('[Видео] Ошибка сохранения кадра:', error.message);
      } finally {
        savingFirstFrame = false;
      }
    }
  } finally {
    processingFrame = false;
  }
}

/**
 * Запускаем видеоаналитику с ограниченной частотой.
 *
 * Таймер не обрабатывает все накопленные кадры.
 * Каждый тик забирает только самый новый доступный кадр.
 */
processingTimer = setInterval(() => {
  processLatestFrame().catch((error) => {
    logger.error('[Видео] Ошибка цикла обработки:', error);
  });
}, analyticsIntervalMs);

/**
 * Планирует безопасный перезапуск FFmpeg.
 *
 * Повторные запросы во время ожидания игнорируются, поэтому watchdog
 * и событие close не могут создать несколько процессов одновременно.
 *
 * @param {string} reason Причина перезапуска.
 */
function scheduleReaderRestart(reason) {
  if (shuttingDown || readerRestartScheduled) {
    return;
  }

  readerRestartScheduled = true;
  lastRestartReason = reason;

  logger.warn(`[RTSP] Перезапуск FFmpeg через 2 сек. Причина: ${reason}.`);

  try {
    reader.stop();
  } catch (error) {
    logger.warn('[RTSP] Ошибка остановки перед перезапуском:', error.message);
  }

  readerRestartTimer = setTimeout(() => {
    readerRestartTimer = null;

    if (shuttingDown) {
      readerRestartScheduled = false;
      return;
    }

    try {
      // Удаляем незавершённый хвост старого rawvideo-потока.
      parser.reset();
      previousParserDroppedFrames = 0;
      latestFrameBuffer.clear();
      lastDataReceivedAt = Date.now();
      lastFrameReceivedAt = null;

      reader.start();
      readerRestartScheduled = false;
    } catch (error) {
      readerRestartScheduled = false;
      logger.error('[RTSP] Не удалось перезапустить FFmpeg:', error.message);
      scheduleReaderRestart('ошибка повторного запуска');
    }
  }, 2000);
}

/**
 * Обычные диагностические сообщения RTSP-модуля.
 */
reader.on('log', (message) => {
  logger.info(`[RTSP] ${message}`);
});

/**
 * Диагностические сообщения непосредственно от FFmpeg.
 */
reader.on('ffmpegLog', (message) => {
  rememberFfmpegLog(message);
  logger.warn(`[FFmpeg] ${message}`);
});

/**
 * Ошибка запуска или работы RTSP/FFmpeg.
 */
reader.on('error', (error) => {
  logger.error('[RTSP] Ошибка запуска FFmpeg:', error.message);
});

/**
 * Обрабатываем завершение дочернего процесса FFmpeg.
 */
reader.on('close', ({ code, signal, expected }) => {
  if (shuttingDown) {
    return;
  }

  if (expected) {
    logger.info('[RTSP] FFmpeg остановлен');
    return;
  }

  logger.error(
    '[RTSP] FFmpeg неожиданно завершился. ' +
      `Код: ${code ?? 'не указан'}, ` +
      `сигнал: ${signal || 'нет'}`,
  );

  printRecentFfmpegLogs();

  scheduleReaderRestart('неожиданное завершение FFmpeg');
});

/**
 * Раз в секунду выводим реальное количество
 * обработанных кадров.
 */
const fpsTimer = setInterval(() => {
  const now = Date.now();
  const bufferStats = latestFrameBuffer.getStats();
  const parserStats = parser.getStats();
  const readerStats = reader.getStats();
  const performanceStats = frameProcessor.getPerformanceStats();

  const bufferDroppedDuringSecond =
    bufferStats.droppedFrames - previousDroppedFrames;
  const parserDroppedDuringSecond =
    parserStats.droppedFrames - previousParserDroppedFrames;
  const staleDroppedDuringSecond =
    staleFramesDropped - previousStaleFramesDropped;
  const ffmpegErrorsDuringSecond =
    readerStats.ffmpegErrors - previousFfmpegErrors;

  previousDroppedFrames = bufferStats.droppedFrames;
  previousParserDroppedFrames = parserStats.droppedFrames;
  previousStaleFramesDropped = staleFramesDropped;
  previousFfmpegErrors = readerStats.ffmpegErrors;

  const totalDroppedDuringSecond =
    bufferDroppedDuringSecond +
    parserDroppedDuringSecond +
    staleDroppedDuringSecond;

  const lastFrameAgeMs =
    lastFrameReceivedAt === null ? null : now - lastFrameReceivedAt;

  const lastFrameText =
    lastFrameAgeMs === null ? 'ещё не получен' : `${lastFrameAgeMs} мс назад`;

  const restartCount = Math.max(0, readerStats.starts - 1);

  logger.info(
    '[Статистика] ' +
      `вход=${framesSinceLastReport} FPS; ` +
      `аналитика=${processedFramesSinceLastReport} FPS; ` +
      `пропущено=${totalDroppedDuringSecond}/с ` +
      `(parser=${parserDroppedDuringSecond}, ` +
      `buffer=${bufferDroppedDuringSecond}, ` +
      `stale=${staleDroppedDuringSecond}); ` +
      `ошибки FFmpeg=${ffmpegErrorsDuringSecond}/с; ` +
      `последний кадр=${lastFrameText}; ` +
      `перезапуски=${restartCount}`,
  );

  logger.info(
    '[Статистика всего] ' +
      `кадров=${totalFrames}; ` +
      `обработано=${bufferStats.consumedFrames}; ` +
      `parser drop=${parserStats.droppedFrames}; ` +
      `buffer drop=${bufferStats.droppedFrames}; ` +
      `stale drop=${staleFramesDropped}; ` +
      `FFmpeg errors=${readerStats.ffmpegErrors}; ` +
      `получено=${(readerStats.receivedBytes / 1024 / 1024).toFixed(1)} МБ; ` +
      `состояние=${readerStats.running ? 'работает' : 'остановлен'}; ` +
      `последний restart=${lastRestartReason}`,
  );

  /** Форматирует один этап профилирования. */
  const formatMetric = (name) => {
    const metric = performanceStats[name];

    if (!metric || metric.calls === 0) {
      return 'нет вызовов';
    }

    return (
      `${metric.averageMs.toFixed(1)} мс среднее, ` +
      `${metric.maxMs.toFixed(1)} мс максимум, ` +
      `${metric.calls} вызовов`
    );
  };

  logger.info(
    '[Профайлер] ' +
      `кадр=${formatMetric('total')}; ` +
      `MotionDetector=${formatMetric('motionDetector')}; ` +
      `Renderer=${formatMetric('renderer')}`,
  );

  framesSinceLastReport = 0;
  processedFramesSinceLastReport = 0;
}, 1000);

/**
 * Контроль поступления видеопотока.
 *
 * Если более 5 секунд не приходит ни одного байта
 * от FFmpeg, считаем, что поток потерян.
 */
const streamWatchdog = setInterval(() => {
  if (shuttingDown) {
    return;
  }

  const elapsed = Date.now() - lastDataReceivedAt;

  if (elapsed > 5000) {
    logger.error(
      `[RTSP] Ошибка: видеопоток отсутствует уже ${Math.round(elapsed / 1000)} сек.`,
    );

    scheduleReaderRestart(`нет данных ${Math.round(elapsed / 1000)} сек.`);
  }
}, 1000);

/**
 * Корректно завершает работу приложения.
 *
 * Последовательность:
 *
 * 1. запрещаем обработку новых кадров;
 * 2. останавливаем FPS-таймер;
 * 3. закрываем окно OpenCV;
 * 4. сбрасываем видеоаналитику;
 * 5. останавливаем FFmpeg;
 * 6. принудительно завершаем процесс через небольшой тайм-аут.
 *
 * @param {string} signal Причина завершения.
 */
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  trackingApiServer.stop();
  previewWindowEnabled = false;

  logger.info(`\nПолучен сигнал ${signal}. ` + 'Завершение работы...');

  /**
   * Останавливаем периодический вывод FPS.
   */
  clearInterval(fpsTimer);

  if (readerRestartTimer !== null) {
    clearTimeout(readerRestartTimer);
    readerRestartTimer = null;
  }
  readerRestartScheduled = false;

  /**
   * Сначала закрываем конкретное окно предпросмотра.
   */
  try {
    if (previewWindowCreated && typeof cv.destroyWindow === 'function') {
      cv.destroyWindow(previewWindowName);
    }
  } catch (error) {
    logger.warn('[Видео] Ошибка закрытия окна:', error.message);
  }

  /**
   * Затем закрываем все окна OpenCV,
   * если метод доступен в текущей сборке.
   */
  try {
    if (typeof cv.destroyAllWindows === 'function') {
      cv.destroyAllWindows();
    }
  } catch (error) {
    logger.warn('[Видео] Ошибка destroyAllWindows():', error.message);
  }

  /**
   * Обрабатываем оставшиеся события HighGUI.
   */
  try {
    if (typeof cv.waitKey === 'function') {
      cv.waitKey(1);
    }
  } catch (error) {
    /**
     * При завершении приложения ошибка HighGUI
     * не является критической.
     */
  }

  previewWindowCreated = false;

  /**
   * Сбрасываем внутреннее состояние аналитики.
   */
  try {
    if (frameProcessor && typeof frameProcessor.reset === 'function') {
      frameProcessor.reset();
    }
  } catch (error) {
    logger.warn('[OpenCV] Ошибка сброса аналитики:', error.message);
  }

  /**
   * Останавливаем дочерний процесс FFmpeg.
   */
  try {
    reader.stop();
  } catch (error) {
    logger.warn('[RTSP] Ошибка остановки FFmpeg:', error.message);
  }

  /**
   * Останавливаем цикл выдачи кадров на видеоаналитику.
   */
  if (processingTimer !== null) {
    clearInterval(processingTimer);
    processingTimer = null;
  }

  /**
   * Удаляем ожидающий кадр.
   */
  latestFrameBuffer.clear();

  /** Останавливаем таймер контроля потока  */
  clearInterval(streamWatchdog);

  /**
   * Даём FFmpeg время на корректное завершение.
   *
   * Если какой-либо активный дескриптор продолжит
   * удерживать Node.js, процесс будет завершён принудительно.
   */
  const forceExitTimer = setTimeout(() => {
    logger.info('[Система] Работа завершена.');
    process.exit(0);
  }, 2000);

  /**
   * Таймер не должен самостоятельно удерживать
   * event loop Node.js.
   */
  forceExitTimer.unref();
}

/**
 * Ctrl+C в консоли.
 */
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Системный запрос на завершение.
 */
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Перехватываем необработанные синхронные ошибки,
 * чтобы успеть остановить FFmpeg и закрыть окно.
 */
process.on('uncaughtException', (error) => {
  logger.error('Необработанная ошибка:', error);

  shutdown('uncaughtException');
});

/**
 * Перехватываем необработанные отклонения Promise.
 */
process.on('unhandledRejection', (error) => {
  logger.error('Необработанное отклонение Promise:', error);

  shutdown('unhandledRejection');
});

/**
 * Начальная диагностическая информация.
 */
logger.info('Запуск захвата видеопотока...');

logger.info(
  `Выходной формат: ` +
    `${config.frame.width}x` +
    `${config.frame.height}, ` +
    `${config.frame.pixelFormat}`,
);

logger.info(`Ожидаемый FPS камеры: ` + `${config.frame.fps}`);

logger.info(`Размер одного кадра: ` + `${parser.frameSize} байт`);

logger.info(
  '[Видео] Управление: ' +
    'ESC — завершение приложения, ' +
    'крестик — закрытие окна предпросмотра.',
);

/**
 * Запускаем FFmpeg и получение RTSP-потока.
 */
trackingApiServer.start();
reader.start();
