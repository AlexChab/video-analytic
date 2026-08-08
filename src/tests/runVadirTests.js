'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const tests = [
  'testVadirProtocol.js',
  'testVadirDriverMapping.js',
];

let failed = false;

for (const test of tests) {
  console.log(`\n=== ${test} ===`);

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, test)],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status !== 0) {
    failed = true;
    break;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('\n[VADIR TESTS] ✓ Локальные тесты завершены успешно');
}
