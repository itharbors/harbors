import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSchedulerStore } from '../main/src/store';
import type { SchedulerState } from '../main/src/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })),
  ));
});

describe('scheduler state store', () => {
  it('returns an empty versioned state when the file does not exist', async () => {
    const { store } = await createStore();

    await expect(store.load()).resolves.toEqual({
      schemaVersion: 1,
      jobs: [],
      runs: [],
    });
  });

  it('atomically persists and reloads valid state', async () => {
    const { filePath, store } = await createStore();
    const state: SchedulerState = {
      schemaVersion: 1,
      jobs: [{
        id: 'job-1',
        name: 'Report',
        scriptPath: '/tmp/report.mjs',
        schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' },
        misfirePolicy: 'run-once',
        enabled: true,
        nextRunAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      }],
      runs: [],
    };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(state);
  });

  it.each([
    ['malformed JSON', '{bad json', /parse|json/i],
    ['unknown schema', '{"schemaVersion":2,"jobs":[],"runs":[]}', /schema/i],
    ['invalid jobs', '{"schemaVersion":1,"jobs":[{"id":1}],"runs":[]}', /state/i],
    [
      'out-of-range interval',
      JSON.stringify({
        schemaVersion: 1,
        jobs: [{
          id: 'job-1',
          name: 'Report',
          scriptPath: '/tmp/report.mjs',
          schedule: {
            kind: 'interval',
            startAt: '2026-08-01T00:00:00.000Z',
            everyMs: 0,
          },
          misfirePolicy: 'run-once',
          enabled: true,
          nextRunAt: '2026-08-01T00:00:00.000Z',
          createdAt: '2026-07-31T00:00:00.000Z',
          updatedAt: '2026-07-31T00:00:00.000Z',
        }],
        runs: [],
      }),
      /state/i,
    ],
    ['unexpected fields', '{"schemaVersion":1,"jobs":[],"runs":[],"extra":true}', /state/i],
  ])('preserves and rejects %s', async (_label, content, error) => {
    const { filePath, store } = await createStore();
    await writeFile(filePath, content);

    await expect(store.load()).rejects.toThrow(error);
    expect(await readFile(filePath, 'utf8')).toBe(content);
  });
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-scheduler-store-'));
  roots.push(root);
  const filePath = path.join(root, 'nested', 'state.v1.json');
  await mkdir(path.dirname(filePath), { recursive: true });
  return { filePath, store: createSchedulerStore(filePath) };
}
