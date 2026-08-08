'use strict';

const assert = require('node:assert/strict');
const CrossThresholdMatcher = require(
  '../tools/motion-experiment/CrossThresholdMatcher',
);

const matcher = new CrossThresholdMatcher({
  minIou: 0.1,
  maxCenterDistance: 30,
});

const rows = [
  { frame: 10, threshold: 1, stage: 'FINAL', x: 100, y: 100, width: 20, height: 10 },
  { frame: 10, threshold: 2, stage: 'FINAL', x: 101, y: 100, width: 20, height: 10 },
  { frame: 10, threshold: 3, stage: 'FINAL', x: 102, y: 101, width: 19, height: 10 },
];

const result = matcher.build(rows, [1, 2, 3, 5, 7, 10, 15]);
assert.equal(result.length, 1);
assert.deepEqual(result[0].foundAt, [1, 2, 3]);
assert.deepEqual(result[0].missingAt, [5, 7, 10, 15]);

console.log('[MEX] ✓ cross-threshold matching');
