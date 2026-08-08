'use strict';

const assert = require('node:assert/strict');
const ParameterSweep = require('../tools/motion-analyzer/ParameterSweep');

const ascending = new ParameterSweep({
  parameter: 'threshold',
  from: 3,
  to: 7,
  step: 2,
});

assert.deepEqual(ascending.getValues(), [3, 5, 7]);

const descending = new ParameterSweep({
  parameter: 'minBoxArea',
  from: 1400,
  to: 800,
  step: 300,
});

assert.deepEqual(descending.getValues(), [1400, 1100, 800]);

const base = {
  threshold: 3,
  diagnostics: {
    enabled: false,
  },
};

const config = ascending.apply(base, 10);

assert.equal(config.threshold, 10);
assert.equal(config.diagnostics.enabled, true);
assert.equal(config.diagnostics.logEnabled, false);
assert.equal(base.threshold, 3);

console.log('[MPA] ✓ ParameterSweep');
