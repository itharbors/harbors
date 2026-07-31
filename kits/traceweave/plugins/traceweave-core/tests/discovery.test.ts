import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverCodexRuns } from '../main/src/codex-discovery';
import { createTestCodexHome, type TestCodexHome } from './helpers/codex-home';

let home: TestCodexHome | undefined;
afterEach(async () => { await home?.cleanup(); home = undefined; });

describe('discoverCodexRuns', () => {
  it('merges indexed active and scanned archived runs in update order', async () => {
    home = await createTestCodexHome();
    const runs = await discoverCodexRuns(home.root);
    expect(runs.map(run => ({ title: run.title, archived: run.archived }))).toEqual([
      { title: 'Model builder workflow', archived: false },
      { title: 'Codex session session-a', archived: true },
    ]);
  });

  it('keeps empty rollouts as failed and ignores symlinked session trees', async () => {
    home = await createTestCodexHome();
    const directory = path.join(home.root, 'sessions', 'empty');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'rollout-empty-session-empty.jsonl'), '');
    await symlink(path.dirname(home.archivedPath), path.join(home.root, 'sessions', 'archive-link'));
    const runs = await discoverCodexRuns(home.root);
    expect(runs.filter(run => run.sessionId === 'session-archived')).toHaveLength(1);
    expect(runs.find(run => run.sessionId === 'session-empty')).toMatchObject({ status: 'failed', warningCount: 1 });
  });
});
