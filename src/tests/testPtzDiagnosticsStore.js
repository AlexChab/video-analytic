'use strict';

const assert = require('node:assert/strict');
const store = require('../camera/PtzDiagnosticsStore');

store.reset();
store.updateController({
  mode: 'COARSE',
  raw: { pan: 'LEFT', requestedPanSpeed: 0.1 },
  stable: { pan: 'LEFT', panSpeed: 0.08 },
});
store.updateDispatcher({
  stage: 'SUBMITTED',
  pan: 'LEFT',
  panSpeed: 0.08,
});
store.updateDriver({
  stage: 'DRY_RUN',
  driver: 'VadirCameraDriver',
  pan: 'LEFT',
  panRate: -1.256,
  dryRun: true,
});

const snapshot = store.getSnapshot();

assert.equal(snapshot.controller.raw.pan, 'LEFT');
assert.equal(snapshot.dispatcher.stage, 'SUBMITTED');
assert.equal(snapshot.driver.stage, 'DRY_RUN');
assert.equal(snapshot.driver.panRate, -1.256);

console.log('[PTZ DIAGNOSTICS] ✓ Controller');
console.log('[PTZ DIAGNOSTICS] ✓ Dispatcher');
console.log('[PTZ DIAGNOSTICS] ✓ Driver');
