import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Agent Guard center main', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('forwards session methods only through the server-side application bridge', async () => {
    let definition: any;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: unknown) { definition = value; } },
    };
    await import('../main/src/index');
    const application = { request: vi.fn(async () => ({ status: 'ok' })) };
    const openPanel = vi.fn();
    definition.lifecycle.load({ application, window: { openPanel } });

    await definition.methods.getSnapshot();
    await definition.methods.updatePolicy({ schemaVersion: 1 });
    await definition.methods.executeCommand({ type: 'resume', incidentId: 'i-1' });
    await definition.methods.getIncidents({ limit: 20 });
    definition.methods.openGuardPanel();

    expect(application.request.mock.calls).toEqual([
      ['@itharbors/agent-guard-background', 'getSnapshot'],
      ['@itharbors/agent-guard-background', 'updatePolicy', { schemaVersion: 1 }],
      ['@itharbors/agent-guard-background', 'executeCommand', { type: 'resume', incidentId: 'i-1' }],
      ['@itharbors/agent-guard-background', 'getIncidents', { limit: 20 }],
    ]);
    expect(openPanel).toHaveBeenCalledWith('@itharbors/agent-guard-center.guard');
  });
});
