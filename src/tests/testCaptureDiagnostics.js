'use strict';

const assert = require('node:assert/strict');
const CaptureDiagnostics = require('../tracking/CaptureDiagnostics');

const d = new CaptureDiagnostics({ enabled: true, historyLength: 5 });

let s = d.update({
  state: 'TRACKING',
  targetId: 42,
  detections: [{ id: 42 }],
  trackedRect: { x: 1, y: 1, width: 20, height: 20 },
  trackerState: {
    active: true,
    roi: {
      warning: false,
      warningFrames: 0,
      recenterAfterWarningFrames: 8,
      recenterCount: 2,
      maxRecenters: 0,
      cooldownRemaining: 0,
      safeArea: {
        outsideSafeArea: false,
        side: null,
        maxOverflowPx: 0,
      },
    },
  },
});

assert.equal(s.attention.reason, 'TRACKING_OK');
assert.equal(s.targetPresent, true);

s = d.update({
  state: 'TRACKING',
  targetId: 42,
  detections: [{ id: 42 }],
  trackedRect: { x: 1, y: 1, width: 20, height: 20 },
  trackerState: {
    active: true,
    roi: {
      warning: true,
      warningFrames: 4,
      recenterAfterWarningFrames: 8,
      recenterCount: 3,
      maxRecenters: 0,
      cooldownRemaining: 0,
      safeArea: {
        outsideSafeArea: true,
        side: 'LEFT',
        maxOverflowPx: 14,
      },
    },
    lastRecenter: {
      effective: false,
      beforeOverflowPx: 15,
      afterOverflowPx: 14,
    },
  },
});

assert.equal(s.attention.reason, 'RECENTER_INEFFECTIVE');

s = d.update({
  state: 'TEMPORARILY_LOST',
  targetId: 42,
  detections: [{ id: 42 }],
  trackedRect: null,
  trackerState: {
    active: true,
    roi: { safeArea: null },
  },
});

assert.equal(s.attention.reason, 'KCF_UPDATE_NO_RECT');
assert.equal(s.lastEvent.from, 'TRACKING');
assert.equal(s.lastEvent.to, 'TEMPORARILY_LOST');

console.log('[CAPTURE DEBUGGER] ✓ TRACKING_OK');
console.log('[CAPTURE DEBUGGER] ✓ RECENTER_INEFFECTIVE');
console.log('[CAPTURE DEBUGGER] ✓ KCF_UPDATE_NO_RECT + state transition');
