const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

/**
 * RtspReader запускает FFmpeg и преобразует RTSP-поток камеры
 * в непрерывный поток сырых кадров BGR24.
 *
 * Класс пока не разделяет данные на отдельные кадры.
 * Этим занимается FrameParser.
 */
class RtspReader extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.ffmpegPath Путь к FFmpeg.
   * @param {string} options.rtspUrl Полный RTSP URL с авторизацией.
   * @param {string} options.safeRtspUrl URL без пароля для журналов.
   * @param {'tcp'|'udp'} options.transport RTSP-транспорт.
   * @param {number} options.width Ширина выходного кадра.
   * @param {number} options.height Высота выходного кадра.
   * @param {number} options.fps Ожидаемая частота кадров.
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

    /**
     * Ссылка на дочерний процесс FFmpeg.
     *
     * @type {import('node:child_process').ChildProcessWithoutNullStreams|null}
     */
    this.process = null;

    this.stopping = false;
  }

  /**
   * Запускает подключение к RTSP-камере.
   */
  start() {
    if (this.process) {
      throw new Error('RtspReader уже запущен');
    }

    this.stopping = false;

    const args = [
      '-hide_banner',

      // Предупреждения и ошибки FFmpeg будут поступать через stderr.
      '-loglevel',
      'warning',

      // Для сетей видеонаблюдения TCP обычно стабильнее UDP.
      '-rtsp_transport',
      this.transport,

      // Входной RTSP-поток.
      '-i',
      this.rtspUrl,

      // Аудио на текущем этапе не требуется.
      '-an',

      // Приводим поток к фиксированному разрешению.
      // Это гарантирует постоянный размер каждого кадра.
      '-vf',
      `scale=${this.width}:${this.height}`,

      // Выдаем трехканальный BGR, удобный для OpenCV.
      '-pix_fmt',
      'bgr24',

      // Формат вывода — необработанные кадры без контейнера.
      '-f',
      'rawvideo',

      // Записываем кадры в stdout дочернего процесса.
      'pipe:1',
    ];

    // const args = [
    //   /**
    //    * Не выводим лишнюю служебную информацию.
    //    */
    //   '-hide_banner',
    //   '-loglevel',
    //   'warning',

    //   /**
    //    * RTSP-транспорт.
    //    *
    //    * tcp надёжнее, но при потерях может увеличивать задержку.
    //    * Сначала оставляем транспорт из конфигурации.
    //    */
    //   '-rtsp_transport',
    //   this.transport,

    //   /**
    //    * Не накапливаем пакеты на этапе анализа входного потока.
    //    */
    //   '-fflags',
    //   'nobuffer',

    //   /**
    //    * Просим декодер работать с минимальной задержкой.
    //    */
    //   '-flags',
    //   'low_delay',

    //   /**
    //    * Сильно уменьшаем объём данных,
    //    * используемых FFmpeg для определения формата потока.
    //    *
    //    * Значение по умолчанию значительно больше.
    //    */
    //   '-probesize',
    //   '32768',

    //   /**
    //    * Сокращаем время анализа потока.
    //    *
    //    * Значение указывается в микросекундах:
    //    * 100000 = 100 мс.
    //    */
    //   '-analyzeduration',
    //   '100000',

    //   /**
    //    * Минимальная задержка демультиплексора.
    //    */
    //   '-max_delay',
    //   '0',

    //   /**
    //    * Уменьшаем очередь переупорядочивания RTSP-пакетов.
    //    *
    //    * Для TCP можно использовать 0.
    //    * При UDP это повышает риск артефактов при перестановке пакетов.
    //    */
    //   '-reorder_queue_size',
    //   '0',

    //   /**
    //    * Берём только видеопоток.
    //    * Аудио для аналитики не требуется.
    //    */
    //   '-an',
    //   '-sn',
    //   '-dn',

    //   /**
    //    * RTSP-источник.
    //    *
    //    * Все входные параметры должны располагаться до -i.
    //    */
    //   '-i',
    //   this.rtspUrl,

    //   /**
    //    * Не синхронизируем выход по временным меткам входного потока.
    //    *
    //    * FFmpeg должен отдавать декодированные кадры сразу,
    //    * а не пытаться выдерживать исходный график PTS.
    //    */
    //   '-vsync',
    //   '0',

    //   /**
    //    * Не изменяем частоту кадров через фильтр fps.
    //    *
    //    * Управление частотой аналитики выполняется уже в Node.js.
    //    */
    //   '-pix_fmt',
    //   'bgr24',

    //   /**
    //    * Передаём несжатые кадры через stdout.
    //    */
    //   '-f',
    //   'rawvideo',
    //   'pipe:1',
    // ];

    this.emit('log', `Запуск FFmpeg. Источник: ${this.safeRtspUrl}`);

    this.process = spawn(this.ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /**
     * stdout содержит только бинарные данные кадров.
     */
    this.process.stdout.on('data', (chunk) => {
      this.emit('data', chunk);
    });

    /**
     * stderr содержит диагностические сообщения FFmpeg.
     */
    this.process.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();

      if (message) {
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

      this.emit('close', {
        code,
        signal,
        expected: wasStopping,
      });
    });
  }

  /**
   * Останавливает FFmpeg.
   */
  stop() {
    if (!this.process) {
      return;
    }

    this.stopping = true;

    /**
     * SIGTERM корректно обрабатывается FFmpeg и дает ему возможность
     * завершить работу без аварийного обрыва.
     */
    this.process.kill('SIGTERM');
  }
}

module.exports = RtspReader;
