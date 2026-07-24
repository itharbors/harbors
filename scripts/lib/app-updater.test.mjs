import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createAppUpdater } from './app-updater.mjs';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = null;
  checkCalls = 0;
  downloadCalls = 0;
  checkResult = Promise.resolve();
  downloadResult = Promise.resolve();

  checkForUpdates() {
    this.checkCalls += 1;
    return this.checkResult;
  }

  downloadUpdate() {
    this.downloadCalls += 1;
    return this.downloadResult;
  }
}

function assertPublicError(error, code = 'UPDATE_ACTION_INVALID') {
  assert.equal(error?.code, code);
  assert.equal(
    error?.message,
    code === 'UPDATE_FAILED'
      ? 'Unable to update ITHARBORS'
      : 'This update action is not available',
  );
  assert.doesNotMatch(String(error?.message), /secret|private|token|certificate|https?:/iu);
  return true;
}

test('deduplicates checks with the same Promise and keeps Stable away from prereleases', () => {
  const updater = new FakeUpdater();
  updater.checkResult = new Promise(() => {});
  const controller = createAppUpdater({
    updater,
    currentVersion: '1.2.3',
    isPackaged: true,
    onInstall() {},
  });

  const initial = controller.getSnapshot();
  assert.deepEqual(initial, {
    status: 'idle',
    currentVersion: '1.2.3',
    availableVersion: null,
    progress: null,
    error: null,
  });
  assert.equal(Object.isFrozen(initial), true);

  const first = controller.check();
  const second = controller.check();
  assert.equal(first, second);
  assert.equal(updater.checkCalls, 1);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);

  updater.emit('update-available', { version: '1.2.4' });
  assert.deepEqual(controller.getSnapshot(), {
    status: 'available',
    currentVersion: '1.2.3',
    availableVersion: '1.2.4',
    progress: null,
    error: null,
  });
});

test('runs the Preview download and install transition contract', async () => {
  const updater = new FakeUpdater();
  let installCalls = 0;
  const controller = createAppUpdater({
    updater,
    currentVersion: '1.2.4-preview.1',
    isPackaged: true,
    onInstall: async () => { installCalls += 1; },
  });
  assert.equal(updater.allowPrerelease, true);

  await controller.check();
  assert.equal(controller.getSnapshot().status, 'checking');
  updater.emit('update-available', { version: '1.2.4-preview.2' });
  await controller.download();
  assert.equal(updater.downloadCalls, 1);
  assert.equal(controller.getSnapshot().status, 'downloading');

  updater.emit('download-progress', { percent: -4 });
  assert.equal(controller.getSnapshot().progress, 0);
  updater.emit('download-progress', { percent: 180 });
  assert.equal(controller.getSnapshot().progress, 100);
  updater.emit('update-downloaded', { version: '1.2.4-preview.2' });
  assert.deepEqual(controller.getSnapshot(), {
    status: 'downloaded',
    currentVersion: '1.2.4-preview.1',
    availableVersion: '1.2.4-preview.2',
    progress: 100,
    error: null,
  });

  await controller.install();
  assert.equal(installCalls, 1);
  assert.equal(controller.getSnapshot().status, 'installing');
  await assert.rejects(controller.install(), assertPublicError);
  updater.emit('error', new Error('token=secret /private/download.zip'));
  assert.equal(controller.getSnapshot().status, 'installing');
});

test('keeps only a retryable candidate on provider failure and retries exact allowed actions', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({
    updater,
    currentVersion: '2.0.0',
    isPackaged: true,
    onInstall() {},
  });

  await controller.check();
  updater.emit('update-available', { version: '2.1.0' });
  await controller.download();
  updater.emit('error', new Error('https://feed.example/token /private/update.zip certificate=secret'));
  const failedDownload = controller.getSnapshot();
  assert.deepEqual(failedDownload, {
    status: 'error',
    currentVersion: '2.0.0',
    availableVersion: '2.1.0',
    progress: null,
    error: { code: 'UPDATE_FAILED', message: 'Unable to update ITHARBORS' },
  });
  assert.equal(Object.isFrozen(failedDownload.error), true);

  await controller.download();
  assert.equal(updater.downloadCalls, 2);
  updater.emit('error', new Error('still secret'));
  updater.emit('error', new Error('repeated provider failure with /private/path'));
  assert.equal(controller.getSnapshot().availableVersion, '2.1.0');
  await controller.check();
  assert.deepEqual(controller.getSnapshot(), {
    status: 'checking',
    currentVersion: '2.0.0',
    availableVersion: null,
    progress: null,
    error: null,
  });

  updater.emit('update-not-available', { version: '2.0.0' });
  assert.equal(controller.getSnapshot().status, 'not-available');
  await controller.check();
  assert.equal(updater.checkCalls, 3);
});

