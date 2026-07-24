import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_UPDATE_CHANNELS,
  registerAppUpdaterIpc,
} from './app-updater-ipc.mjs';

class FakeIpcMain {
  handlers = new Map();

  handle(channel, handler) {
    assert.equal(this.handlers.has(channel), false);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, event, ...args) {
    return this.handlers.get(channel)(event, ...args);
  }
}

function fixture() {
  const ipcMain = new FakeIpcMain();
  const sender = { id: 20, isDestroyed: () => false, send() {} };
  const window = { id: 10, webContents: sender, isDestroyed: () => false };
  const rogueSender = { id: 21, isDestroyed: () => false };
  let subscriber;
  let unsubscribeCalls = 0;
  const calls = [];
  let snapshot = {
    status: 'idle',
    currentVersion: '1.0.0',
    availableVersion: null,
    progress: null,
    error: null,
    privateValue: 'must not cross IPC',
  };
  const controller = {
    getSnapshot: () => snapshot,
    check: async () => { calls.push('check'); return snapshot; },
    download: async () => { calls.push('download'); return snapshot; },
    install: async () => { calls.push('install'); return snapshot; },
    subscribe(listener) {
      subscriber = listener;
      return () => { unsubscribeCalls += 1; };
    },
  };
  const BrowserWindow = {
    fromWebContents: (contents) => (contents === sender || contents === rogueSender ? window : null),
  };
  const windows = [window];
  const registration = registerAppUpdaterIpc({
    ipcMain,
    BrowserWindow,
    controller,
    getApplicationWindows: () => windows,
  });
  return {
    ipcMain,
    sender,
    rogueSender,
    window,
    windows,
    calls,
    registration,
    get unsubscribeCalls() { return unsubscribeCalls; },
    emit(next) { snapshot = next; subscriber(next); },
  };
}

test('registers zero-argument update commands for a live application window', async () => {
  const setup = fixture();
  assert.deepEqual([...setup.ipcMain.handlers.keys()].sort(), [
    APP_UPDATE_CHANNELS.check,
    APP_UPDATE_CHANNELS.download,
    APP_UPDATE_CHANNELS.getState,
    APP_UPDATE_CHANNELS.install,
  ].sort());

  const state = await setup.ipcMain.invoke(APP_UPDATE_CHANNELS.getState, { sender: setup.sender });
  assert.deepEqual(state, {
    status: 'idle',
    currentVersion: '1.0.0',
    availableVersion: null,
    progress: null,
    error: null,
  });
  assert.equal(Object.isFrozen(state), true);

  await setup.ipcMain.invoke(APP_UPDATE_CHANNELS.check, { sender: setup.sender });
  await setup.ipcMain.invoke(APP_UPDATE_CHANNELS.download, { sender: setup.sender });
  await setup.ipcMain.invoke(APP_UPDATE_CHANNELS.install, { sender: setup.sender });
  assert.deepEqual(setup.calls, ['check', 'download', 'install']);
});

test('rejects arguments and senders outside live application windows', async () => {
  const setup = fixture();
  for (const channel of Object.values(APP_UPDATE_CHANNELS).filter((value) => value !== APP_UPDATE_CHANNELS.state)) {
    await assert.rejects(
      setup.ipcMain.invoke(channel, { sender: setup.sender }, 'unexpected'),
      /does not accept arguments/iu,
    );
  }

  setup.windows.length = 0;
  await assert.rejects(
    setup.ipcMain.invoke(APP_UPDATE_CHANNELS.getState, { sender: setup.rogueSender }),
    /live application window/iu,
  );
  setup.windows.push(setup.window);
  setup.window.isDestroyed = () => true;
  await assert.rejects(
    setup.ipcMain.invoke(APP_UPDATE_CHANNELS.check, { sender: setup.sender }),
    /live application window/iu,
  );
});

test('broadcasts immutable public snapshots and unregisters every handler', () => {
  const setup = fixture();
  const sent = [];
  setup.sender.send = (channel, state) => sent.push({ channel, state });
  setup.emit({
    status: 'error',
    currentVersion: '1.0.0',
    availableVersion: null,
    progress: null,
    error: { code: 'UPDATE_FAILED', message: 'Unable to update ITHARBORS' },
    privateValue: 'secret',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, APP_UPDATE_CHANNELS.state);
  assert.deepEqual(sent[0].state, {
    status: 'error',
    currentVersion: '1.0.0',
    availableVersion: null,
    progress: null,
    error: { code: 'UPDATE_FAILED', message: 'Unable to update ITHARBORS' },
  });
  assert.equal(Object.isFrozen(sent[0].state), true);
  assert.equal(Object.isFrozen(sent[0].state.error), true);

  setup.registration.unregister();
  setup.registration.unregister();
  assert.equal(setup.ipcMain.handlers.size, 0);
  assert.equal(setup.unsubscribeCalls, 1);
});
