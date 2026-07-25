'use strict';

const cv = require('@u4/opencv4nodejs');

const MotionDetector = require('../detection/MotionDetector');
const TargetSelector = require('../tracking/TargetSelector');
const ObjectTracker = require('../analytics/ObjectTracker');
const PtzController = require('../tracking/PtzController');
const FrameRenderer = require('../rendering/FrameRenderer');

/**
 * Координатор обработки одного видеокадра.
 *
 * Полная цепочка:
 *
 * BGR-кадр
 *   → обнаружение движения
 *   → выбор цели
 *   → захват цели CSRT
 *   → сопровождение цели
 *   → расчёт PTZ-команды
 *   → отрисовка рамок и состояния
 */
class FrameProcessor {
  /**
   * @param {object} options
   * @param {number} options.width Ширина кадра.
   * @param {number} options.height Высота кадра.
   */
  constructor({ width, height }) {
    this.width = width;
    this.height = height;
    this.channels = 3;

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
     * Он используется прежде всего для первоначального обнаружения цели
     * и повторного захвата после её потери.
     */
    this.motionDetector = new MotionDetector({
      minArea: 3000,
      threshold: 25,
      blurSize: 21,
    });

    /**
     * Выбирает наиболее подходящую область среди обнаружений.
     *
     * TargetSelector отвечает только за выбор кандидата.
     * После захвата точное сопровождение выполняет CSRT.
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
     *
     * Метод execute() пока только выводит команды в консоль.
     */
    this.ptzController = new PtzController({
      frameWidth: width,
      frameHeight: height,
      deadZoneX: this.trackingOptions.deadZoneX,
      deadZoneY: this.trackingOptions.deadZoneY,
      commandIntervalMs: 300,
    });

    /**
     * Накладывает служебную графику на видео.
     */
    this.renderer = new FrameRenderer({
      frameWidth: width,
      frameHeight: height,
      captureRadius: this.trackingOptions.captureRadius,
      deadZoneX: this.trackingOptions.deadZoneX,
      deadZoneY: this.trackingOptions.deadZoneY,
    });

    /**
     * Предыдущее итоговое состояние.
     *
     * Используется для вывода сообщений о захвате и потере цели
     * только один раз, а не на каждом кадре.
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
     * Создаём OpenCV Mat из BGR24 Buffer.
     */
    const frame = new cv.Mat(frameBuffer, this.height, this.width, cv.CV_8UC3);

    /**
     * Ищем области движения.
     */
    const detections = this.motionDetector.detect(frame);

    /**
     * TargetSelector выбирает кандидата для первоначального захвата.
     */
    const selection = this.targetSelector.update(detections);

    let trackedRect = null;
    let targetCenter = null;
    let trackerJustStarted = false;

    /**
     * Если CSRT пока не работает, пытаемся захватить цель,
     * которую выбрал TargetSelector.
     */
    if (!this.objectTracker.isActive() && selection && selection.target) {
      try {
        trackedRect = this.objectTracker.start(frame, selection.target);

        targetCenter = this.objectTracker.getCenter();

        trackerJustStarted = true;
      } catch (error) {
        console.error('[CSRT] Не удалось захватить цель:', error.message);

        this.objectTracker.reset('Ошибка первоначального захвата');
      }
    }

    /**
     * Если трекер уже был активен до текущего кадра,
     * обновляем положение объекта.
     *
     * В кадре первоначального захвата update() не вызываем:
     * init() уже получил этот же кадр и начальный ROI.
     */
    if (this.objectTracker.isActive() && !trackerJustStarted) {
      trackedRect = this.objectTracker.update(frame);

      if (trackedRect) {
        targetCenter = this.objectTracker.getCenter();
      }
    }

    /**
     * Если в одном кадре CSRT не вернул координаты, но ещё не был
     * окончательно сброшен, не передаём устаревшую координату в PTZ.
     *
     * Камера в этот момент получает STOP.
     */
    const trackerActive = this.objectTracker.isActive();

    let state = 'SEARCHING';

    if (trackedRect && targetCenter) {
      state = 'TRACKING';
    } else if (trackerActive) {
      state = 'TEMPORARILY_LOST';
    }

    /**
     * Формируем единый объект состояния для рендерера,
     * PTZ-контроллера и внешнего кода.
     */
    const tracking = {
      state,
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
          `y=${Math.round(targetCenter.y)}`,
      );
    }

    if (tracking.justLost) {
      console.log('[CSRT] Цель потеряна. ' + 'Переход в режим SEARCHING.');
    }

    /**
     * PTZ получает только актуальный центр сопровождаемой цели.
     */
    const ptzCommand = this.ptzController.calculate(
      state === 'TRACKING' ? targetCenter : null,
    );

    /**
     * При отсутствии надёжного сопровождения камера должна стоять.
     */
    if (state !== 'TRACKING') {
      ptzCommand.pan = 'STOP';
      ptzCommand.tilt = 'STOP';
      ptzCommand.moving = false;
    }

    /**
     * Оставляем существующий вывод PTZ в консоль.
     *
     * Позже внутри execute() можно будет подключить ONVIF/HTTP-клиент,
     * не меняя остальную обработку.
     */
    this.ptzController.execute(ptzCommand, state);

    /**
     * Накладываем графику прямо на видеокадр.
     */
    this.renderer.render({
      frame,
      detections,
      selection: tracking,
      trackedRect,
      ptzCommand,
      metadata,
    });

    this.previousState = state;

    return {
      /**
       * Mat нужен для быстрого вывода через cv.imshow().
       */
      frame,

      /**
       * Buffer можно использовать для FFmpeg, WebSocket,
       * сохранения JPEG или дальнейшей передачи.
       */
      frameBuffer: Buffer.from(frame.getData()),

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
   * Можно вызывать при перезапуске RTSP или изменении камеры.
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
}

module.exports = FrameProcessor;
