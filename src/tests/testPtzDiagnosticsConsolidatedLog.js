'use strict';

const assert = require('node:assert/strict');
const store = require('../camera/PtzDiagnosticsStore');

store.reset();
store.configure({ logEnabled: true, logIntervalMs: 50 });
store.updateController({
  mode: 'FINE',
  errorX: 2,
  errorY: 18,
  raw: {
    pan: 'STOP',
    tilt: 'DOWN',
    requestedPanSpeed: 0,
    requestedTiltSpeed: 0.011,
  },
  stable: {
    pan: 'STOP',
    tilt: 'DOWN',
    panSpeed: 0,
    tiltSpeed: 0.009,
  },
});
store.updateDispatcher({
  stage: 'SENT',
  pan: 'STOP',
  tilt: 'DOWN',
  panSpeed: 0,
  tiltSpeed: 0.009,
});
store.updateDriver({
  stage: 'DRY_RUN',
  driver: 'VadirCameraDriver',
  dryRun: true,
  pan: 'STOP',
  tilt: 'DOWN',
  panRate: 0,
  tiltRate: -0.094,
});

const text = store.formatSnapshot();
assert.match(text, /mode=FINE/);
assert.match(text, /dispatch=SENT/);
assert.match(text, /driver=DRY_RUN/);
assert.match(text, /DOWN:-0\.094/);
assert.equal(store.shouldWriteLog(1000), true);
assert.equal(store.shouldWriteLog(1020), false);
assert.equal(store.shouldWriteLog(1060), true);

console.log('[PTZ DIAG V2] ✓ сводная строка Controller→Dispatcher→Driver');
console.log('[PTZ DIAG V2] ✓ ограничение частоты логирования');
