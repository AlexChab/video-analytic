'use strict';

const assert = require('node:assert/strict');
const TargetMatcher = require('../tools/motion-analyzer/TargetMatcher');

const matcher = new TargetMatcher({
  minIou: 0.01,
  maxCenterDistance: 50,
});

const target = {
  x: 100,
  y: 100,
  width: 40,
  height: 20,
};

let result = matcher.classify(target, {
  raw: [
    { x: 103, y: 101, width: 38, height: 21 },
  ],
});

assert.equal(result.stage, 'RAW');

result = matcher.classify(target, {
  rejects: [
    {
      x: 102,
      y: 100,
      width: 36,
      height: 20,
      reason: 'BOX_AREA',
    },
  ],
});

assert.equal(result.stage, 'REJECT');
assert.equal(result.reason, 'BOX_AREA');

result = matcher.classify(target, {
  objects: [
    { id: 17, x: 101, y: 99, width: 40, height: 20 },
  ],
});

assert.equal(result.stage, 'ID');
assert.equal(result.box.id, 17);

console.log('[MPA] ✓ TargetMatcher');
