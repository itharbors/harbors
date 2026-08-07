import { readFileSync } from 'node:fs';
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
    await definition.methods.getTrafficHistory({ from: 1, to: 2, domain: 'network' });
    await definition.methods.getHistoryStatus();
    await definition.methods.updateHistorySettings({ localSessionBackfill: false });
    await definition.methods.runHistoryBackfill({ reason: 'manual' });
    await definition.methods.clearHistory({ confirmation: 'clear-history' });
    definition.methods.openGuardPanel();
    expect(definition.methods.openInBrowser()).toEqual({ type: 'open-current-url' });

    expect(application.request.mock.calls).toEqual([
      ['@itharbors/agent-guard-background', 'getSnapshot'],
      ['@itharbors/agent-guard-background', 'updatePolicy', { schemaVersion: 1 }],
      ['@itharbors/agent-guard-background', 'executeCommand', { type: 'resume', incidentId: 'i-1' }],
      ['@itharbors/agent-guard-background', 'getIncidents', { limit: 20 }],
      ['@itharbors/agent-guard-background', 'getTrafficHistory', { from: 1, to: 2, domain: 'network' }],
      ['@itharbors/agent-guard-background', 'getHistoryStatus'],
      ['@itharbors/agent-guard-background', 'updateHistorySettings', { localSessionBackfill: false }],
      ['@itharbors/agent-guard-background', 'runHistoryBackfill', { reason: 'manual' }],
      ['@itharbors/agent-guard-background', 'clearHistory', { confirmation: 'clear-history' }],
    ]);
    expect(openPanel).toHaveBeenCalledWith('@itharbors/agent-guard-center.guard');
  });

  it('contributes a menu action that opens the current Agent Guard page in a browser', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      'ce-editor': { contribute: {
        menu: Array<Record<string, unknown>>;
        message: { request: Record<string, string[]> };
      } };
    };

    expect(manifest['ce-editor'].contribute.menu).toContainEqual({
      type: 'menu',
      id: 'file/open-current-page-in-browser',
      message: 'openInBrowser',
      order: 910,
      label: '在浏览器中打开',
    });
    expect(manifest['ce-editor'].contribute.message.request.openInBrowser)
      .toEqual(['openInBrowser']);
  });
});
