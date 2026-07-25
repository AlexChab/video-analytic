/**
 * Рассчитывает команды управления PTZ-камерой.
 *
 * Сейчас команды только выводятся в консоль.
 * Позже метод execute() можно будет заменить настоящим
 * HTTP-, ONVIF- или другим клиентом камеры.
 */
class PtzController {
  /**
   * @param {object} options
   * @param {number} options.frameWidth Ширина кадра.
   * @param {number} options.frameHeight Высота кадра.
   * @param {number} [options.deadZoneX=100]
   * Половина мёртвой зоны по горизонтали.
   * @param {number} [options.deadZoneY=70]
   * Половина мёртвой зоны по вертикали.
   * @param {number} [options.commandIntervalMs=300]
   * Минимальный интервал повторного вывода команды.
   */
  constructor({
    frameWidth,
    frameHeight,
    deadZoneX = 100,
    deadZoneY = 70,
    commandIntervalMs = 300,
  }) {
    this.frameCenter = {
      x: frameWidth / 2,
      y: frameHeight / 2,
    };

    this.deadZoneX = deadZoneX;
    this.deadZoneY = deadZoneY;
    this.commandIntervalMs = commandIntervalMs;

    this.lastCommandKey = null;
    this.lastCommandTime = 0;
  }

  /**
   * Рассчитывает команду по положению центра цели.
   *
   * @param {{x:number,y:number}|null} targetCenter
   * @returns {{
   *   pan: string,
   *   tilt: string,
   *   errorX: number,
   *   errorY: number,
   *   moving: boolean
   * }}
   */
  calculate(targetCenter) {
    if (!targetCenter) {
      return {
        pan: 'STOP',
        tilt: 'STOP',
        errorX: 0,
        errorY: 0,
        moving: false,
      };
    }

    const errorX = targetCenter.x - this.frameCenter.x;

    const errorY = targetCenter.y - this.frameCenter.y;

    let pan = 'STOP';
    let tilt = 'STOP';

    if (errorX < -this.deadZoneX) {
      pan = 'LEFT';
    } else if (errorX > this.deadZoneX) {
      pan = 'RIGHT';
    }

    if (errorY < -this.deadZoneY) {
      tilt = 'UP';
    } else if (errorY > this.deadZoneY) {
      tilt = 'DOWN';
    }

    return {
      pan,
      tilt,
      errorX,
      errorY,
      moving: pan !== 'STOP' || tilt !== 'STOP',
    };
  }

  /**
   * Пока только выводит команду в консоль.
   *
   * В дальнейшем здесь можно вызвать:
   *
   * await cameraPtzClient.move(command);
   */
  execute(command, state) {
    const commandKey = `${state}:${command.pan}:${command.tilt}`;

    const currentTime = Date.now();

    const commandChanged = commandKey !== this.lastCommandKey;

    const intervalElapsed =
      currentTime - this.lastCommandTime >= this.commandIntervalMs;

    if (!commandChanged && !intervalElapsed) {
      return;
    }

    console.log(
      `[PTZ] state=${state}, ` +
        `PAN=${command.pan}, ` +
        `TILT=${command.tilt}, ` +
        `errorX=${Math.round(command.errorX)}, ` +
        `errorY=${Math.round(command.errorY)}`,
    );

    this.lastCommandKey = commandKey;
    this.lastCommandTime = currentTime;
  }
}

module.exports = PtzController;
