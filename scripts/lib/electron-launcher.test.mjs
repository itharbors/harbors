import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildTrayTemplate,
  createFrameworkArgs,
  createKitWindowUrl,
  mergeMenuTrees,
  openOrFocusKitWindow,
  parseElectronOptions,
  persistOpenWindowBounds,
  selectMenuWindow,
  shutdownDesktopServices,
} from './electron-launcher.mjs';

const rootDir = new URL('../..', import.meta.url);

test('parses default multi-Kit mode and retained --kit single mode', () => {
  assert.deepEqual(parseElectronOptions([]), { mode: 'multi', requestedKit: null });
  assert.deepEqual(parseElectronOptions(['--kit', '@itharbors/kit-sqlite']), {
    mode: 'single',
    requestedKit: '@itharbors/kit-sqlite',
  });
  assert.deepEqual(parseElectronOptions(['--kit=./kits/mysql']), {
    mode: 'single',
    requestedKit: './kits/mysql',
  });
});

test('rejects missing, duplicate and unknown Electron arguments', () => {
  assert.throws(() => parseElectronOptions(['--kit']), /requires/i);
  assert.throws(() => parseElectronOptions(['--kit=a', '--kit=b']), /only be specified once/i);
  assert.throws(() => parseElectronOptions(['--unknown']), /unknown Electron argument/i);
});

test('starts the Web stack without recursion and forwards single-Kit arguments', () => {
  assert.deepEqual(createFrameworkArgs([]), ['run', 'dev:web']);
  assert.deepEqual(createFrameworkArgs(['--kit', './kits/sqlite']), [
    'run',
    'dev:web',
    '--',
    '--kit',
    './kits/sqlite',
  ]);
});

test('keeps Electron as the default dev entry and Web as an explicit compatibility entry', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));

  assert.equal(packageJson.scripts.dev, 'npm run electron --');
  assert.equal(packageJson.scripts['dev:web'], 'node scripts/dev.mjs');
  assert.equal(packageJson.scripts.electron, 'electron scripts/electron.mjs');
});

test('creates a per-Kit URL carrying stable session, Kit path and menu mode', () => {
  const url = new URL(createKitWindowUrl(
    'http://localhost:8080/?page=editor',
    { directory: '/repo/kits/sqlite' },
    { sessionId: 'sqlite session' },
    'multi',
  ));

  assert.equal(url.origin, 'http://localhost:8080');
  assert.equal(url.searchParams.get('page'), 'editor');
  assert.equal(url.searchParams.get('session'), 'sqlite session');
  assert.equal(url.searchParams.get('kit'), '/repo/kits/sqlite');
  assert.equal(url.searchParams.get('menuMode'), 'multi');
});

test('builds tray entries for available and persisted unavailable Kits', () => {
  const opened = [];
  let quitCount = 0;
  const template = buildTrayTemplate({
    kits: [
      { name: '@itharbors/kit-default', label: 'Default Kit' },
      { name: '@itharbors/kit-sqlite', label: 'SQLite' },
    ],
    workspaceRecords: [
      { kitName: '@itharbors/kit-default', available: true },
      { kitName: '@itharbors/kit-removed', available: false },
    ],
  }, {
    openKit: (kitName) => opened.push(kitName),
    quit: () => { quitCount += 1; },
  });

  assert.deepEqual(template.map(({ label, enabled, type }) => ({ label, enabled, type })), [
    { label: 'Default Kit', enabled: true, type: undefined },
    { label: 'SQLite', enabled: true, type: undefined },
    { label: '@itharbors/kit-removed (Unavailable)', enabled: false, type: undefined },
    { label: undefined, enabled: undefined, type: 'separator' },
    { label: 'Quit ITHARBORS', enabled: undefined, type: undefined },
  ]);
  template[1].click();
  template[4].click();
  assert.deepEqual(opened, ['@itharbors/kit-sqlite']);
  assert.equal(quitCount, 1);
});

test('adds unread count only to the Notification Kit tray entry', () => {
  const template = buildTrayTemplate({
    kits: [
      { name: '@itharbors/kit-default', label: 'Default Kit' },
      { name: '@itharbors/kit-notifications', label: 'Notifications' },
    ],
    workspaceRecords: [],
    unreadCount: 4,
    notificationKitName: '@itharbors/kit-notifications',
  }, {
    openKit() {},
    quit() {},
  });

  assert.equal(template[0].label, 'Default Kit');
  assert.equal(template[1].label, 'Notifications (4)');
});

test('focuses an existing Kit window or creates a replacement', async () => {
  const calls = [];
  const existing = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  const registry = new Map([['sqlite', existing]]);

  const focused = await openOrFocusKitWindow('sqlite', registry, async () => {
    throw new Error('must not create');
  });

  assert.equal(focused, existing);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);

  existing.isDestroyed = () => true;
  const replacement = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => calls.push('replacement-show'),
    focus: () => calls.push('replacement-focus'),
  };
  const created = await openOrFocusKitWindow('sqlite', registry, async () => replacement);

  assert.equal(created, replacement);
  assert.equal(registry.get('sqlite'), replacement);
  assert.deepEqual(calls.slice(-2), ['replacement-show', 'replacement-focus']);
});

test('coalesces concurrent opens while a lazy Kit window is being created', async () => {
  const registry = new Map();
  let resolveCreate;
  let createCount = 0;
  const created = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
  };
  const createWindow = async () => {
    createCount += 1;
    await new Promise((resolve) => { resolveCreate = resolve; });
    return created;
  };

  const first = openOrFocusKitWindow('notifications', registry, createWindow);
  const second = openOrFocusKitWindow('notifications', registry, createWindow);
  await Promise.resolve();
  resolveCreate();

  assert.equal(await first, created);
  assert.equal(await second, created);
  assert.equal(createCount, 1);
  assert.equal(registry.get('notifications'), created);
});

