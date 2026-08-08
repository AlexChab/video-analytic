'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ProjectPaths = require(
  '../tools/motion-experiment/ProjectPaths',
);

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'motion-exp-workflow-'),
);
const fakeToolDir = path.join(
  root,
  'src',
  'tools',
  'motion-experiment',
);
fs.mkdirSync(fakeToolDir, { recursive: true });

const paths = new ProjectPaths(fakeToolDir);

assert.equal(
  path.normalize(paths.srcDir),
  path.normalize(path.join(root, 'src')),
);

assert.equal(
  path.normalize(paths.projectRoot),
  path.normalize(root),
);

assert.equal(
  path.normalize(paths.samplesDir),
  path.normalize(path.join(root, 'samples')),
);

const generated = paths.makeRecordingPath();
assert.equal(path.extname(generated).toLowerCase(), '.mp4');

const named = paths.makeRecordingPath('weak boat');
assert.equal(path.basename(named), 'weak-boat.mp4');

fs.rmSync(root, { recursive: true, force: true });

console.log('[EXP] ✓ project paths');
console.log('[EXP] ✓ automatic recording names');
