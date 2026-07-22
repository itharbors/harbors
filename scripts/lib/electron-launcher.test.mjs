import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildTrayTemplate,
  createFrameworkArgs,
  createKitWindowUrl,
  mergeMenuTrees,
  initializeKitHost,
  openOrFocusKitWindow,
  parseElectronOptions,
  persistOpenWindowBounds,
  selectMenuWindow,
  shutdownDesktopServices,
  showKitChooser,
} from './electron-launcher.mjs';
import { createDevPages, createDevServerEnv, createDevStackEnvironments } from './dev-launcher.mjs';

const rootDir = new URL('../..', import.meta.url);

test('parses an optional requested Kit without creating a host mode', () => {
  assert.deepEqual(parseElectronOptions([]), { requestedKit: null });
  assert.deepEqual(parseElectronOptions(['--kit', '@itharbors/kit-sqlite']), {
    requestedKit: '@itharbors/kit-sqlite',
  });
  assert.deepEqual(parseElectronOptions(['--kit=./kits/mysql']), {
    requestedKit: './kits/mysql',
  });
});

test('rejects missing, duplicate and unknown Electron arguments', () => {
  assert.throws(() => parseElectronOptions(['--kit']), /requires/i);
  assert.throws(() => parseElectronOptions(['--kit=a', '--kit=b']), /only be specified once/i);
  assert.throws(() => parseElectronOptions(['--unknown']), /unknown Electron argument/i);
});

test('starts the Web stack without recursion and forwards requested Kit arguments', () => {
  assert.deepEqual(createFrameworkArgs([]), ['run', 'dev:web']);
  assert.deepEqual(createFrameworkArgs(['--kit', './kits/sqlite']), [
    'run',
    'dev:web',
    '--',
    '--kit',
    './kits/sqlite',
  ]);
});

test('passes only an explicit requested Kit to the Web server without leaking stale host state', () => {
  const base = { PATH: '/bin', CE_DEFAULT_KIT: 'stale-kit', CE_KIT_MODE: 'single' };

  assert.deepEqual(createDevServerEnv(base, ''), {
    PATH: '/bin',
  });
  assert.deepEqual(createDevServerEnv(base, '@itharbors/kit-mysql'), {
    PATH: '/bin',
    CE_DEFAULT_KIT: '@itharbors/kit-mysql',
  });
  assert.deepEqual(base, { PATH: '/bin', CE_DEFAULT_KIT: 'stale-kit', CE_KIT_MODE: 'single' });
});

test('isolates each Web child process from inherited legacy port variables', () => {
  const stack = createDevStackEnvironments({ PORT: '8080', SERVER_PORT: '3000', CLIENT_PORT: '5173' }, '', 'development');
  assert.deepEqual(stack.ports, { gateway: 49380, server: 49381, client: 49382, notification: 49383 });
  assert.equal(stack.gatewayEnv.PORT, '49380');
  assert.equal(stack.gatewayEnv.SERVER_PORT, '49381');
  assert.equal(stack.gatewayEnv.CLIENT_PORT, '49382');
  assert.equal(stack.serverEnv.PORT, '49381');
  assert.equal(stack.serverEnv.SERVER_PORT, undefined);
  assert.equal(stack.clientEnv.CLIENT_PORT, '49382');
  assert.equal(stack.clientEnv.PORT, undefined);
  assert.equal(stack.gatewayEnv.HARBORS_NOTIFICATION_PORT, '49383');
  assert.equal(stack.serverEnv.HARBORS_NOTIFICATION_PORT, '49383');
  assert.equal(stack.clientEnv.HARBORS_NOTIFICATION_PORT, '49383');
});

