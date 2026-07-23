import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KIT_MANAGER_CHANNELS,
  registerKitManagerIpc,
} from './kit-manager-ipc.mjs';

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

function event(senderId = 7) {
  return { sender: { id: senderId } };
}

test('registers only the five fixed Kit Manager operations and validates their inputs', async () => {
  const calls = [];
  const service = {
    list: async () => { calls.push(['list']); return { kits: [] }; },
    refresh: async () => { calls.push(['refresh']); return { kits: [] }; },
    install: async (value) => { calls.push(['install', value]); return value; },
    activate: async (value) => { calls.push(['activate', value]); return value; },
    rollback: async (value) => { calls.push(['rollback', value]); return value; },
  };
  const ipcMain = createIpcMain();
  registerKitManagerIpc({
    ipcMain,
    getManagerWindow: () => ({ isDestroyed: () => false, webContents: { id: 7 } }),
    service,
  });
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), Object.values(KIT_MANAGER_CHANNELS).sort());

  assert.deepEqual(await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.list)(event()), {
    ok: true, value: { kits: [] },
  });
  await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.refresh)(event());
  await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.install)(event(), {
    id: '@example/demo', version: '1.2.3', channel: 'stable',
  });
  await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.activate)(event(), {
    id: '@example/demo', version: '1.2.3', retryBad: true,
  });
  await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.rollback)(event(), '@example/demo');
  assert.deepEqual(calls, [
    ['list'], ['refresh'],
    ['install', { id: '@example/demo', version: '1.2.3', channel: 'stable' }],
    ['activate', { id: '@example/demo', version: '1.2.3', retryBad: true }],
    ['rollback', '@example/demo'],
  ]);

  for (const [channel, args] of [
    [KIT_MANAGER_CHANNELS.list, ['unexpected']],
    [KIT_MANAGER_CHANNELS.refresh, [{}]],
    [KIT_MANAGER_CHANNELS.install, [{ id: '@example/demo', version: '1.2.3', channel: 'stable', url: 'https://evil.test' }]],
    [KIT_MANAGER_CHANNELS.activate, [{ id: '@example/demo', version: '1.2.3', retryBad: 'yes' }]],
    [KIT_MANAGER_CHANNELS.rollback, ['/tmp/demo']],
  ]) {
    assert.deepEqual(await ipcMain.handlers.get(channel)(event(), ...args), {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid Kit Manager request' },
    });
  }
});

test('binds every call to the current Manager webContents sender', async () => {
  const ipcMain = createIpcMain();
  let window = { isDestroyed: () => false, webContents: { id: 7 } };
  registerKitManagerIpc({
    ipcMain,
    getManagerWindow: () => window,
    service: { list: async () => ({}) },
  });
  const invoke = ipcMain.handlers.get(KIT_MANAGER_CHANNELS.list);
  for (const senderId of [6, 8]) {
    assert.deepEqual(await invoke(event(senderId)), {
      ok: false, error: { code: 'FORBIDDEN', message: 'Kit Manager request was rejected' },
    });
  }
  window = { isDestroyed: () => true, webContents: { id: 7 } };
  assert.equal((await invoke(event(7))).error.code, 'FORBIDDEN');
  window = null;
  assert.equal((await invoke(event(7))).error.code, 'FORBIDDEN');
});

test('serializes only stable errors and replaces prior registrations safely', async () => {
  const ipcMain = createIpcMain();
  const registration1 = registerKitManagerIpc({
    ipcMain,
    getManagerWindow: () => ({ isDestroyed: () => false, webContents: { id: 7 } }),
    service: { list: async () => { throw Object.assign(new Error('Digest mismatch'), { code: 'DIGEST_MISMATCH' }); } },
  });
  assert.deepEqual(await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.list)(event()), {
    ok: false, error: { code: 'DIGEST_MISMATCH', message: 'Digest mismatch' },
  });
  const registration2 = registerKitManagerIpc({
    ipcMain,
    getManagerWindow: () => ({ isDestroyed: () => false, webContents: { id: 7 } }),
    service: { list: async () => { throw new Error('/private/path and remote body'); } },
  });
  registration1.unregister();
  assert.deepEqual(await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.list)(event()), {
    ok: false, error: { code: 'OPERATION_FAILED', message: 'Kit Manager operation failed' },
  });
  registration2.unregister();
  assert.equal(ipcMain.handlers.size, 0);
});

test('drains in-flight operations after handlers are unregistered', async () => {
  const ipcMain = createIpcMain();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const registration = registerKitManagerIpc({
    ipcMain,
    getManagerWindow: () => ({ isDestroyed: () => false, webContents: { id: 7 } }),
    service: { list: async () => pending },
  });
  const invocation = ipcMain.handlers.get(KIT_MANAGER_CHANNELS.list)(event());
  registration.unregister();
  assert.equal(ipcMain.handlers.size, 0);
  let drained = false;
  const draining = registration.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish({ kits: [] });
  await Promise.all([invocation, draining]);
  assert.equal(drained, true);
});
