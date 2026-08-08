'use strict';

const assert = require('node:assert/strict');
const MotionDiagnostics = require('../detection/MotionDiagnostics');
const DetectionStabilizer = require('../detection/DetectionStabilizer');

function testThresholds() {
  const diagnostics = new MotionDiagnostics({
    enabled: true,
    inspector: {
      enabled: true,
      maxBoxesPerStage: 10,
    },
  });

  diagnostics.setThresholds({
    minBoxArea: 1400,
    minWidth: 28,
    minHeight: 18,
  });

  diagnostics.beginFrame(3);
  diagnostics.setFinalBoxes([
    { x: 10, y: 10, width: 40, height: 30, area: 1200 },
  ]);
  diagnostics.setFinalAccepted(1);

  const snapshot = diagnostics.getSnapshot();

  assert.equal(snapshot.thresholds.minBoxArea, 1400);
  assert.equal(snapshot.thresholds.minWidth, 28);
  assert.equal(snapshot.inspector.finalAccepted.length, 1);
}

function testUnconfirmedStabilizerTrack() {
  const stabilizer = new DetectionStabilizer({
    enabled: true,
    confirmFrames: 2,
    maxCenterDistance: 120,
    minIou: 0.05,
  });

  const first = stabilizer.update([
    { x: 100, y: 100, width: 40, height: 25, area: 1000 },
  ], 1000);

  assert.equal(first.length, 0);

  let diag = stabilizer.getDiagnosticsSnapshot();

  assert.equal(diag.length, 1);
  assert.equal(diag[0].seenFrames, 1);
  assert.equal(diag[0].requiredConfirmFrames, 2);
  assert.equal(diag[0].confirmed, false);
  assert.equal(diag[0].state, 'WAITING_CONFIRMATION');

  const second = stabilizer.update([
    { x: 102, y: 101, width: 40, height: 25, area: 1000 },
  ], 1100);

  assert.equal(second.length, 1);

  diag = stabilizer.getDiagnosticsSnapshot();

  assert.equal(diag[0].seenFrames, 2);
  assert.equal(diag[0].confirmed, true);
}

testThresholds();
testUnconfirmedStabilizerTrack();

console.log('[MOTION INSPECTOR V2] ✓ thresholds snapshot');
console.log('[MOTION INSPECTOR V2] ✓ unconfirmed track visible');
console.log('[MOTION INSPECTOR V2] ✓ confirmFrames 1/2 -> 2/2');
