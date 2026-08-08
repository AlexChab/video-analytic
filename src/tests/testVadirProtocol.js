'use strict';

const assert = require('node:assert/strict');
const VadirProtocol = require('../camera/vadir/VadirProtocol');

function run() {
  console.log('[VADIR PROTOCOL] Начало тестов');

  const query = VadirProtocol.query('20PP');
  assert.match(query, /^\?ZZZ20PP;[0-9A-F]{2}>$/);

  const setPan = VadirProtocol.set('20PR', 1.57);
  assert.match(setPan, /^<ZZZ20PR1\.57;[0-9A-F]{2}>$/);

  const payload = '!ZZZ20PP838877;';
  const checksum = VadirProtocol.calculateChecksum(payload)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');

  const parsed = VadirProtocol.parseResponse(`${payload}${checksum}>`);
  assert.ok(parsed);
  assert.equal(parsed.address, '20PP');
  assert.equal(parsed.value, '838877');

  assert.equal(
    VadirProtocol.parseResponse('!ZZZ20PP838877;00>'),
    null,
    'Повреждённая контрольная сумма должна отклоняться',
  );

  assert.throws(
    () => VadirProtocol.query('BAD'),
    /Некорректный адрес/,
  );

  assert.throws(
    () => VadirProtocol.set('20PR', Number.NaN),
    /конечным числом/,
  );

  console.log('[VADIR PROTOCOL] ✓ Все тесты пройдены');
}

try {
  run();
} catch (error) {
  console.error(`[VADIR PROTOCOL] ОШИБКА: ${error.stack || error.message}`);
  process.exitCode = 1;
}
