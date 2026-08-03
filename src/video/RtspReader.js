'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

/**
 * Запускает FFmpeg для чтения RTSP-потока и передаёт в Node.js
 * непрерывный поток кадров BGR24 через stdout.
 *
 * Класс также собирает транспортную статистику:
 *
 * - число запусков FFmpeg;
 * - объём и количество полученных блоков данных;
 * - предупреждения и ошибки FFmpeg;
 * - число неожиданных завершений процесса.
 */
class RtspReader extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.ffmpegPath Путь к FFmpeg.
   * @param {string} options.rtspUrl Полный RTSP URL, с авторизацией или без неё.
   * @param {string} options.safeRtspUrl RTSP URL без открытого пароля.
   * @param {'tcp'|'udp'} options.transport RTSP-транспорт.
   * @param {number} options.width Ширина выходного кадра.
   * @param {number} options.height Высота выходного кадра.
   * @param {number} options.fps Ожидаемая частота кадров камеры.
   * @param {number} options.outputFps Частота кадров rawvideo для Node.js.
   */
  constructor(options) {
    super();

    this.ffmpegPath = options.ffmpegPath;
    this.rtspUrl = options.rtspUrl;
    this.safeRtspUrl = options.safeRtspUrl;
    this.transport = options.transport;
    this.width = options.width;
    this.height = options.height;
    this.fps = options.fps;
    this.outputFps = options.outputFps ?? options.fps;

    /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
    this.process = null;
    this.stopping = false;

    this.stats = {
      starts: 0,
      unexpectedCloses: 0,
      receivedChunks: 0,
      receivedBytes: 0,
      ffmpegWarnings: 0,
      ffmpegErrors: 0,
      lastDataAt: null,
      startedAt: null,
    };
  }

  /**
   * Запускает FFmpeg.
   */
  start() {
    if (this.process) {
      throw new Error('RtspReader уже запущен');
    }

    this.stopping = false;
    this.stats.starts += 1;
    this.stats.startedAt = Date.now();

    /**
     * Параметры рассчитаны именно на RTSP-камеру.
     * TCP выбран как наиболее устойчивый транспорт для видеонаблюдения.
     */
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',

      '-rtsp_transport',
      this.transport,

      /**
       * Используем время прихода RTSP-пакетов как резервные временные метки.
       * Это особенно важно для камер, которые передают некорректные или
       * постоянно повторяющиеся PTS/DTS.
       */
      '-use_wallclock_as_timestamps',
      '1',

      /**
       * Генерируем отсутствующие PTS и отбрасываем повреждённые пакеты.
       * В отличие от `nobuffer`, этот режим не ломает очередь декодера,
       * необходимую некоторым H.264/H.265-потокам.
       */
      '-fflags',
      '+genpts+discardcorrupt',

      // Даём FFmpeg достаточно данных для корректного определения потока.
      '-probesize',
      '1000000',
      '-analyzeduration',
      '1000000',

      '-i',
      this.rtspUrl,

      // Аналитике нужен только первый видеопоток.
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',

      /**
       * Ограничиваем частоту rawvideo до передачи в Node.js.
       *
       * Камера может выдавать 25–30 FPS, но аналитика обрабатывает
       * существенно меньше. Без этого ограничения через stdout проходит
       * до 180 МБ/с для Full HD BGR24, что создаёт лишнюю нагрузку на
       * копирование Buffer и сборку кадров.
       */
      '-vf',
      `fps=${this.outputFps},scale=${this.width}:${this.height}`,

      /**
       * Не разрешаем FFmpeg искусственно дублировать кадры для выравнивания
       * временной шкалы. Каждый rawvideo-кадр должен соответствовать реально
       * декодированному кадру камеры.
       *
       * `-fps_mode passthrough` — современная замена `-vsync 0`.
       */
      '-fps_mode',
      'passthrough',

      '-pix_fmt',
      'bgr24',
      '-f',
      'rawvideo',
      'pipe:1',
    ];

    this.emit(
      'log',
      `Запуск FFmpeg №${this.stats.starts}. Источник: ${this.safeRtspUrl}`,
    );

    this.process = spawn(this.ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout.on('data', (chunk) => {
      this.stats.receivedChunks += 1;
      this.stats.receivedBytes += chunk.length;
      this.stats.lastDataAt = Date.now();

      this.emit('data', chunk);
    });

    this.process.stderr.on('data', (chunk) => {
      const messages = chunk
        .toString('utf8')
        .split(/\r?\n/)
        .map((message) => message.trim())
        .filter(Boolean);

      for (const message of messages) {
        const isError = /error|invalid|corrupt|failed|missing|timeout/i.test(
          message,
        );

        if (isError) {
          this.stats.ffmpegErrors += 1;
        } else {
          this.stats.ffmpegWarnings += 1;
        }

        this.emit('ffmpegLog', message);
      }
    });

    this.process.on('error', (error) => {
      this.emit('error', error);
    });

    this.process.on('close', (code, signal) => {
      const wasStopping = this.stopping;

      this.process = null;
      this.stopping = false;

      if (!wasStopping) {
        this.stats.unexpectedCloses += 1;
      }

      this.emit('close', {
        code,
        signal,
        expected: wasStopping,
      });
    });
  }

  /**
   * Останавливает текущий процесс FFmpeg.
   */
  stop() {
    if (!this.process) {
      return;
    }

    this.stopping = true;
    this.process.kill('SIGTERM');
  }

  /**
   * Возвращает копию накопленной транспортной статистики.
   */
  getStats() {
    return {
      ...this.stats,
      running: this.process !== null,
    };
  }
}

module.exports = RtspReader;
