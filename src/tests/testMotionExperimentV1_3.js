'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extractor = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'tools',
    'motion-experiment',
    'CandidateFeatureExtractor.js',
  ),
  'utf8',
);

assert.match(extractor, /prepareFrame\(frame\)/);
assert.match(extractor, /frame\.getData\(\)/);
assert.doesNotMatch(extractor, /getRegion/);
assert.doesNotMatch(extractor, /\.sobel\(/);
assert.doesNotMatch(extractor, /\.canny\(/);
assert.doesNotMatch(extractor, /bgrToGray/);

const experiment = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'tools',
    'motion-experiment',
    'MotionThresholdExperiment.js',
  ),
  'utf8',
);

assert.match(experiment, /process\.memoryUsage\(\)\.rss/);
assert.match(experiment, /global\.gc\?\.\(\)/);

const workflow = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'tools',
    'motion-experiment',
    'experiment.js',
  ),
  'utf8',
);

assert.match(workflow, /--expose-gc/);

console.log('[MEX 1.3] ✓ no temporary OpenCV Mat per candidate');
console.log('[MEX 1.3] ✓ RSS logging enabled');
console.log('[MEX 1.3] ✓ GC available between threshold runs');
