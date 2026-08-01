import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  createNotificationCapability,
  HostCapabilityError,
} from '../../src/application/notification-capability';

const require = createRequire(import.meta.url);
const testCreateHmac = createHmac;

describe('notification host capability', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('binds a frozen desktop client to the validated owner without exposing transport details', async () => {
    const record = { id: 'n1', title: 'Done', body: '', level: 'success', source: null,
      durationMs: 8000, persistent: false, createdAt: '2026-01-01T00:00:00.000Z', read: false };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (String(url).endsWith('/read-all')) return Response.json({ unreadCount: 0 });
      if (!init?.method) return Response.json({ notifications: [record], unreadCount: 1 });
      return Response.json(record, { status: 201 });
    });
    const capability = createNotificationCapability({
      hostMode: 'desktop', permissions: ['notifications'], owner: '@example/background',
      port: 49123, fetch: fetchMock as typeof fetch,
      ownerAuthToken: 'a'.repeat(64),
    });

    expect(Object.isFrozen(capability)).toBe(true);
    expect(JSON.stringify(capability)).not.toContain('49123');
    await capability.create({ title: '  Done  ', level: 'success' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-harbors-plugin-owner': '@example/background',
      'x-harbors-owner-proof': createHmac('sha256', 'a'.repeat(64))
        .update('harbors.notification-owner.v1\0').update('@example/background').digest('hex'),
    });
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Done', level: 'success' });
    expect(() => capability.create({ title: 'x', port: 123 } as never)).toThrow();
    await capability.list();
    await capability.markRead('a/b');
    await capability.markAllRead();
    await capability.remove('a/b');
    expect(fetchMock.mock.calls.map(([url, call]) => [String(url).replace('http://127.0.0.1:49123', ''), call?.method]))
      .toEqual([
        ['/v1/notifications', 'POST'], ['/v1/notifications', undefined],
        ['/v1/notifications/a%2Fb/read', 'POST'], ['/v1/notifications/read-all', 'POST'],
        ['/v1/notifications/a%2Fb', 'DELETE'],
      ]);
  });

  it.each([
    [{ hostMode: 'web', permissions: ['notifications'], owner: '@example/background' }, 'CAPABILITY_UNSUPPORTED'],
    [{ hostMode: 'desktop', permissions: [], owner: '@example/background', port: 49123, ownerAuthToken: 'a'.repeat(64) }, 'CAPABILITY_NOT_PERMITTED'],
  ] as const)('fails closed with structured capability errors', (options, code) => {
    try {
      createNotificationCapability(options);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(HostCapabilityError);
      expect((error as HostCapabilityError).code).toBe(code);
    }
  });

  it('keeps the timeout active while reading a deferred response body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    })));
    const capability = createNotificationCapability({ hostMode: 'desktop', permissions: ['notifications'],
      owner: '@example/background', ownerAuthToken: 'a'.repeat(64), port: 49123, fetch: fetchMock as typeof fetch });
    const pending = capability.list();
    const rejected = expect(pending).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    vi.useRealTimers();
  });

  it('rejects oversized streamed Host bodies', async () => {
    const bytes = new Uint8Array(40_000);
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.enqueue(bytes); controller.close(); },
    })));
    const capability = createNotificationCapability({ hostMode: 'desktop', permissions: ['notifications'],
      owner: '@example/background', ownerAuthToken: 'a'.repeat(64), port: 49123, fetch: fetchMock as typeof fetch });
    await expect(capability.list()).rejects.toThrow('too large');
  });

  it('rejects malformed successful Host payloads', async () => {
    const capability = createNotificationCapability({ hostMode: 'desktop', permissions: ['notifications'],
      owner: '@example/background', ownerAuthToken: 'a'.repeat(64), port: 49123,
      fetch: vi.fn(async () => Response.json({ notifications: [{}], unreadCount: 1 })) as typeof fetch });
    await expect(capability.list()).rejects.toThrow('invalid record');
  });

  it('uses the module-captured native fetch after a plugin replaces global fetch', async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ notifications: [], unreadCount: 0 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('plugin replacement'); }));
    try {
      const capability = createNotificationCapability({ hostMode: 'desktop', permissions: ['notifications'],
        owner: '@example/background', ownerAuthToken: 'a'.repeat(64), port });
      await expect(capability.list()).resolves.toEqual({ notifications: [], unreadCount: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses the module-captured HMAC implementation after builtin exports are replaced', async () => {
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const original = crypto.createHmac;
    const observedKeys: unknown[] = [];
    crypto.createHmac = ((algorithm: string, key: unknown, ...rest: unknown[]) => {
      observedKeys.push(key);
      return original(algorithm, key as any, ...(rest as []));
    }) as typeof crypto.createHmac;
    syncBuiltinESMExports();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 'n1', title: 'Done', body: '', level: 'success', source: null,
        durationMs: 8000, persistent: false, createdAt: '2026-01-01T00:00:00.000Z', read: false }));
    try {
      const master = 'c'.repeat(64);
      const capability = createNotificationCapability({ hostMode: 'desktop', permissions: ['notifications'],
        owner: '@example/background', ownerAuthToken: master, port: 49123, fetch: fetchMock as typeof fetch });
      await capability.create({ title: 'Done' });
      expect(observedKeys).toEqual([]);
      const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['x-harbors-owner-proof']).toBe(testCreateHmac('sha256', master)
        .update('harbors.notification-owner.v1\0').update('@example/background').digest('hex'));
    } finally {
      crypto.createHmac = original;
      syncBuiltinESMExports();
    }
  });
});
