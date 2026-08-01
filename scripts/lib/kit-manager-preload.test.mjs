import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const preloadUrl = new URL('../kit-manager-preload.cjs', import.meta.url);

test('exposes exactly seven fixed invoke-only methods', async () => {
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
  assert.deepEqual(Object.keys(exposed.value).sort(), [
    'activate', 'deactivate', 'install', 'list', 'refresh', 'rollback', 'uninstall',
  ]);
  await exposed.value.list();
  await exposed.value.refresh();
  await exposed.value.install({ id: '@example/demo', version: '1.2.3', channel: 'stable' });
  await exposed.value.activate({ id: '@example/demo', version: '1.2.3' });
  await exposed.value.rollback('@example/demo');
  await exposed.value.deactivate('@example/demo');
  await exposed.value.uninstall('@example/demo');
  assert.deepEqual(calls.map(([channel]) => channel), [
    'harbors:kit-manager:list',
    'harbors:kit-manager:refresh',
    'harbors:kit-manager:install',
    'harbors:kit-manager:activate',
    'harbors:kit-manager:rollback',
    'harbors:kit-manager:deactivate',
    'harbors:kit-manager:uninstall',
  ]);
  assert.deepEqual(calls.at(-1), ['harbors:kit-manager:uninstall', '@example/demo']);
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

test('copies validated technical causes and rejects malformed failure envelopes', async () => {
  const source = await readFile(preloadUrl, 'utf8');
  const responses = [
    {
      ok: false,
      error: {
        code: 'KIT_RUNTIME_APPLY_FAILED',
        message: 'Kit runtime validation failed',
        causes: ['activation failed', 'policy file was not found'],
      },
    },
    {
      ok: false,
      error: {
        code: 'bad-code',
        message: '<script>remote body</script>',
        causes: ['/private/secret'],
      },
    },
  ];
  let api;
  vm.runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async () => responses.shift() },
    }),
    Error,
    Object,
  });

  await assert.rejects(api.list(), (error) => {
    assert.equal(error.code, 'KIT_RUNTIME_APPLY_FAILED');
    assert.deepEqual([...error.causes], ['activation failed', 'policy file was not found']);
    assert.equal(Object.isFrozen(error.causes), true);
    return true;
  });
  await assert.rejects(api.list(), (error) => {
    assert.equal(error.code, 'OPERATION_FAILED');
    assert.equal(error.message, 'Kit Manager operation failed');
    assert.equal(error.causes, undefined);
    return true;
  });
});
