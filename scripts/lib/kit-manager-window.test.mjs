import assert from 'node:assert/strict';
import test from 'node:test';

import { createKitManagerWindowController } from './kit-manager-window.mjs';

function createBrowserWindowFake() {
  const instances = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.minimized = false;
      this.events = new Map();
      this.webEvents = new Map();
      this.calls = [];
      this.webContents = {
        id: instances.length + 10,
        on: (name, handler) => this.webEvents.set(name, handler),
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
      };
      instances.push(this);
    }
    on(name, handler) { this.events.set(name, handler); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.calls.push('restore'); this.minimized = false; }
    show() { this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    async loadFile(file) { this.calls.push(['loadFile', file]); }
    destroy() { this.destroyed = true; this.events.get('closed')?.(); }
  }
  return { BrowserWindow: FakeBrowserWindow, instances };
}

test('creates one locked-down local Kit Manager window and denies navigation', async () => {
  const fake = createBrowserWindowFake();
  const closed = [];
  const controller = createKitManagerWindowController({
    BrowserWindow: fake.BrowserWindow,
    preloadPath: '/app/kit-manager-preload.cjs',
    htmlPath: '/app/kit-manager.html',
    onClosed: () => closed.push(true),
  });
  const window = await controller.open();
  assert.equal(fake.instances.length, 1);
  assert.equal(controller.getWindow(), window);
  assert.deepEqual(window.options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: '/app/kit-manager-preload.cjs',
  });
  assert.equal(window.options.show, false);
  assert.deepEqual(window.calls, [['loadFile', '/app/kit-manager.html'], 'show', 'focus']);
  assert.deepEqual(window.openHandler({ url: 'https://evil.test' }), { action: 'deny' });
  let prevented = 0;
  window.webEvents.get('will-navigate')({ preventDefault: () => { prevented += 1; } }, 'https://evil.test');
  assert.equal(prevented, 1);
  window.destroy();
  assert.equal(controller.getWindow(), null);
  assert.deepEqual(closed, [true]);
});

test('focuses an existing window and deduplicates concurrent creation', async () => {
  const fake = createBrowserWindowFake();
  const controller = createKitManagerWindowController({
    BrowserWindow: fake.BrowserWindow,
    preloadPath: '/app/preload.cjs',
    htmlPath: '/app/manager.html',
  });
  const [first, second] = await Promise.all([controller.open(), controller.open()]);
  assert.equal(first, second);
  assert.equal(fake.instances.length, 1);
  first.minimized = true;
  await controller.open();
  assert.deepEqual(first.calls.slice(-3), ['restore', 'show', 'focus']);
  controller.destroy();
  assert.equal(first.destroyed, true);
  controller.destroy();
});

test('destroys a failed load and permits a later retry', async () => {
  const fake = createBrowserWindowFake();
  let shouldFail = true;
  const Original = fake.BrowserWindow;
  class FailingBrowserWindow extends Original {
    async loadFile(file) {
      if (shouldFail) throw new Error('load failed');
      return super.loadFile(file);
    }
  }
  const controller = createKitManagerWindowController({
    BrowserWindow: FailingBrowserWindow,
    preloadPath: '/app/preload.cjs',
    htmlPath: '/app/manager.html',
  });
  await assert.rejects(controller.open(), /load failed/);
  assert.equal(fake.instances[0].destroyed, true);
  shouldFail = false;
  assert.ok(await controller.open());
  assert.equal(fake.instances.length, 2);
});
