'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'tools',
    'motion-experiment',
    'CandidateFeatureExtractor.js',
  ),
  'utf8',
);

assert.match(
  source,
  /getRegion\(new cv\.Rect\([\s\S]*?\)\)\.copy\(\)/,
);
assert.match(source, /const data = gray\.getData\(\)/);

console.log('[MEX 1.2] ✓ ROI is copied before getData-based statistics');
