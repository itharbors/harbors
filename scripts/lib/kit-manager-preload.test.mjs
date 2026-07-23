import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const preloadUrl = new URL('../kit-manager-preload.cjs', import.meta.url);

test('exposes exactly five fixed invoke-only methods', async () => {
  const source = await readFile(preloadUrl, 'utf8');
  const calls = [];
  let exposed;
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      return { ok: true, value: { channel } };
    },
  };
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } },
        ipcRenderer,
      };
    },
    Error,
  });

  assert.equal(exposed.name, 'harborsKitManager');
  assert.deepEqual(Object.keys(exposed.value).sort(), ['activate', 'install', 'list', 'refresh', 'rollback']);
  await exposed.value.list();
  await exposed.value.refresh();
  await exposed.value.install({ id: '@example/demo', version: '1.2.3', channel: 'stable' });
  await exposed.value.activate({ id: '@example/demo', version: '1.2.3' });
  await exposed.value.rollback('@example/demo');
  assert.deepEqual(calls.map(([channel]) => channel), [
    'harbors:kit-manager:list',
    'harbors:kit-manager:refresh',
    'harbors:kit-manager:install',
    'harbors:kit-manager:activate',
    'harbors:kit-manager:rollback',
  ]);
  assert.doesNotMatch(source, /ipcRenderer\.send|ipcRenderer\.on|shell|execute|path/i);
});

test('turns sanitized failure envelopes into renderer errors', async () => {
  const source = await readFile(preloadUrl, 'utf8');
  let api;
  vm.runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: {
        invoke: async () => ({
          ok: false, error: { code: 'DIGEST_MISMATCH', message: 'Artifact digest mismatch' },
        }),
      },
    }),
    Error,
  });
  await assert.rejects(
    api.install({ id: '@example/demo', version: '1.2.3', channel: 'stable' }),
    (error) => error.code === 'DIGEST_MISMATCH' && error.message === 'Artifact digest mismatch',
  );
});
