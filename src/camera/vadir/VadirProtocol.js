'use strict';

/**
 * Формирование и разбор текстового протокола управления камерой VADIR.
 *
 * Формат команды записи:
 *   <ZZZ20PR15.70;CS>
 *
 * Формат запроса:
 *   ?ZZZ20PP;CS>
 *
 * Формат ответа камеры:
 *   !ZZZ20PP123456;CS>
 *
 * CS — XOR всех ASCII-байтов от первого символа пакета до ';' включительно.
 */
class VadirProtocol {
  /** Формирует запрос значения по четырёхсимвольному адресу. */
  static query(address) {
    this.#validateAddress(address);
    return this.#build('?', address);
  }

  /** Формирует команду записи числового значения. */
  static set(address, value) {
    this.#validateAddress(address);

    if (!Number.isFinite(value)) {
      throw new TypeError(`Значение команды ${address} должно быть конечным числом`);
    }

    return this.#build('<', `${address}${value.toFixed(2)}`);
  }

  /**
   * Проверяет и разбирает ответ камеры.
   * Возвращает null, если пакет повреждён или не соответствует протоколу.
   */
  static parseResponse(message) {
    if (typeof message !== 'string') return null;

    const match = /^!ZZZ([0-9A-Z]{4})(.*);([0-9A-Fa-f]{2})>$/.exec(message);
    if (!match) return null;

    const semicolonIndex = message.lastIndexOf(';');
    const payload = message.slice(0, semicolonIndex + 1);
    const expectedChecksum = Number.parseInt(match[3], 16);
    const actualChecksum = this.calculateChecksum(payload);

    if (actualChecksum !== expectedChecksum) return null;

    return {
      address: match[1],
      value: match[2],
      raw: message,
    };
  }

  /** Вычисляет XOR-контрольную сумму ASCII-последовательности. */
  static calculateChecksum(payload) {
    let checksum = 0;
    for (const byte of Buffer.from(payload, 'ascii')) {
      checksum ^= byte;
    }
    return checksum;
  }

  static #build(prefix, body) {
    const payload = `${prefix}ZZZ${body};`;
    const checksum = this.calculateChecksum(payload)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');

    return `${payload}${checksum}>`;
  }

  static #validateAddress(address) {
    if (typeof address !== 'string' || !/^[0-9A-Z]{4}$/.test(address)) {
      throw new TypeError(`Некорректный адрес протокола VADIR: ${address}`);
    }
  }
}

module.exports = VadirProtocol;
