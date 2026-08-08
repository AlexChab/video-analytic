'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inspectorPath = path.join(
  __dirname,
  '..',
  'detection',
  'MotionInspector.js',
);

const panelPath = path.join(
  __dirname,
  '..',
  'ui',
  'OverlayPanel.js',
);

const inspector = fs.readFileSync(inspectorPath, 'utf8');
const panel = fs.readFileSync(panelPath, 'utf8');

assert.ok(
  !/^[ \t]*const\s+\w+\s*=\s*new\s+cv\.Mat\s*\(/m.test(inspector),
  'MotionInspector не должен создавать new cv.Mat()',
);

assert.ok(
  !/\.hConcat\s*\(/.test(inspector),
  'MotionInspector не должен использовать hConcat()',
);

assert.match(
  inspector,
  /#drawPassportOverlay/,
);

assert.match(
  inspector,
  /this\.passportPanel\.draw/,
);

assert.match(
  panel,
  /drawRectangle/,
);

assert.match(
  panel,
  /putText/,
);

assert.ok(
  !/^[ \t]*const\s+\w+\s*=\s*new\s+cv\.Mat\s*\(/m.test(panel),
  'OverlayPanel не должен создавать new cv.Mat()',
);

console.log('[MOTION INSPECTOR V2.1] ✓ new cv.Mat() удалён');
console.log('[MOTION INSPECTOR V2.1] ✓ hConcat() удалён');
console.log('[MOTION INSPECTOR V2.1] ✓ паспорт рисуется поверх кадра');
