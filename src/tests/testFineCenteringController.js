'use strict';

const assert = require('node:assert/strict');
const FineCenteringController = require(
  '../tracking/FineCenteringController',
);

function main() {
  const fine = new FineCenteringController({
    enabled: true,
    enterErrorX: 24,
    enterErrorY: 24,
    stopErrorX: 5,
    stopErrorY: 5,
    hysteresis: 4,
    minPanSpeed: 0.006,
    maxPanSpeed: 0.020,
    minTiltSpeed: 0.005,
    maxTiltSpeed: 0.015,
  });

  let result = fine.evaluate(100, 10);
  assert.equal(result.mode, 'COARSE');

  result = fine.evaluate(0, 18);
  assert.equal(result.mode, 'FINE');
  assert.equal(result.panActive, false);
  assert.equal(result.tiltActive, true);
  assert.equal(result.panSpeed, 0);
  assert.ok(result.tiltSpeed > 0);

  result = fine.evaluate(4, -3);
  assert.equal(result.mode, 'FINE');
  assert.equal(result.centered, true);
  assert.equal(result.panActive, false);
  assert.equal(result.tiltActive, false);

  result = fine.evaluate(26, 2);
  assert.equal(
    result.mode,
    'FINE',
    'Гистерезис должен удерживать FINE до 28 px',
  );

  result = fine.evaluate(29, 2);
  assert.equal(result.mode, 'COARSE');

  console.log('[FINE CENTERING] ✓ вход в FINE');
  console.log('[FINE CENTERING] ✓ независимое управление осями');
  console.log('[FINE CENTERING] ✓ STOP в пределах 5x5');
  console.log('[FINE CENTERING] ✓ гистерезис COARSE/FINE');
}

try {
  main();
} catch (error) {
  console.error(
    `[FINE CENTERING] ОШИБКА: ${error.stack || error.message}`,
  );
  process.exitCode = 1;
}