test('always prints the chooser and adds an encoded requested Kit shortcut', () => {
  assert.deepEqual(createDevPages(''), [
    ['Kit chooser', '/'],
    ['Layout Kit', '/?page=layout-kit'],
    ['UI Kit', '/?page=ui-kit'],
  ]);
  assert.deepEqual(createDevPages('@itharbors/kit-mysql'), [
    ['Kit chooser', '/'],
    ['Requested Kit', '/?kit=%40itharbors%2Fkit-mysql'],
    ['Layout Kit', '/?page=layout-kit'],
    ['UI Kit', '/?page=ui-kit'],
  ]);
});

test('keeps electron stable and makes dev an isolated Electron entry', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));

  assert.equal(packageJson.scripts.start, 'electron scripts/electron.mjs');
  assert.equal(packageJson.scripts.electron, 'npm run start --');
  assert.equal(packageJson.scripts.dev, 'node scripts/dev-electron.mjs');
  const electronSource = await readFile(new URL('../electron.mjs', import.meta.url), 'utf8');
  assert.match(electronSource, /resolveRuntimePorts/);
  assert.match(electronSource, /HARBORS_RUNTIME_PROFILE/);
});

test('limits the default cleanup command to development ports', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));

  assert.match(packageJson.scripts.kill, /lsof -ti:49380/);
  assert.match(packageJson.scripts.kill, /lsof -ti:49381/);
  assert.match(packageJson.scripts.kill, /lsof -ti:49382/);
  assert.doesNotMatch(packageJson.scripts.kill, /lsof -ti:48380(?:\s|$)/);
  assert.doesNotMatch(packageJson.scripts.kill, /lsof -ti:48381(?:\s|$)/);
  assert.doesNotMatch(packageJson.scripts.kill, /lsof -ti:48382(?:\s|$)/);
  assert.doesNotMatch(packageJson.scripts.kill, /lsof -ti:48383(?:\s|$)/);
  assert.doesNotMatch(packageJson.scripts.kill, /lsof -ti:49383(?:\s|$)/);
});

test('documents the stable start command and isolated high ports', async () => {
  const documents = await Promise.all([
    readFile(new URL('../../readme.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/guides/development-workflow.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/architecture/runtime-flows.md', import.meta.url), 'utf8'),
  ]);

  for (const document of documents) {
    assert.match(document, /npm run start/);
    assert.match(document, /48380/);
    assert.match(document, /48381/);
    assert.match(document, /48382/);
    assert.match(document, /48383/);
    assert.match(document, /49380/);
    assert.match(document, /49381/);
    assert.match(document, /49382/);
    assert.match(document, /49383/);
  }
});

test('uses visible PNG tray icon assets at standard and Retina densities', async () => {
  const electronSource = await readFile(new URL('../electron.mjs', import.meta.url), 'utf8');

  assert.match(electronSource, /assets\/tray-icon\.png/);
  assert.doesNotMatch(electronSource, /assets\/tray-icon\.svg/);

  for (const [fileName, expectedSize] of [
    ['tray-icon.png', 18],
    ['tray-icon@2x.png', 36],
  ]) {
    const icon = await readFile(new URL(`../assets/${fileName}`, import.meta.url));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(icon.readUInt32BE(16), expectedSize);
    assert.equal(icon.readUInt32BE(20), expectedSize);
    assert.ok(icon.length > 100, `${fileName} must not be empty`);
  }
});

test('initializes the Tray host without opening a default Kit', async () => {
  const calls = [];
  await initializeKitHost({ requestedKit: null }, {
    createTray: async () => { calls.push('tray'); },
    startFramework: () => { calls.push('framework'); },
    registerIpc: () => { calls.push('ipc'); },
    openKit: async (kitName) => { calls.push(`open:${kitName}`); },
  });

  assert.deepEqual(calls, ['tray', 'framework', 'ipc']);
});

test('opens only an explicitly requested Kit after host services start', async () => {
  const calls = [];
  await initializeKitHost({ requestedKit: '@itharbors/kit-sqlite' }, {
    createTray: async () => { calls.push('tray'); },
    startFramework: () => { calls.push('framework'); },
    registerIpc: () => { calls.push('ipc'); },
    openKit: async (kitName) => { calls.push(`open:${kitName}`); },
  });

  assert.deepEqual(calls, [
    'tray',
    'framework',
    'ipc',
    'open:@itharbors/kit-sqlite',
  ]);
});

