import { appendFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { TraceweaveService } from '../main/src/service';
import { createTestCodexHome, type TestCodexHome } from './helpers/codex-home';

let home: TestCodexHome | undefined;
afterEach(async () => { await home?.cleanup(); home = undefined; });

describe('TraceweaveService', () => {
  it('uses opaque ids, hides paths and leaves source files unchanged', async () => {
    home = await createTestCodexHome();
    const before = await stat(home.activePath);
    const service = new TraceweaveService(home.root);
    const runs = await service.listRuns();
    const trace = await service.loadRun({ runId: runs[0].id });
    const after = await stat(home.activePath);
    expect(runs[0].id).not.toContain('session-test');
    expect(JSON.stringify({ runs, trace })).not.toContain(home.root);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
  });

  it('redacts raw evidence, rejects path-shaped ids and invalidates changed source cache', async () => {
    home = await createTestCodexHome();
    const service = new TraceweaveService(home.root);
    const [run] = await service.listRuns();
    const first = await service.loadRun({ runId: run.id });
    const edit = first.turns[1].nodes.find(node => node.label === 'image_edit')!;
    const raw = await service.loadRawEvidence({ runId: run.id, eventId: edit.evidence.sourceEventIds[0] });
    expect(JSON.stringify(raw)).toContain('[REDACTED]');
    expect(JSON.stringify(raw)).not.toContain('must-not-leak');
    await expect(service.loadRun({ runId: '../../etc/passwd' })).rejects.toThrow('RUN_NOT_FOUND');
    await appendFile(home.activePath, '\n');
    const second = await service.loadRun({ runId: run.id });
    expect(second).not.toBe(first);
  });
});
