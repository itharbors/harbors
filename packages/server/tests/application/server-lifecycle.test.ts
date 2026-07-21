import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { ApplicationRuntime } from '../../src/application/runtime';
import { createServer } from '../../src/server';

describe('application server lifecycle', () => {
  it('starts the application runtime before accepting connections and disposes it after sessions', async () => {
    const events: string[] = [];
    const applicationRuntime = {
      start: vi.fn(async () => {
        events.push('application:start');
        return {
          phase: 'ready' as const,
          plugins: [],
          diagnostics: [],
          menu: { tree: [], warnings: [] },
        };
      }),
      getBootstrap: vi.fn(() => ({
        phase: 'ready' as const,
        plugins: [],
        diagnostics: [],
        menu: { tree: [], warnings: [] },
      })),
      triggerMenu: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => { events.push('application:dispose'); }),
    };
    const server = createServer({ applicationRuntime });
    vi.spyOn(server.registry, 'disposeAll').mockImplementation(async () => {
      events.push('sessions:dispose');
    });

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/application/bootstrap`);
    await server.stop();

    expect(response.status).toBe(200);
    expect(applicationRuntime.start).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'application:start',
      'sessions:dispose',
      'application:dispose',
    ]);
  });

  it('allows degraded application startup to listen', async () => {
    const server = createServer({
      applicationRuntime: {
        start: vi.fn(async () => ({
          phase: 'degraded' as const,
          plugins: [],
          diagnostics: [{ code: 'INVALID_KIT_MANIFEST' as const, message: 'broken kit' }],
          menu: { tree: [], warnings: [] },
        })),
        getBootstrap: vi.fn(() => ({
          phase: 'degraded' as const,
          plugins: [],
          diagnostics: [{ code: 'INVALID_KIT_MANIFEST' as const, message: 'broken kit' }],
          menu: { tree: [], warnings: [] },
        })),
        triggerMenu: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
        dispose: vi.fn(async () => undefined),
      },
    });

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/application/bootstrap`);
    await server.stop();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ phase: 'degraded' });
  });

  it('binds the desktop control plane to loopback and protects application mutations', async () => {
    const server = createServer({
      host: '127.0.0.1',
      applicationControlToken: 'launch-secret',
      applicationRuntime: new ApplicationRuntime({ plugins: [], hostMode: 'desktop' }),
    });

    const port = await server.start(0);
    const address = server.server.address() as AddressInfo;
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/application/menu/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ menuId: 'install' }),
    });
    const authorized = await fetch(`http://127.0.0.1:${port}/api/application/menu/trigger`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-harbors-application-token': 'launch-secret',
      },
      body: JSON.stringify({ menuId: 'install' }),
    });
    await Promise.all([server.stop(), server.stop()]);

    expect(address.address).toBe('127.0.0.1');
    expect(unauthorized.status).toBe(403);
    expect(authorized.status).toBe(404);
  });

  it('finishes graceful shutdown while an application event stream is connected', async () => {
    const server = createServer({
      applicationRuntime: new ApplicationRuntime({ plugins: [], hostMode: 'desktop' }),
    });
    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/sse/application`);

    await expect(server.stop()).resolves.toBeUndefined();
    const body = await response.text();

    expect(body).toContain('"phase":"ready"');
    expect(body).toContain('"phase":"stopped"');
  });
});
