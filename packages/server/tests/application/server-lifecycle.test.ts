import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { ApplicationRuntime } from '../../src/application/runtime';
import { createServer as createServerWithOptions } from '../../src/server';
import { testAssembly } from '../helpers/assembly';
import { createKitFixture } from '../../src/framework/__tests__/kit-fixture';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

const createServer = (
  options: Omit<Parameters<typeof createServerWithOptions>[0], 'pluginPathRoots'>,
) => createServerWithOptions({ ...options, pluginPathRoots: createTestPluginPathRoots() });

describe('application server lifecycle', () => {
  it('requires one complete set of absolute generic plugin storage roots', () => {
    expect(() => createServerWithOptions({
      assembly: testAssembly,
    } as Parameters<typeof createServerWithOptions>[0])).toThrow(/pluginPathRoots.*required/iu);
    expect(() => createServerWithOptions({
      assembly: testAssembly,
      pluginPathRoots: {
        applicationData: '/tmp/harbors',
        data: '/tmp/harbors/plugins/data',
        cache: 'relative/cache',
        temp: '/tmp/harbors/plugins/temp',
      },
    })).toThrow(/pluginPathRoots\.cache.*absolute/iu);
  });

  it('keeps application plugins and sessions on one snapshot after caller assembly mutation', async () => {
    const callerAssembly = {
      ...testAssembly,
      kitSources: testAssembly.kitSources.map((source) => ({ ...source })),
    };
    const server = createServer({ assembly: callerAssembly });
    const replacement = createKitFixture({ name: '@example/kit-replacement', label: 'Replacement' });
    callerAssembly.kitSources = [{
      directory: replacement.directory,
      source: 'development',
    }];
    callerAssembly.defaultKit = replacement.name;

    try {
      const port = await server.start(0);
      const [catalogResponse, bootstrapResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/kits`),
        fetch(`http://127.0.0.1:${port}/api/application/bootstrap`),
      ]);
      const catalog = await catalogResponse.json();
      const bootstrap = await bootstrapResponse.json();
      await server.stop();

      expect(catalog.kits.map((kit: { name: string }) => kit.name)).toEqual([
        '@example/kit-alpha',
      ]);
      expect(bootstrap.plugins).toEqual([]);
      expect(bootstrap.diagnostics).toEqual([]);
    } finally {
      await replacement.dispose();
    }
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
      request: vi.fn(),
      retryPlugin: vi.fn(),
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

  it('recovers credentials before application startup and closes them after Sessions and Application', async () => {
    const events: string[] = [];
    let releaseRecovery: (() => void) | undefined;
    const credentialVault = {
      recover: vi.fn(() => new Promise<void>((resolve) => {
        events.push('credentials:recover');
        releaseRecovery = resolve;
      })),
      capability: vi.fn(() => ({ mode: 'local' as const, status: 'available' as const })),
      bind: vi.fn(),
      close: vi.fn(async () => { events.push('credentials:close'); }),
    };
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
      request: vi.fn(),
      retryPlugin: vi.fn(),
      triggerMenu: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => { events.push('application:dispose'); }),
    };
    const server = createServer({
      assembly: testAssembly,
      applicationHostMode: 'desktop',
      host: '127.0.0.1',
      credentialVault,
      applicationRuntime,
    });
    vi.spyOn(server.registry, 'disposeAll').mockImplementation(async () => {
      events.push('sessions:dispose');
    });

    const starting = server.start(0);
    await vi.waitFor(() => expect(credentialVault.recover).toHaveBeenCalledOnce());
    expect(server.server.listening).toBe(false);
    expect(applicationRuntime.start).not.toHaveBeenCalled();
    releaseRecovery?.();
    await starting;
    await server.stop();

    expect(events).toEqual([
      'credentials:recover',
      'application:start',
      'sessions:dispose',
      'application:dispose',
      'credentials:close',
    ]);
  });

  it('closes the Session runtime creation gate synchronously when stop begins', async () => {
    const server = createServer({
      assembly: testAssembly,
      applicationRuntime: new ApplicationRuntime({
        plugins: [], hostMode: 'web', pluginPathRoots: createTestPluginPathRoots(),
      }),
    });
    await server.start(0);

    const stopping = server.stop();
    const lateRuntime = server.registry.getOrCreate('late-after-stop', {});

    await expect(lateRuntime).rejects.toMatchObject({
      code: 'SESSION_RUNTIME_REGISTRY_CLOSED',
    });
    await expect(stopping).resolves.toBeUndefined();
    expect(server.registry.editors.size).toBe(0);
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
        request: vi.fn(),
        retryPlugin: vi.fn(),
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

  it('rejects startup before listening when Kit catalog discovery fails', async () => {
    const invalidKit = createKitFixture({ name: '@example/invalid-kit' });
    await invalidKit.dispose();
    const server = createServer({
      assembly: {
        ...testAssembly,
        defaultKit: invalidKit.name,
        kitSources: [{ directory: invalidKit.directory, source: 'builtin' }],
      },
      applicationRuntime: new ApplicationRuntime({
        plugins: [], hostMode: 'web', pluginPathRoots: createTestPluginPathRoots(),
      }),
    });

    try {
      await expect(server.start(0)).rejects.toThrow(`Kit "${invalidKit.name}" not found`);
      expect(server.server.listening).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('binds the desktop web Host to every IPv4 interface and protects application mutations', async () => {
    const credentialVault = {
      recover: vi.fn(async () => undefined),
      capability: vi.fn(() => ({ mode: 'local' as const, status: 'available' as const })),
      bind: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const server = createServer({
      assembly: testAssembly,
      applicationHostMode: 'desktop',
      host: '0.0.0.0',
      credentialVault,
      applicationControlToken: 'launch-secret',
      applicationRuntime: new ApplicationRuntime({
        plugins: [], hostMode: 'desktop', pluginPathRoots: createTestPluginPathRoots(),
      }),
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
    const retry = await fetch(`http://127.0.0.1:${port}/api/application/plugin/retry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-harbors-application-token': 'launch-secret',
      },
      body: JSON.stringify({ plugin: '@scope/missing' }),
    });
    const retryBody = await retry.json();
    await Promise.all([server.stop(), server.stop()]);

    expect(address.address).toBe('0.0.0.0');
    expect(server.credentialMode).toBe('local');
    expect(credentialVault.recover).toHaveBeenCalledOnce();
    expect(credentialVault.close).toHaveBeenCalledOnce();
    expect(unauthorized.status).toBe(403);
    expect(authorized.status).toBe(404);
    expect(retry.status).toBe(404);
    expect(retryBody).toMatchObject({ error: { code: 'APPLICATION_PLUGIN_NOT_FOUND' } });
  });

  it('rejects local credentials before listening when the bind is not explicit loopback', () => {
    expect(() => createServer({
      assembly: testAssembly,
      applicationHostMode: 'web',
      credentialMode: 'local',
    })).toThrow(/loopback/i);
  });

  it('resolves and exposes one immutable local credential mode for desktop startup', async () => {
    const server = createServer({
      assembly: testAssembly,
      applicationHostMode: 'desktop',
      host: '::1',
    });

    expect(server.credentialMode).toBe('local');
    expect(() => {
      (server as unknown as { credentialMode: string }).credentialMode = 'off';
    }).toThrow(TypeError);
    await server.stop();
  });

  it('finishes graceful shutdown while an application event stream is connected', async () => {
    const server = createServer({
      assembly: testAssembly,
      applicationRuntime: new ApplicationRuntime({
        plugins: [], hostMode: 'desktop', pluginPathRoots: createTestPluginPathRoots(),
      }),
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
      request: vi.fn(),
      retryPlugin: vi.fn(),
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
