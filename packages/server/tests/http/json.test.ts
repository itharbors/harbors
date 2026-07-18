import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readBody, readJson } from '../../src/http/json';

function requestWith(body: string | Buffer): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    method: 'POST',
    url: '/test',
    headers: {},
  }) as unknown as IncomingMessage;
}

function interruptedRequest(event: 'aborted' | 'error'): IncomingMessage {
  const request = new Readable({ read() {} });
  queueMicrotask(() => {
    if (event === 'error') {
      request.emit('error', new Error('socket failed'));
    } else {
      request.emit('aborted');
    }
  });
  return Object.assign(request, {
    method: 'POST',
    url: '/test',
    headers: {},
  }) as unknown as IncomingMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

describe('HTTP JSON utilities', () => {
  it('parses valid JSON after enforcing the body limit', async () => {
    await expect(readJson(requestWith('{"ok":true}'), isRecord)).resolves.toEqual({ ok: true });
  });

  it('returns stable errors for invalid and empty JSON bodies', async () => {
    await expect(readJson(requestWith('{bad'), isRecord)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_JSON',
    });
    await expect(readJson(requestWith(''), isRecord)).rejects.toMatchObject({
      status: 400,
      code: 'EMPTY_BODY',
    });
    await expect(
      readJson(requestWith(''), isRecord, { emptyValue: {} }),
    ).resolves.toEqual({});
  });

  it('rejects a request body larger than one MiB', async () => {
    await expect(readBody(requestWith(Buffer.alloc(1024 * 1024 + 1)))).rejects.toMatchObject({
      status: 413,
      code: 'BODY_TOO_LARGE',
    });
  });

  it.each([
    ['aborted', 'REQUEST_ABORTED'],
    ['error', 'REQUEST_READ_FAILED'],
  ] as const)('settles when the request emits %s', async (event, code) => {
    await expect(readBody(interruptedRequest(event))).rejects.toMatchObject({
      status: 400,
      code,
    });
  });
});
