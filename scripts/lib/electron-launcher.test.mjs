import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildTrayTemplate,
  createFrameworkArgs,
  createKitWindowUrl,
  initializeKitHost,
  openOrFocusKitWindow,
  parseElectronOptions,
  persistOpenWindowBounds,
  selectMenuWindow,
  showKitChooser,
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

test('initializes the Tray host without opening a default Kit', async () => {
  const calls = [];
  await initializeKitHost({ mode: 'multi', requestedKit: null }, {
    createTray: async () => { calls.push('tray'); },
    startFramework: () => { calls.push('framework'); },
    registerIpc: () => { calls.push('ipc'); },
    openKit: async (kitName) => { calls.push(`open:${kitName}`); },
  });

  assert.deepEqual(calls, ['tray', 'framework', 'ipc']);
});

test('opens only an explicitly requested Kit after host services start', async () => {
  const calls = [];
  await initializeKitHost({ mode: 'single', requestedKit: '@itharbors/kit-sqlite' }, {
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
