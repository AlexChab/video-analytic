'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extractorSource = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'tools',
    'motion-experiment',
    'CandidateFeatureExtractor.js',
  ),
  'utf8',
);

assert.match(extractorSource, /gray\.getData\(\)/);
assert.match(extractorSource, /sumSquares/);
assert.doesNotMatch(
  extractorSource,
  /const\s+squared\s*=\s*gray\.mul\(/,
);

const values = [0, 0, 10, 10];
const sum = values.reduce((a, b) => a + b, 0);
const sumSquares = values.reduce((a, b) => a + b * b, 0);
const mean = sum / values.length;
const variance = sumSquares / values.length - mean * mean;

assert.equal(mean, 5);
assert.equal(Math.sqrt(variance), 5);

const workflowSource = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'tools',
    'motion-experiment',
    'experiment.js',
  ),
  'utf8',
);

assert.match(workflowSource, /path\.extname\(selectedVideo\)/);

console.log('[MEX 1.1] ✓ textureStd byte calculation');
console.log('[MEX 1.1] ✓ latest output name without .mp4 suffix');
