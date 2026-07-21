import { describe, expect, it, vi } from 'vitest';
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
});