test('shows the Kit chooser without selecting a default Kit', () => {
  let popupCount = 0;
  const tray = {
    isDestroyed: () => false,
    popUpContextMenu: () => { popupCount += 1; },
  };

  assert.equal(showKitChooser(tray), true);
  assert.equal(popupCount, 1);
  assert.equal(showKitChooser(null), false);
  assert.equal(showKitChooser({ isDestroyed: () => true }), false);
});

test('creates a per-Kit URL carrying stable session, Kit path and menu mode', () => {
  assert.equal(createKitWindowUrl.length, 3);
  const url = new URL(createKitWindowUrl(
    'http://localhost:8080/?page=editor',
    { directory: '/repo/kits/sqlite' },
    { sessionId: 'sqlite session' },
  ));

  assert.equal(url.origin, 'http://localhost:8080');
  assert.equal(url.searchParams.get('page'), 'editor');
  assert.equal(url.searchParams.get('session'), 'sqlite session');
  assert.equal(url.searchParams.get('kit'), '/repo/kits/sqlite');
  assert.equal(url.searchParams.get('menuMode'), 'multi');
});

test('uses aggregate multi-Kit menus for every Electron window', async () => {
  const electronSource = await readFile(new URL('../electron.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(electronSource, /electronOptions\?\.mode|electronOptions\.mode/);
  assert.match(electronSource, /const template = buildMultiKitMenuTemplate\(/);
  assert.match(electronSource, /requestedKit: resolveRequestedKitName\(/);
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

  const focused = await openOrFocusKitWindow('sqlite', registry, new Map(), async () => {
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
  const created = await openOrFocusKitWindow(
    'sqlite',
    registry,
    new Map(),
    async () => replacement,
  );

  assert.equal(created, replacement);
  assert.equal(registry.get('sqlite'), replacement);
  assert.deepEqual(calls.slice(-2), ['replacement-show', 'replacement-focus']);
});

test('deduplicates concurrent first opens of the same Kit', async () => {
  const registry = new Map();
  const pendingLoads = new Map();
  let createCount = 0;
  let finishCreate;
  const createdWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
  };
  const createWindow = async () => {
    createCount += 1;
    return new Promise((resolve) => { finishCreate = () => resolve(createdWindow); });
  };

  const first = openOrFocusKitWindow('sqlite', registry, pendingLoads, createWindow);
  const second = openOrFocusKitWindow('sqlite', registry, pendingLoads, createWindow);
  assert.equal(createCount, 1);
  assert.equal(pendingLoads.size, 1);

  finishCreate();
  const [firstWindow, secondWindow] = await Promise.all([first, second]);
  assert.equal(firstWindow, createdWindow);
  assert.equal(secondWindow, createdWindow);
  assert.equal(registry.get('sqlite'), createdWindow);
  assert.equal(pendingLoads.size, 0);
});

test('clears a failed Kit load so the next selection can retry', async () => {
  const registry = new Map();
  const pendingLoads = new Map();
  let createCount = 0;
  const createdWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
  };
  await assert.rejects(
    openOrFocusKitWindow('sqlite', registry, pendingLoads, async () => {
      createCount += 1;
      throw new Error('load failed');
    }),
    /load failed/,
  );
  const retried = await openOrFocusKitWindow(
    'sqlite',
    registry,
    pendingLoads,
    async () => {
      createCount += 1;
      return createdWindow;
    },
  );

  assert.equal(retried, createdWindow);
  assert.equal(createCount, 2);
  assert.equal(pendingLoads.size, 0);
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
  assert.match(source, /initializeKitHost/);
  assert.doesNotMatch(source, /openKit\(kitCatalog\[0\]\.name\)/);

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
