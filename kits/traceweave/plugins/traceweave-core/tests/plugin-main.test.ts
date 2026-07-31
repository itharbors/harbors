import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestCodexHome, type TestCodexHome } from './helpers/codex-home';

type Definition = {
  lifecycle: { load(runtime: Runtime): void; unload(): void };
  methods: Record<string, (input?: unknown) => unknown>;
};
type Runtime = { window: { openPanel(name: string): unknown } };

let home: TestCodexHome | undefined;
let definition: Definition | undefined;

afterEach(async () => {
  definition?.lifecycle.unload();
  definition = undefined;
  await home?.cleanup();
  home = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
});

describe('traceweave-core plugin bridge', () => {
  it('keeps manifest routes aligned and returns immutable public snapshots', async () => {
    const loaded = await loadDefinition();
    const manifest = await import('../package.json', { with: { type: 'json' } });
    expect(Object.keys(loaded.methods).sort()).toEqual([
      'listRuns', 'loadRawEvidence', 'loadRun', 'openTracePanel', 'refresh',
    ]);
    expect(Object.keys(manifest.default['ce-editor'].contribute.message.request).sort())
      .toEqual(Object.keys(loaded.methods).sort());
    const runs = await loaded.methods.listRuns() as unknown[];
    expect(runs).toHaveLength(2);
    expect(Object.isFrozen(runs)).toBe(true);
    expect(Object.isFrozen(runs[0])).toBe(true);
  });

  it('validates inputs, returns fixed public errors and opens the trace Panel', async () => {
    const openPanel = vi.fn();
    const loaded = await loadDefinition({ window: { openPanel } });
    expect(await loaded.methods.loadRun({ runId: '' })).toEqual({
      $traceweaveError: { code: 'INVALID_REQUEST', message: 'A valid run id is required' },
    });
    expect(await loaded.methods.loadRun({ runId: 'missing' })).toEqual({
      $traceweaveError: { code: 'RUN_NOT_FOUND', message: 'Run not found' },
    });
    expect(loaded.methods.openTracePanel()).toBeUndefined();
    expect(openPanel).toHaveBeenCalledWith('@itharbors/traceweave-view.trace');
  });

  it('disposes once and rejects requests after unload', async () => {
    const loaded = await loadDefinition();
    loaded.lifecycle.unload();
    loaded.lifecycle.unload();
    expect(await loaded.methods.listRuns()).toEqual({
      $traceweaveError: { code: 'READ_FAILED', message: 'TraceWeave is not available' },
    });
  });
});

async function loadDefinition(runtime: Runtime = { window: { openPanel() {} } }): Promise<Definition> {
  home = await createTestCodexHome();
  vi.stubEnv('CODEX_HOME', home.root);
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: Definition) { definition = value; } },
  };
  await import('../main/src/index.js');
  definition!.lifecycle.load(runtime);
  return definition!;
}
