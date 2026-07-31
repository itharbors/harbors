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

  it('excludes exec and sub-agent rollouts from the top-level session list', async () => {
    home = await createTestCodexHome();
    const directory = path.join(home.root, 'sessions', 'internal');
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, 'rollout-exec.jsonl'), `${JSON.stringify({
        timestamp: '2026-07-31T00:03:00.000Z',
        type: 'session_meta',
        payload: { id: 'session-exec', source: 'exec' },
      })}\n`),
      writeFile(path.join(directory, 'rollout-subagent.jsonl'), `${JSON.stringify({
        timestamp: '2026-07-31T00:04:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-child',
          session_id: 'session-test',
          source: { subagent: { thread_spawn: { parent_thread_id: 'session-test', depth: 1 } } },
        },
      })}\n`),
    ]);

    const runs = await discoverCodexRuns(home.root);

    expect(runs.map(run => run.sessionId)).toEqual(['session-test', 'session-archived']);
  });

  it('prefers the rollout id over a parent session id', async () => {
    home = await createTestCodexHome();
    const directory = path.join(home.root, 'sessions', 'current');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'rollout-current.jsonl'), `${JSON.stringify({
      timestamp: '2026-07-31T00:04:00.000Z',
      type: 'session_meta',
      payload: { id: 'session-current', session_id: 'session-parent', source: 'vscode' },
    })}\n`);

    const runs = await discoverCodexRuns(home.root);

    expect(runs.find(run => run.rolloutPath.endsWith('rollout-current.jsonl'))?.sessionId)
      .toBe('session-current');
  });
});
