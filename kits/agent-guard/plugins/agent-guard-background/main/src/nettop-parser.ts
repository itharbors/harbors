import type { ConnectionCounter } from './types.js';

const MAX_ROW_BYTES = 64 * 1024;

function integer(value: string, context: string): number {
  if (!/^\d+$/u.test(value)) throw new TypeError(`${context} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${context} is too large`);
  return parsed;
}

function counter(value: string, context: string): bigint {
  if (!/^\d+$/u.test(value)) throw new TypeError(`${context} must be a non-negative integer`);
  return BigInt(value);
}

export function parseNettopRow(row: string): ConnectionCounter {
  if (Buffer.byteLength(row) > MAX_ROW_BYTES) throw new TypeError('nettop row length exceeds limit');
  const fields = row.split(',');
  if (fields.length !== 9) throw new TypeError('nettop row must contain 9 columns');
  const [pid, start, identity, transport, remoteAddress, state, bytesIn, bytesOut, observedAt] = fields;
  if (!identity || identity.length > 1024) throw new TypeError('executableIdentity is invalid');
  if (!remoteAddress || remoteAddress.length > 1024) throw new TypeError('remoteAddress is invalid');
  if (transport !== 'tcp' && transport !== 'udp') throw new TypeError('transport is invalid');
  if (!state || state.length > 128) throw new TypeError('state is invalid');
  return {
    observedAt: integer(observedAt, 'observedAt'),
    pid: integer(pid, 'pid'),
    processStartTime: integer(start, 'processStartTime'),
    executableIdentity: identity,
    remoteAddress,
    transport,
    state,
    bytesIn: counter(bytesIn, 'bytesIn'),
    bytesOut: counter(bytesOut, 'bytesOut'),
  };
}
