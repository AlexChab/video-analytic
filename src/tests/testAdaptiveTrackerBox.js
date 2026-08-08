'use strict';

const assert = require('node:assert/strict');
const AdaptiveTrackerBox = require('../tracking/AdaptiveTrackerBox');

function main() {
  const box = new AdaptiveTrackerBox({
    enabled: true,
    minWidth: 64,
    minHeight: 64,
    smallTargetMaxSize: 64,
    mediumTargetMaxSize: 120,
    largeTargetMaxSize: 240,
    smallPaddingRatio: 0.60,
    mediumPaddingRatio: 0.35,
    largePaddingRatio: 0.15,
    hugePaddingRatio: 0.05,
    maxPaddingX: 32,
    maxPaddingY: 32,
    maxExpansionRatio: 3.5,
  });

  const small = box.prepare(
    { id: 10, x: 100, y: 100, width: 24, height: 20 },
    1920,
    1080,
  );

  assert.equal(small.id, 10);
  assert.equal(small.adaptiveTrackerBox.profile, 'SMALL');
  assert.ok(small.width > 24);
  assert.ok(small.height > 20);
  assert.ok(small.width <= 84);
  assert.ok(small.height <= 70);

  const nearEdge = box.prepare(
    { x: 0, y: 0, width: 20, height: 20 },
    100,
    100,
  );

  assert.equal(nearEdge.x, 0);
  assert.equal(nearEdge.y, 0);
  assert.ok(nearEdge.x + nearEdge.width <= 100);
  assert.ok(nearEdge.y + nearEdge.height <= 100);

  const large = box.prepare(
    { x: 200, y: 200, width: 300, height: 180 },
    1920,
    1080,
  );

  assert.equal(large.adaptiveTrackerBox.profile, 'HUGE');
  assert.ok(large.width > 300);
  assert.ok(large.width < 340);

  const disabled = new AdaptiveTrackerBox({
    enabled: false,
  }).prepare(
    { id: 15, x: 10, y: 20, width: 30, height: 40 },
    1920,
    1080,
  );

  assert.deepEqual(
    {
      x: disabled.x,
      y: disabled.y,
      width: disabled.width,
      height: disabled.height,
    },
    { x: 10, y: 20, width: 30, height: 40 },
  );

  console.log('[ADAPTIVE TRACKER BOX] ✓ маленькая цель расширяется');
  console.log('[ADAPTIVE TRACKER BOX] ✓ границы кадра соблюдаются');
  console.log('[ADAPTIVE TRACKER BOX] ✓ крупная цель меняется минимально');
  console.log('[ADAPTIVE TRACKER BOX] ✓ отключение возвращает исходную рамку');
}

try {
  main();
} catch (error) {
  console.error(
    `[ADAPTIVE TRACKER BOX] ОШИБКА: ${error.stack || error.message}`,
  );
  process.exitCode = 1;
}
