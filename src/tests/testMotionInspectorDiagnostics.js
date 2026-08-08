'use strict';

const assert = require('node:assert/strict');
const MotionDiagnostics = require('../detection/MotionDiagnostics');

const d = new MotionDiagnostics({
  enabled: true,
  inspector: {
    enabled: true,
    maxBoxesPerStage: 3,
  },
});

d.beginFrame(10);
d.reject('BOX_AREA', {
  x: 10,
  y: 20,
  width: 12,
  height: 8,
  area: 96,
});
d.reject('CONTOUR_AREA', { area: 2 });
d.setPreMergeBoxes([
  { x: 1, y: 2, width: 30, height: 20 },
  { x: 2, y: 3, width: 40, height: 30 },
]);
d.setPostMergeBoxes([
  { x: 1, y: 2, width: 70, height: 40 },
]);
d.setFinalBoxes([
  { x: 0, y: 0, width: 80, height: 50 },
]);
d.setPreMergeAccepted(2);
d.setPostMergeCount(1);
d.setFinalAccepted(1);

const s = d.getSnapshot();

assert.equal(s.inspector.rejects.length, 1);
assert.equal(s.inspector.rejects[0].reason, 'BOX_AREA');
assert.equal(s.inspector.preMerge.length, 2);
assert.equal(s.inspector.postMerge.length, 1);
assert.equal(s.inspector.finalAccepted.length, 1);
assert.equal(s.frame.rejected.CONTOUR_AREA, 1);

console.log('[MOTION INSPECTOR] ✓ reject geometry');
console.log('[MOTION INSPECTOR] ✓ PRE/MERGE/RAW stages');
console.log('[MOTION INSPECTOR] ✓ contour reject remains in counters');
