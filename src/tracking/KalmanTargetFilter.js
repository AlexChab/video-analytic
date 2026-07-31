'use strict';

/**
 * Двумерный фильтр Калмана для сглаживания центра сопровождаемой цели.
 *
 * Модель состояния:
 *   [x, y, vx, vy]
 *
 * где:
 * - x, y   — положение центра цели в пикселях;
 * - vx, vy — скорость движения цели в пикселях в секунду.
 *
 * Фильтр не зависит от OpenCV и реализован на чистом JavaScript.
 */
class KalmanTargetFilter {
  constructor({
    processNoise = 35,
    measurementNoise = 90,
    initialPositionVariance = 400,
    initialVelocityVariance = 2500,
    minDeltaTime = 0.01,
    maxDeltaTime = 0.5,
  } = {}) {
    this.processNoise = this.#positive(processNoise, 35);
    this.measurementNoise = this.#positive(measurementNoise, 90);
    this.initialPositionVariance = this.#positive(initialPositionVariance, 400);
    this.initialVelocityVariance = this.#positive(initialVelocityVariance, 2500);
    this.minDeltaTime = this.#positive(minDeltaTime, 0.01);
    this.maxDeltaTime = Math.max(this.minDeltaTime, this.#positive(maxDeltaTime, 0.5));

    this.reset();
  }

  /** Сбрасывает состояние фильтра. */
  reset() {
    this.initialized = false;
    this.state = [0, 0, 0, 0];
    this.covariance = this.#diagonal([
      this.initialPositionVariance,
      this.initialPositionVariance,
      this.initialVelocityVariance,
      this.initialVelocityVariance,
    ]);
    this.lastTimestampMs = null;
  }

  /**
   * Обновляет фильтр новым измерением центра цели.
   *
   * @param {{x:number,y:number}} measurement
   * @param {number} [timestampMs=Date.now()]
   * @returns {{x:number,y:number,vx:number,vy:number,predictedX:number,predictedY:number,dt:number}|null}
   */
  update(measurement, timestampMs = Date.now()) {
    if (!this.#isPoint(measurement) || !Number.isFinite(timestampMs)) {
      return null;
    }

    if (!this.initialized) {
      this.state = [measurement.x, measurement.y, 0, 0];
      this.lastTimestampMs = timestampMs;
      this.initialized = true;
      return this.#result(0);
    }

    const dt = this.#getDeltaTime(timestampMs);
    this.#predict(dt);
    this.#correct(measurement);
    this.lastTimestampMs = timestampMs;

    return this.#result(dt);
  }

  /** Возвращает текущее состояние без нового измерения. */
  getState() {
    return this.initialized ? this.#result(0) : null;
  }

  #predict(dt) {
    const transition = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];

    this.state = this.#multiplyMatrixVector(transition, this.state);

    const transitionT = this.#transpose(transition);
    const predictedCovariance = this.#multiply(
      this.#multiply(transition, this.covariance),
      transitionT,
    );

    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const q = this.processNoise;
    const processCovariance = [
      [dt4 / 4 * q, 0, dt3 / 2 * q, 0],
      [0, dt4 / 4 * q, 0, dt3 / 2 * q],
      [dt3 / 2 * q, 0, dt2 * q, 0],
      [0, dt3 / 2 * q, 0, dt2 * q],
    ];

    this.covariance = this.#add(predictedCovariance, processCovariance);
  }

  #correct(measurement) {
    const innovation = [
      measurement.x - this.state[0],
      measurement.y - this.state[1],
    ];

    const p = this.covariance;
    const s00 = p[0][0] + this.measurementNoise;
    const s01 = p[0][1];
    const s10 = p[1][0];
    const s11 = p[1][1] + this.measurementNoise;

    const determinant = s00 * s11 - s01 * s10;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
      return;
    }

    const inverseS = [
      [s11 / determinant, -s01 / determinant],
      [-s10 / determinant, s00 / determinant],
    ];

    const pHt = [
      [p[0][0], p[0][1]],
      [p[1][0], p[1][1]],
      [p[2][0], p[2][1]],
      [p[3][0], p[3][1]],
    ];
    const gain = this.#multiply(pHt, inverseS);

    for (let row = 0; row < 4; row += 1) {
      this.state[row] += gain[row][0] * innovation[0] + gain[row][1] * innovation[1];
    }

    // Joseph-подобное упрощённое обновление P = (I - K H)P.
    const identityMinusKh = [
      [1 - gain[0][0], -gain[0][1], 0, 0],
      [-gain[1][0], 1 - gain[1][1], 0, 0],
      [-gain[2][0], -gain[2][1], 1, 0],
      [-gain[3][0], -gain[3][1], 0, 1],
    ];
    this.covariance = this.#multiply(identityMinusKh, p);
  }

  #getDeltaTime(timestampMs) {
    const raw = (timestampMs - this.lastTimestampMs) / 1000;
    if (!Number.isFinite(raw)) return this.minDeltaTime;
    return Math.min(this.maxDeltaTime, Math.max(this.minDeltaTime, raw));
  }

  #result(dt) {
    return {
      x: this.state[0],
      y: this.state[1],
      vx: this.state[2],
      vy: this.state[3],
      predictedX: this.state[0],
      predictedY: this.state[1],
      dt,
    };
  }

  #isPoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  #positive(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  #diagonal(values) {
    return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
  }

  #transpose(matrix) {
    return matrix[0].map((_, column) => matrix.map((row) => row[column]));
  }

  #add(left, right) {
    return left.map((row, i) => row.map((value, j) => value + right[i][j]));
  }

  #multiply(left, right) {
    return left.map((row) => right[0].map((_, column) =>
      row.reduce((sum, value, index) => sum + value * right[index][column], 0),
    ));
  }

  #multiplyMatrixVector(matrix, vector) {
    return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
  }
}

module.exports = KalmanTargetFilter;