test('delivers nested state transitions to every subscriber in transition order', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({
    updater,
    currentVersion: '2.0.0',
    isPackaged: true,
    onInstall() {},
  });
  const observed = [];
  controller.subscribe((snapshot) => {
    if (snapshot.status === 'available') void controller.download();
  });
  controller.subscribe((snapshot) => observed.push(snapshot.status));

  await controller.check();
  updater.emit('update-available', { version: '2.1.0' });
  assert.deepEqual(observed, ['checking', 'available', 'downloading']);
});

test('rejects every action outside the transition table with fixed public errors', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({
    updater,
    currentVersion: '3.0.0',
    isPackaged: true,
    onInstall() {},
  });

  await assert.rejects(controller.download(), assertPublicError);
  await assert.rejects(controller.install(), assertPublicError);
  const idle = controller.getSnapshot();
  updater.emit('update-available', { version: '3.1.0' });
  updater.emit('download-progress', { percent: 50 });
  updater.emit('update-downloaded', { version: '3.1.0' });
  assert.equal(controller.getSnapshot(), idle);

  await controller.check();
  updater.emit('update-available', { version: 'not-semver /private/value' });
  assert.deepEqual(controller.getSnapshot().error, {
    code: 'UPDATE_FAILED',
    message: 'Unable to update ITHARBORS',
  });
  assert.equal(controller.getSnapshot().availableVersion, null);
});

test('sanitizes rejected provider operations without exposing their reason', async () => {
  const updater = new FakeUpdater();
  updater.checkResult = Promise.reject(new Error('secret https://feed.example /private/update.zip token=abc'));
  const controller = createAppUpdater({
    updater,
    currentVersion: '4.0.0',
    isPackaged: true,
    onInstall() {},
  });

  await assert.rejects(controller.check(), (error) => assertPublicError(error, 'UPDATE_FAILED'));
  assert.deepEqual(controller.getSnapshot().error, {
    code: 'UPDATE_FAILED',
    message: 'Unable to update ITHARBORS',
  });
});

test('development is disabled and registers no provider listeners', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({
    updater,
    currentVersion: '1.0.0',
    isPackaged: false,
    onInstall() {},
  });

  assert.deepEqual(controller.getSnapshot(), {
    status: 'disabled',
    currentVersion: '1.0.0',
    availableVersion: null,
    progress: null,
    error: null,
  });
  for (const event of [
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error',
  ]) assert.equal(updater.listenerCount(event), 0);
  await assert.rejects(controller.check(), assertPublicError);
  assert.equal(updater.checkCalls, 0);
});

test('dispose removes every provider listener and freezes the final snapshot', async () => {
  const updater = new FakeUpdater();
  const controller = createAppUpdater({
    updater,
    currentVersion: '5.0.0',
    isPackaged: true,
    onInstall() {},
  });
  let notifications = 0;
  controller.subscribe(() => { notifications += 1; });
  await controller.check();
  const finalSnapshot = controller.dispose();

  assert.equal(Object.isFrozen(finalSnapshot), true);
  for (const event of [
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error',
  ]) assert.equal(updater.listenerCount(event), 0);
  updater.emit('update-available', { version: '5.1.0' });
  assert.equal(controller.getSnapshot(), finalSnapshot);
  assert.equal(notifications, 1);
  assert.equal(controller.dispose(), finalSnapshot);
  await assert.rejects(controller.check(), assertPublicError);
  await assert.rejects(controller.download(), assertPublicError);
});