test('clears a failed lazy-open so the Kit can be retried', async () => {
  const registry = new Map();
  const created = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
  };
  let attempts = 0;
  const createWindow = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('window failed');
    return created;
  };

  await assert.rejects(
    openOrFocusKitWindow('notifications', registry, createWindow),
    /window failed/,
  );
  const retried = await openOrFocusKitWindow('notifications', registry, createWindow);

  assert.equal(retried, created);
  assert.equal(attempts, 2);
});

test('stops the Framework before tearing down Electron-owned notification services', async () => {
  const events = [];
  let releaseFramework;
  const shutdown = shutdownDesktopServices({
    persistWorkspace: async () => { events.push('persist'); },
    stopFramework: async () => {
      events.push('framework:start');
      await new Promise((resolve) => { releaseFramework = resolve; });
      events.push('framework:stopped');
    },
    stopNotificationService: async () => { events.push('notification:stopped'); },
  });

  await Promise.resolve();
  assert.deepEqual(events, ['persist', 'framework:start']);
  releaseFramework();
  await shutdown;

  assert.deepEqual(events, [
    'persist',
    'framework:start',
    'framework:stopped',
    'notification:stopped',
  ]);
});

test('persists every live Kit window before the tray application quits', async () => {
  const updates = [];
  const windows = new Map([
    ['sqlite', { isDestroyed: () => false, getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }) }],
    ['removed', { isDestroyed: () => true, getBounds: () => ({ width: 1, height: 1 }) }],
  ]);

  await persistOpenWindowBounds(windows, {
    updateBounds: async (kitName, bounds) => { updates.push({ kitName, bounds }); },
  });

  assert.deepEqual(updates, [{
    kitName: 'sqlite',
    bounds: { x: 1, y: 2, width: 800, height: 600 },
  }]);
});

test('keeps APP menu actions bound to the focused Kit when a hidden Kit syncs', () => {
  const focused = { id: 1, isDestroyed: () => false };
  const hiddenSource = { id: 2, isDestroyed: () => false };
  const unknown = { id: 3, isDestroyed: () => false };
  const windowSessions = new Map([[1, 'focused-session'], [2, 'hidden-session']]);

  assert.equal(selectMenuWindow(focused, hiddenSource, windowSessions), focused);
  assert.equal(selectMenuWindow(unknown, hiddenSource, windowSessions), hiddenSource);
});

test('merges global application and focused-session menu trees by id', () => {
  const merged = mergeMenuTrees(
    [{
      type: 'menu',
      id: 'tools',
      label: 'Tools',
      children: [{ type: 'menu', id: 'tools/install', label: 'Install', children: [] }],
    }],
    [{
      type: 'menu',
      id: 'tools',
      label: 'Tools',
      children: [{ type: 'menu', id: 'tools/about', label: 'About', children: [] }],
    }],
  );

  assert.deepEqual(merged, [{
    type: 'menu',
    id: 'tools',
    label: 'Tools',
    children: [
      { type: 'menu', id: 'tools/install', label: 'Install', children: [] },
      { type: 'menu', id: 'tools/about', label: 'About', children: [] },
    ],
  }]);
});

test('wires the loopback Host, toast queue and desktop cleanup into Electron', async () => {
  const source = await readFile(new URL('../electron.mjs', import.meta.url), 'utf8');

  assert.match(source, /createNotificationHost/);
  assert.match(source, /createNotificationStore/);
  assert.match(source, /createToastQueue/);
  assert.match(source, /await startNotificationService\(\)/);
  assert.match(source, /HARBORS_NOTIFICATION_PORT:\s*String\(notificationPort\)/);
  assert.match(source, /harbors:notification-open-center/);
  assert.match(source, /harbors:notification-close-toast/);
  assert.match(source, /stopNotificationService\(\)/);
  assert.match(source, /applyNotificationBadgeToWindow\(window\)/);
  assert.match(source, /notification-preload\.cjs/);
  assert.match(source, /fetchApplicationBootstrap/);
  assert.match(source, /createApplicationRuntimeClient/);
  assert.match(source, /HARBORS_HOST_MODE:\s*'desktop'/);
  assert.match(source, /HARBORS_APPLICATION_TOKEN:\s*applicationControlToken/);
  assert.match(source, /HARBORS_BIND_HOST:\s*'127\.0\.0\.1'/);
  assert.doesNotMatch(source, /prewarmKitWindows/);
  assert.match(source, /await openKit\(kitCatalog\[0\]\.name\)/);

  const stopHost = source.indexOf('await notificationHost?.stop()');
  const unsubscribeStore = source.indexOf('notificationStoreUnsubscribe?.()');
  assert.ok(stopHost >= 0 && unsubscribeStore >= 0 && stopHost < unsubscribeStore);
});

test('keeps the notification toast preload bridge intentionally narrow', async () => {
  const source = await readFile(new URL('../notification-preload.cjs', import.meta.url), 'utf8');

  assert.match(source, /exposeInMainWorld\('notificationToast'/);
  assert.match(source, /openCenter/);
  assert.match(source, /closeToast/);
  assert.match(source, /harbors:notification-open-center/);
  assert.match(source, /harbors:notification-close-toast/);
  assert.doesNotMatch(source, /notificationId/);
});
