'use strict';

const assert = require('node:assert/strict');
const MotionDiagnostics = require('../detection/MotionDiagnostics');

function main() {
  const diagnostics = new MotionDiagnostics({
    enabled: true,
    hudEnabled: true,
    logEnabled: false,
    keepLastRejects: 3,
  });

  diagnostics.beginFrame(10);
  diagnostics.reject('CONTOUR_AREA', { area: 120 });
  diagnostics.reject('BOX_AREA', {
    x: 10, y: 20, width: 20, height: 30, area: 600,
  });
  diagnostics.reject('WIDTH', {
    x: 5, y: 5, width: 12, height: 30, area: 360,
  });
  diagnostics.setPreMergeAccepted(7);
  diagnostics.setPostMergeCount(5);
  diagnostics.setFinalAccepted(4);
  diagnostics.setPipelineCounts({
    rawAccepted: 4,
    stableAccepted: 2,
    objectsWithId: 2,
  });

  const snapshot = diagnostics.getSnapshot();

  assert.equal(snapshot.frame.contours, 10);
  assert.equal(snapshot.frame.rejected.CONTOUR_AREA, 1);
  assert.equal(snapshot.frame.rejected.BOX_AREA, 1);
  assert.equal(snapshot.frame.rejected.WIDTH, 1);
  assert.equal(snapshot.frame.preMergeAccepted, 7);
  assert.equal(snapshot.frame.postMerge, 5);
  assert.equal(snapshot.frame.finalAccepted, 4);
  assert.equal(snapshot.pipeline.stableAccepted, 2);
  assert.equal(snapshot.lastReject.reason, 'WIDTH');

  console.log('[MOTION DIAGNOSTICS] ✓ причины отказа считаются');
  console.log('[MOTION DIAGNOSTICS] ✓ merge/stabilizer этапы видны');
  console.log('[MOTION DIAGNOSTICS] ✓ последний отказ сохраняется');
}

try {
  main();
} catch (error) {
  console.error(`[MOTION DIAGNOSTICS] ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
}
