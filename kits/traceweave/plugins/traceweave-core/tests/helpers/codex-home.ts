import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../fixtures/two-turn.jsonl', import.meta.url));

export interface TestCodexHome {
  root: string;
  activePath: string;
  archivedPath: string;
  cleanup(): Promise<void>;
}

export async function createTestCodexHome(): Promise<TestCodexHome> {
  const root = await mkdtemp(path.join(tmpdir(), 'traceweave-codex-'));
  const activeDirectory = path.join(root, 'sessions', '2026', '07', '31');
  const archiveDirectory = path.join(root, 'archived_sessions');
  await mkdir(activeDirectory, { recursive: true });
  await mkdir(archiveDirectory, { recursive: true });
  const activePath = path.join(activeDirectory, 'rollout-2026-07-31-session-test.jsonl');
  const archivedPath = path.join(archiveDirectory, 'rollout-2026-07-30-session-archived.jsonl');
  await copyFile(fixture, activePath);
  await writeFile(
    archivedPath,
    (await readFile(fixture, 'utf8')).replaceAll('session-test', 'session-archived'),
  );
  await writeFile(path.join(root, 'session_index.jsonl'), `${JSON.stringify({
    id: 'session-test',
    thread_name: 'Model builder workflow',
    updated_at: '2026-07-31T00:02:00.000Z',
  })}\n`);
  await utimes(archivedPath, new Date('2026-07-30T00:02:00.000Z'), new Date('2026-07-30T00:02:00.000Z'));
  await utimes(activePath, new Date('2026-07-31T00:02:00.000Z'), new Date('2026-07-31T00:02:00.000Z'));
  return { root, activePath, archivedPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}
