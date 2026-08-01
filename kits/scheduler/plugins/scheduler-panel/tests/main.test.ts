import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Scheduler panel main', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('forwards panel requests through the server-side application bridge', async () => {
    let definition: any;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: unknown) { definition = value; } },
    };
    await import('../main/src/index');
    const application = { request: vi.fn(async () => ({ status: 'ok' })) };
    definition.lifecycle.load({ application });

    await expect(definition.methods.scheduler('getSnapshot')).resolves.toEqual({ status: 'ok' });
    await definition.methods.scheduler('saveJob', { name: '日报' });

    expect(application.request.mock.calls).toEqual([
      ['@itharbors/scheduler-service', 'getSnapshot'],
      ['@itharbors/scheduler-service', 'saveJob', { name: '日报' }],
    ]);
  });
});
