import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { AuthManager } from '../../src/auth';
import { SessionManager } from '../../src/session/manager';
import { SessionStore } from '../../src/session/store';
import { SSEChannel } from '../../src/sse/channel';
import { createPanelAssetRouter } from '../../src/routes/panel-asset';
import type { Editor } from '../../src/editor/types';
import { testAssembly } from '../helpers/assembly';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

describe('Session route access matrix', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('rejects another owner on SSE even with a forged forwarded loopback header', async () => {
    const dbPath = path.join(os.tmpdir(), `harbors-access-${Date.now()}-${Math.random()}.db`);
    const store = new SessionStore(dbPath);
    const manager = new SessionManager(store);
    const auth = new AuthManager({ dbPath });
    const userA = auth.users.create('A');
    const userB = auth.users.create('B');
    auth.devices.authorize('device-b', userB.userId);
    manager.getOrCreate('session-a', '', userA.userId);
    const channel = new SSEChannel();
    const app = createApp(manager, channel, {
      assembly: testAssembly,
      applicationRuntime: {
        getBootstrap: vi.fn(), request: vi.fn(), retryPlugin: vi.fn(), triggerMenu: vi.fn(), subscribe: vi.fn(() => () => undefined),
      },
      pluginPathRoots: createTestPluginPathRoots(),
      authManager: auth,
    });
    cleanups.push(async () => {
      await app.registry.disposeAll();
      channel.closeAll();
      app.broker.destroy();
      await app.localWebFiles.dispose();
      app.stopDisconnectHandling();
      store.close();
      auth.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    });

    const req = mockRequest('/sse/session-a', 'device-b');
    const response = mockResponse();
    await app.handleRequest(req, response.res);
    expect(response.status()).toBe(403);
    expect(response.body()).toContain('SESSION_FORBIDDEN');
  });

  it('requires an explicit accessible Session for remote asset fallback', () => {
    const router = createPanelAssetRouter(new Map<string, Editor>(), {
      allowUnscopedFallback: () => false,
      assertSessionAccess: () => { throw new Error('guarded'); },
    });
    expect(() => router(mockRequest('/api/assets/plugin/example/index.js', 'device'), mockResponse().res))
      .toThrow(/identify an accessible Session/);
    expect(() => router(mockRequest('/api/assets/plugin/example/index.js?sessionId=other::kit', 'device'), mockResponse().res))
      .toThrow('guarded');
  });
});

function mockRequest(url: string, deviceId: string): IncomingMessage {
  const req = new Readable({ read() { this.push(null); } });
  return Object.assign(req, {
    method: 'GET', url,
    headers: { 'x-device-id': deviceId, 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '203.0.113.8' },
  }) as unknown as IncomingMessage;
}

function mockResponse(): { res: ServerResponse; status(): number; body(): string } {
  const chunks: Buffer[] = [];
  const writable = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const res = Object.assign(writable, {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    writeHead(code: number) { this.statusCode = code; this.headersSent = true; return this; },
    end(data?: string | Buffer) { if (data) chunks.push(Buffer.from(data)); this.headersSent = true; return this; },
  }) as unknown as ServerResponse;
  return { res, status: () => res.statusCode, body: () => Buffer.concat(chunks).toString('utf8') };
}
