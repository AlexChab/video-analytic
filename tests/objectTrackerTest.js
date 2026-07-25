'use strict';

const cv = require('@u4/opencv4nodejs');
const ObjectTracker = require('../src/analytics/ObjectTracker');

function createFrame(x, y) {
  const frame = new cv.Mat(480, 640, cv.CV_8UC3);

  frame.drawRectangle(
    new cv.Point2(x, y),
    new cv.Point2(x + 100, y + 100),
    new cv.Vec(255, 255, 255),
    -1,
  );

  return frame;
}

const tracker = new ObjectTracker({
  type: 'CSRT',
  debug: true,
});

const firstFrame = createFrame(200, 150);

tracker.start(firstFrame, new cv.Rect(200, 150, 100, 100));

for (let index = 1; index <= 10; index += 1) {
  // На каждом кадре немного смещаем тестовый объект.
  const frame = createFrame(200 + index * 2, 150 + index);

  const rect = tracker.update(frame);

  console.log(`Кадр ${index}:`, rect);

  if (!rect) {
    console.log('Сопровождение потеряно.');
    break;
  }
}

console.log('Итоговое состояние:', tracker.getState());
