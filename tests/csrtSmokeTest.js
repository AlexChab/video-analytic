const cv = require('@u4/opencv4nodejs');

// Создаем черное изображение
const frame = new cv.Mat(480, 640, cv.CV_8UC3);

// Белый квадрат
frame.drawRectangle(
  new cv.Point2(200, 150),
  new cv.Point2(300, 250),
  new cv.Vec(255, 255, 255),
  -1,
);

// Создаем трекер
const tracker = new cv.TrackerCSRT();

// ROI
const roi = new cv.Rect(200, 150, 100, 100);

console.log('init...');

tracker.init(frame, roi);

console.log('update...');

const result = tracker.update(frame);

console.dir(result, { depth: null });
