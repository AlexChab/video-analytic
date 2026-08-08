'use strict';

const assert = require('node:assert/strict');
const ResultCollector = require('../tools/motion-analyzer/ResultCollector');

const collector = new ResultCollector({
  parameter: 'threshold',
  value: 10,
  target: { x: 0, y: 0, width: 10, height: 10 },
});

collector.add({
  measured: true,
  elapsedMs: 5,
  diagnostics: {
    frame: {
      contours: 100,
      preMergeAccepted: 10,
      postMerge: 8,
      finalAccepted: 6,
      rejected: {
        CONTOUR_AREA: 80,
        BOX_AREA: 4,
        WIDTH: 1,
        HEIGHT: 0,
        ASPECT: 0,
        MAX_AREA: 0,
      },
    },
  },
  raw: new Array(6).fill({}),
  stable: new Array(4).fill({}),
  objects: [
    { id: 1 },
    { id: 2 },
    { id: 3 },
  ],
  targetResult: {
    stage: 'ID',
  },
});

const result = collector.finish();

assert.equal(result.averages.contours, 100);
assert.equal(result.averages.raw, 6);
assert.equal(result.averages.stable, 4);
assert.equal(result.averages.ids, 3);
assert.equal(result.target.idRate, 100);
assert.equal(result.target.dominantStage, 'ID');

console.log('[MPA] ✓ ResultCollector');
