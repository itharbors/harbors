import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkspaceStore } from './workspace-store.mjs';

const sqlite = { name: '@itharbors/kit-sqlite' };
const mysql = { name: '@itharbors/kit-mysql' };

test('reuses a stable session id for each Kit across store instances', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'itharbors-workspaces-'));
  const filePath = path.join(directory, 'workspaces.json');
  const first = new WorkspaceStore(filePath, {
    randomUUID: () => 'first-session',
    now: () => 100,
  });

  const created = await first.getOrCreate(sqlite);
  const reused = await first.getOrCreate(sqlite);
  const restored = await new WorkspaceStore(filePath).getOrCreate(sqlite);

  assert.equal(created.sessionId, 'first-session');
  assert.equal(reused.sessionId, created.sessionId);
  assert.equal(restored.sessionId, created.sessionId);
});

test('atomically persists normalized BrowserWindow bounds', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'itharbors-workspaces-'));
  const filePath = path.join(directory, 'workspaces.json');
  const store = new WorkspaceStore(filePath, { randomUUID: () => 'sqlite-session' });
  await store.getOrCreate(sqlite);

  const updated = await store.updateBounds(sqlite.name, {
    x: 10.8,
    y: 20.2,
    width: 1440.9,
    height: 960.1,
  });

  assert.deepEqual(updated.bounds, { x: 11, y: 20, width: 1441, height: 960 });
  assert.deepEqual((await store.list())[0].bounds, updated.bounds);
  assert.deepEqual(await readdir(directory), ['workspaces.json']);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).workspaces[0].sessionId, 'sqlite-session');
});

test('recovers from corrupt state as an empty workspace list', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'itharbors-workspaces-'));
  const filePath = path.join(directory, 'workspaces.json');
  await writeFile(filePath, '{broken');
  const store = new WorkspaceStore(filePath, { randomUUID: () => 'recovered-session' });

  assert.deepEqual(await store.list(), []);
  assert.equal((await store.getOrCreate(sqlite)).sessionId, 'recovered-session');
});

test('retains missing Kit workspaces and marks catalog availability at read time', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'itharbors-workspaces-'));
  const filePath = path.join(directory, 'workspaces.json');
  let sequence = 0;
  const store = new WorkspaceStore(filePath, { randomUUID: () => `session-${sequence += 1}` });
  await store.getOrCreate(sqlite);
  await store.getOrCreate(mysql);

  const records = await store.list([sqlite]);

  assert.deepEqual(records.map(({ kitName, available }) => ({ kitName, available })), [
    { kitName: mysql.name, available: false },
    { kitName: sqlite.name, available: true },
  ]);
});

test('rejects invalid bounds and unknown Kit updates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'itharbors-workspaces-'));
  const store = new WorkspaceStore(path.join(directory, 'workspaces.json'));

  await assert.rejects(store.updateBounds(sqlite.name, { width: 0, height: 10 }), /invalid bounds/i);
  await assert.rejects(store.updateBounds(sqlite.name, { width: 10, height: 10 }), /workspace.*not found/i);
});
