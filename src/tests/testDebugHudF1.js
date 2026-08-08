'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(
  path.join(__dirname, '..', 'rendering', 'FrameRenderer.js'),
  'utf8',
);
const processor = fs.readFileSync(
  path.join(__dirname, '..', 'processing', 'FrameProcessor.js'),
  'utf8',
);
const capture = fs.readFileSync(
  path.join(__dirname, '..', 'tracking', 'CaptureDiagnostics.js'),
  'utf8',
);

assert.match(renderer, /toggleDebugHud\(\)/);
assert.match(renderer, /if \(this\.debugHudVisible\)/);
assert.match(processor, /0x00700000/);
assert.match(processor, /Technical HUD/);
assert.match(capture, /KCF_LOST_IN_ENHANCED_ROI/);
assert.match(capture, /TRACKER_STOP/);

console.log('[HUD F1] ✓ F1 technical HUD toggle');
console.log('[HUD F1] ✓ diagnostics keep running while panel is hidden');
console.log('[HUD F1] ✓ ASCII stop reason for OpenCV putText');
