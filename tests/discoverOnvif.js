'use strict';

const onvif = require('onvif');

console.log('[ONVIF DISCOVERY] Поиск камер в локальной сети...');

onvif.Discovery.probe(
  {
    timeout: 8000,
  },
  (error, devices) => {
    if (error) {
      console.error('[ONVIF DISCOVERY] Ошибка:', error.message);
      process.exitCode = 1;
      return;
    }

    if (!devices || devices.length === 0) {
      console.log('[ONVIF DISCOVERY] Устройства не найдены.');
      return;
    }

    for (const device of devices) {
      console.log('----------------------------------------');
      console.log('URN:', device.urn);
      console.log('XAddr:', device.xaddrs);
      console.log('Scopes:', device.scopes);
    }
  },
);
