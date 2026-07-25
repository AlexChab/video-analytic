'use strict';
const { performance } = require('node:perf_hooks');

const cv = require('@u4/opencv4nodejs');

const MotionDetector = require('../detection/MotionDetector');
const TargetSelector = require('../tracking/TargetSelector');
const ObjectTracker = require('../analytics/ObjectTracker');
const PtzController = require('../tracking/PtzController');
const FrameRenderer = require('../rendering/FrameRenderer');

/**
 * Координатор обработки одного видеокадра.
 *
 * Полная цепочка в режиме поиска:
 *
 * BGR-кадр
 *   → обнаружение движения
 *   → выбор цели
 *   → захват цели CSRT
 *   → расчёт PTZ-команды
 *   → отрисовка результата
 *
 * Полная цепочка в режиме сопровождения:
 *
 * BGR-кадр
 *   → обновление CSRT
 *   → расчёт PTZ-команды
 *   → отрисовка результата
 *
 * Важно:
 * пока CSRT активно сопровождает цель, MotionDetector не запускается.
 * Это уменьшает нагрузку на процессор и предотвращает резкое замедление
 * при появлении в кадре больших движущихся объектов.
 */
class FrameProcessor {
  /**
   * @param {object} options
   * @param {number} options.width Ширина кадра.
   * @param {number} options.height Высота кадра.
   */
  constructor({ width, height }) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error('Ширина кадра должна быть положительным целым числом');
    }

    if (!Number.isInteger(height) || height <= 0) {
      throw new Error('Высота кадра должна быть положительным целым числом');
    }

    this.width = width;
    this.height = height;
    this.channels = 3;
    this.previousState = 'SEARCHING';
    this.performanceStats = {
      total: this.#createPerformanceMetric(),
      motionDetector: this.#createPerformanceMetric(),
      targetSelector: this.#createPerformanceMetric(),
      trackerStart: this.#createPerformanceMetric(),
      trackerUpdate: this.#createPerformanceMetric(),
      ptzCalculate: this.#createPerformanceMetric(),
      ptzExecute: this.#createPerformanceMetric(),
      renderer: this.#createPerformanceMetric(),
      frameBufferCopy: this.#createPerformanceMetric(),
    };

    /**
     * Ожидаемый размер одного BGR24-кадра.
     */
    this.frameSize = this.width * this.height * this.channels;

    /**
     * Общие параметры сопровождения и управления PTZ.
     */
    this.trackingOptions = {
      captureRadius: 180,
      deadZoneX: 100,
      deadZoneY: 70,
    };

    /**
     * Детектор движущихся областей.
     *
     * Он используется только тогда, когда CSRT не сопровождает цель.
     */
    this.motionDetector = new MotionDetector({
      minArea: 3000,
      threshold: 25,
      blurSize: 21,
    });

    /**
     * Выбирает наиболее подходящую область среди обнаружений.
     *
     * TargetSelector используется только для первоначального
     * захвата или повторного захвата цели.
     */
    this.targetSelector = new TargetSelector({
      frameWidth: width,
      frameHeight: height,
      captureRadius: this.trackingOptions.captureRadius,
      maxMatchDistance: 250,
      lostFrameLimit: 15,
    });

    /**
     * Основной CSRT-трекер.
     */
    this.objectTracker = new ObjectTracker({
      type: 'CSRT',
      minWidth: 8,
      minHeight: 8,
      maxConsecutiveErrors: 3,
      debug: false,
    });

    /**
     * Вычисляет направление движения PTZ.
     */
    this.ptzController = new PtzController({
      frameWidth: width,
      frameHeight: height,
      deadZoneX: this.trackingOptions.deadZoneX,
      deadZoneY: this.trackingOptions.deadZoneY,
      commandIntervalMs: 300,
    });

    /**
     * Накладывает служебную графику на видеокадр.
     */
    this.renderer = new FrameRenderer({
      frameWidth: width,
      frameHeight: height,
      captureRadius: this.trackingOptions.captureRadius,
      deadZoneX: this.trackingOptions.deadZoneX,
      deadZoneY: this.trackingOptions.deadZoneY,
    });

    /**
     * Предыдущее итоговое состояние системы.
     *
     * Используется, чтобы сообщения о захвате и потере цели
     * выводились только при фактическом изменении состояния.
     */
    this.previousState = 'SEARCHING';
  }

  /**
   * Обрабатывает один BGR24-кадр.
   *
   * @param {Buffer} frameBuffer Сырой BGR24-кадр.
   * @param {object} metadata Метаданные кадра.
   *
   * @returns {{
   *   frame: object,
   *   frameBuffer: Buffer,
   *   detections: Array<object>,
   *   tracking: object,
   *   trackedRect: object|null,
   *   ptzCommand: object
   * }}
   */
  process(frameBuffer, metadata = {}) {
    this.validateFrame(frameBuffer);
    /**
     * Начало измерения полного времени обработки кадра.
     */
    const totalStartedAt = performance.now();

    /**
     * Создаём OpenCV Mat из входного BGR24 Buffer.
     */
    const frame = new cv.Mat(frameBuffer, this.height, this.width, cv.CV_8UC3);

    /**
     * Массив обнаружений остаётся пустым во время работы CSRT.
     *
     * Это позволяет рендереру продолжать получать ожидаемый тип данных,
     * но не заставляет MotionDetector выполнять тяжёлые операции.
     */
    let detections = [];

    /**
     * Выбранный TargetSelector кандидат.
     *
     * Во время активного CSRT новый кандидат не нужен.
     */
    let selection = null;

    let trackedRect = null;
    let targetCenter = null;
    let trackerJustStarted = false;

    /**
     * Проверяем состояние трекера до запуска детектора движения.
     */
    const trackerWasActive = this.objectTracker.isActive();

    /**
     * MotionDetector и TargetSelector запускаются только тогда,
     * когда система ещё не сопровождает объект.
     *
     * Раньше детектор движения выполнялся на каждом кадре,
     * даже при активном CSRT. На больших движущихся объектах
     * операции dilate() и findContours() могли значительно
     * увеличивать время обработки.
     */
    if (!trackerWasActive) {
      // detections = this.motionDetector.detect(frame);
      const motionDetectorStartedAt = performance.now();

      detections = this.motionDetector.detect(frame);

      this.#recordPerformance(
        'motionDetector',
        performance.now() - motionDetectorStartedAt,
      );

      // selection = this.targetSelector.update(detections);
      const targetSelectorStartedAt = performance.now();

      selection = this.targetSelector.update(detections);

      this.#recordPerformance(
        'targetSelector',
        performance.now() - targetSelectorStartedAt,
      );

      /**
       * Пытаемся захватить выбранную цель.
       */
      if (selection && selection.target) {
        try {
          // trackedRect = this.objectTracker.start(frame, selection.target);
          const trackerStartStartedAt = performance.now();

          trackedRect = this.objectTracker.start(frame, selection.target);

          this.#recordPerformance(
            'trackerStart',
            performance.now() - trackerStartStartedAt,
          );

          targetCenter = this.objectTracker.getCenter();

          trackerJustStarted = true;

          /**
           * После захвата старая база MotionDetector больше не нужна.
           *
           * Если CSRT позднее потеряет объект, детектор сначала
           * создаст новую актуальную базу сравнения, а не будет
           * сравнивать кадр с очень старым изображением.
           */
          this.motionDetector.reset();
        } catch (error) {
          console.error('[CSRT] Не удалось захватить цель:', error.message);

          this.objectTracker.reset('Ошибка первоначального захвата');
        }
      }
    }

    /**
     * Если трекер был активен до начала обработки текущего кадра,
     * обновляем положение объекта.
     *
     * В кадре первоначального захвата update() не вызывается:
     * init() уже получил этот кадр и начальный ROI.
     */
    if (this.objectTracker.isActive() && !trackerJustStarted) {
      // trackedRect = this.objectTracker.update(frame);
      const trackerUpdateStartedAt = performance.now();

      trackedRect = this.objectTracker.update(frame);

      this.#recordPerformance(
        'trackerUpdate',
        performance.now() - trackerUpdateStartedAt,
      );
      if (trackedRect) {
        targetCenter = this.objectTracker.getCenter();
      }
    }

    /**
     * Получаем актуальное состояние CSRT после start() или update().
     */
    const trackerActive = this.objectTracker.isActive();

    let state = 'SEARCHING';

    if (trackedRect && targetCenter) {
      state = 'TRACKING';
    } else if (trackerActive) {
      /**
       * Трекер ещё не сброшен, но на текущем кадре
       * не смог вернуть достоверный прямоугольник.
       */
      state = 'TEMPORARILY_LOST';
    }

    /**
     * Формируем единый объект состояния для рендерера,
     * PTZ-контроллера и внешнего кода.
     */
    const tracking = {
      state,

      /**
       * Кандидат TargetSelector присутствует только
       * во время поиска и первоначального захвата.
       */
      target: selection?.target ?? null,

      targetCenter,
      trackedRect,
      trackerActive,

      justCaptured: state === 'TRACKING' && this.previousState !== 'TRACKING',

      justLost: state === 'SEARCHING' && this.previousState !== 'SEARCHING',

      trackerState: this.objectTracker.getState(),
    };

    if (tracking.justCaptured) {
      console.log(
        '[CSRT] Цель захвачена: ' +
          `x=${Math.round(targetCenter.x)}, ` +
          `y=${Math.round(targetCenter.y)}, ` +
          `размер=${Math.round(trackedRect.width)}x` +
          `${Math.round(trackedRect.height)}`,
      );
    }

    if (tracking.justLost) {
      console.log('[CSRT] Цель потеряна. ' + 'Переход в режим SEARCHING.');
    }

    /**
     * PTZ получает только актуальный центр
     * успешно сопровождаемой цели.
     */
    // const ptzCommand = this.ptzController.calculate(
    //   state === 'TRACKING' ? targetCenter : null,
    // );

    const ptzCalculateStartedAt = performance.now();

    const ptzCommand = this.ptzController.calculate(
      state === 'TRACKING' ? targetCenter : null,
    );

    this.#recordPerformance(
      'ptzCalculate',
      performance.now() - ptzCalculateStartedAt,
    );

    /**
     * При отсутствии надёжного сопровождения
     * камера должна остановиться.
     */
    if (state !== 'TRACKING') {
      ptzCommand.pan = 'STOP';
      ptzCommand.tilt = 'STOP';
      ptzCommand.moving = false;
    }

    /**
     * Передаём рассчитанную команду исполнительному модулю.
     */
    // this.ptzController.execute(ptzCommand, state);
    const ptzExecuteStartedAt = performance.now();

    this.ptzController.execute(ptzCommand, state);

    this.#recordPerformance(
      'ptzExecute',
      performance.now() - ptzExecuteStartedAt,
    );

    /**
     * Накладываем графику прямо на текущий видеокадр.
     */
    // this.renderer.render({
    //   frame,
    //   detections,
    //   selection: tracking,
    //   trackedRect,
    //   ptzCommand,
    //   metadata,
    // });
    const rendererStartedAt = performance.now();

    this.renderer.render({
      frame,
      detections,
      selection: tracking,
      trackedRect,
      ptzCommand,
      metadata,
    });

    this.#recordPerformance('renderer', performance.now() - rendererStartedAt);
    this.previousState = state;
    /**
     * Получение данных Mat и создание независимой копии кадра.
     *
     * Для кадра 1280×720 BGR24 копируется примерно 2,8 МБ.
     */
    const frameBufferCopyStartedAt = performance.now();

    const processedFrameBuffer = Buffer.from(frame.getData());

    this.#recordPerformance(
      'frameBufferCopy',
      performance.now() - frameBufferCopyStartedAt,
    );
    this.#recordPerformance('total', performance.now() - totalStartedAt);
    return {
      /**
       * OpenCV Mat используется для быстрого
       * отображения через cv.imshow().
       */
      frame,

      /**
       * Независимый Buffer обработанного кадра.
       *
       * Он используется, например, при сохранении JPEG.
       */
      // frameBuffer: Buffer.from(frame.getData()),
      frameBuffer: processedFrameBuffer,

      detections,
      tracking,
      trackedRect,
      ptzCommand,
    };
  }

  /**
   * Проверяет входной BGR24 Buffer.
   *
   * @param {Buffer} frameBuffer
   */
  validateFrame(frameBuffer) {
    if (!Buffer.isBuffer(frameBuffer)) {
      throw new TypeError('FrameProcessor ожидает Buffer');
    }

    if (frameBuffer.length !== this.frameSize) {
      throw new Error(
        `Неверный размер кадра: ${frameBuffer.length}. ` +
          `Ожидалось: ${this.frameSize}`,
      );
    }
  }

  /**
   * Сбрасывает все компоненты сопровождения.
   *
   * Можно вызывать при перезапуске RTSP
   * или изменении камеры.
   */
  reset() {
    this.motionDetector.reset();

    this.objectTracker.reset('Сброс FrameProcessor');

    if (
      this.targetSelector &&
      typeof this.targetSelector.reset === 'function'
    ) {
      this.targetSelector.reset();
    }

    this.previousState = 'SEARCHING';
  }
  /**
   * Создаёт пустой счётчик производительности.
   *
   * @returns {{
   *   totalMs: number,
   *   maxMs: number,
   *   calls: number
   * }}
   */
  #createPerformanceMetric() {
    return {
      totalMs: 0,
      maxMs: 0,
      calls: 0,
    };
  }

  /**
   * Добавляет результат одного измерения.
   *
   * @param {string} metricName Название этапа.
   * @param {number} durationMs Продолжительность в миллисекундах.
   */
  #recordPerformance(metricName, durationMs) {
    const metric = this.performanceStats[metricName];

    if (!metric || !Number.isFinite(durationMs)) {
      return;
    }

    metric.totalMs += durationMs;
    metric.calls += 1;

    if (durationMs > metric.maxMs) {
      metric.maxMs = durationMs;
    }
  }

  /**
   * Возвращает статистику за прошедший интервал
   * и сразу начинает новый интервал измерений.
   *
   * @returns {Object<string, {
   *   calls: number,
   *   averageMs: number,
   *   maxMs: number,
   *   totalMs: number
   * }>}
   */
  getPerformanceStats() {
    const result = {};

    for (const [name, metric] of Object.entries(this.performanceStats)) {
      result[name] = {
        calls: metric.calls,

        averageMs: metric.calls > 0 ? metric.totalMs / metric.calls : 0,

        maxMs: metric.maxMs,
        totalMs: metric.totalMs,
      };

      /**
       * Обнуляем накопленные значения,
       * чтобы следующая выдача содержала данные
       * только за новый интервал.
       */
      this.performanceStats[name] = this.#createPerformanceMetric();
    }

    return result;
  }
}

module.exports = FrameProcessor;
