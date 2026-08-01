import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultAssemblyConfig, createEditor } from '@itharbors/server/testing';
import { createTestCodexHome, type TestCodexHome } from '../plugins/traceweave-core/tests/helpers/codex-home';
import { createPluginPathRoots } from './fixtures/create-plugin-path-roots';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const kitSources = [
  { directory: path.join(projectRoot, 'kits/traceweave'), source: 'development' as const },
];
let home: TestCodexHome | undefined;

afterEach(async () => { await home?.cleanup(); home = undefined; vi.unstubAllEnvs(); });

describe('TraceWeave Kit runtime integration', () => {
  it('loads through the real Editor and serves list, trace and evidence message requests', async () => {
    home = await createTestCodexHome();
    vi.stubEnv('CODEX_HOME', home.root);
    const editor = createEditor('traceweave-runtime', {
      assembly: createDefaultAssemblyConfig(projectRoot, {
        kitSources,
        defaultKit: '@itharbors/kit-traceweave',
      }),
      pluginPathRoots: createPluginPathRoots(home.root),
    });
    try {
      await editor.kit.load(path.join(projectRoot, 'kits/traceweave'));
      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining([
        '@itharbors/traceweave-core', '@itharbors/traceweave-view',
      ]));
      const runs = await editor.message.request('@itharbors/traceweave-core', 'listRuns') as Array<{ id: string }>;
      const trace = await editor.message.request('@itharbors/traceweave-core', 'loadRun', { runId: runs[0].id }) as any;
      const edit = trace.turns[1].nodes.find((node: any) => node.label === 'image_edit');
      const raw = await editor.message.request('@itharbors/traceweave-core', 'loadRawEvidence', {
        runId: runs[0].id,
        eventId: edit.evidence.sourceEventIds[0],
      });
      expect(trace).toMatchObject({ source: 'codex', turns: [{ index: 1 }, { index: 2 }] });
      expect(JSON.stringify(raw)).toContain('[REDACTED]');
    } finally {
      await editor.dispose();
    }
  });
});
