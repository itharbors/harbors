import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ApplicationRuntime } from '../../src/application/runtime';
import { createServer } from '../../src/server';
import { testAssembly } from '../helpers/assembly';

describe('application server lifecycle', () => {
  it('keeps application plugins and sessions on one snapshot after caller assembly mutation', async () => {
    const callerAssembly = {
      ...testAssembly,
      kitSources: testAssembly.kitSources.map((source) => ({ ...source })),
    };
    const server = createServer({ assembly: callerAssembly });
    callerAssembly.kitSources = [{
      directory: path.join(path.dirname(testAssembly.kitSources[0].directory), 'notifications'),
      source: 'development',
    }];
    callerAssembly.defaultKit = '@itharbors/kit-notifications';

    const port = await server.start(0);
    const [catalogResponse, bootstrapResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/kits`),
      fetch(`http://127.0.0.1:${port}/api/application/bootstrap`),
    ]);
    const catalog = await catalogResponse.json();
    const bootstrap = await bootstrapResponse.json();
    await server.stop();

    expect(catalog.kits.map((kit: { name: string }) => kit.name)).toEqual([
      '@itharbors/kit-default',
    ]);
    expect(bootstrap.plugins).toEqual([]);
    expect(bootstrap.diagnostics).toEqual([]);
  });

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
    const server = createServer({ assembly: testAssembly, applicationRuntime });
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
      assembly: testAssembly,
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
      assembly: testAssembly,
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
      assembly: testAssembly,
      applicationRuntime: new ApplicationRuntime({ plugins: [], hostMode: 'desktop' }),
    });
    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/sse/application`);

    await expect(server.stop()).resolves.toBeUndefined();
    const body = await response.text();

    expect(body).toContain('"phase":"ready"');
    expect(body).toContain('"phase":"stopped"');
  });

  it('cannot begin listening after shutdown starts during application startup', async () => {
    let releaseStart: (() => void) | undefined;
    const applicationRuntime = {
      start: vi.fn(() => new Promise<any>((resolve) => {
        releaseStart = () => resolve({
          phase: 'ready',
          plugins: [],
          diagnostics: [],
          menu: { tree: [], warnings: [] },
        });
      })),
      getBootstrap: vi.fn(() => ({
        phase: 'ready' as const,
        plugins: [],
        diagnostics: [],
        menu: { tree: [], warnings: [] },
      })),
      triggerMenu: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const server = createServer({ assembly: testAssembly, applicationRuntime });

    const starting = server.start(0);
    const stopping = server.stop();
    releaseStart?.();

    await expect(starting).rejects.toThrow(/stopping/i);
    await expect(stopping).resolves.toBeUndefined();
    expect(server.server.listening).toBe(false);
    expect(applicationRuntime.dispose).toHaveBeenCalledOnce();
  });
});
