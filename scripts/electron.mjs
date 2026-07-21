import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { discoverKits } from './lib/kit-catalog.mjs';
import {
  buildTrayTemplate,
  createFrameworkArgs,
  createKitWindowUrl,
  openOrFocusKitWindow,
  parseElectronOptions,
  persistOpenWindowBounds,
} from './lib/electron-launcher.mjs';
import { WorkspaceStore } from './lib/workspace-store.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const preloadPath = fileURLToPath(new URL('./electron-preload.cjs', import.meta.url));
const trayIconPath = fileURLToPath(new URL('./assets/tray-icon.svg', import.meta.url));
const gatewayPort = parsePort(process.env.PORT, 8080);
const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${gatewayPort}/`;
const frameworkArgs = createFrameworkArgs(process.argv.slice(2));

let frameworkProcess;
let tray;
let workspaceStore;
let kitCatalog = [];
let electronOptions;
let quitting = false;
const kitWindows = new Map();
const sessionKits = new Map();
const sessionMenus = new Map();
const menuSyncWaiters = new Map();
const windowSessions = new Map();
let menuSyncListenerRegistered = false;
let menuSyncListener;
let openExternalUrlListenerRegistered = false;

const ALLOWED_ELECTRON_MENU_ROLES = new Set([
  'about',
  'close',
  'copy',
  'cut',
  'front',
  'hide',
  'hideOthers',
  'minimize',
  'paste',
  'quit',
  'redo',
  'reload',
  'resetZoom',
  'selectAll',
  'services',
  'toggleDevTools',
  'togglefullscreen',
  'undo',
  'unhide',
  'zoom',
  'zoomIn',
  'zoomOut',
]);

export function buildElectronMenuTemplate(sessionId, menuTree, adapters) {
  return menuTree.map((node) => toElectronTemplate(node, sessionId, adapters));
}

export function buildMultiKitMenuTemplate({ focusedSessionId, sessions }, adapters) {
  const focused = sessions.find((session) => session.sessionId === focusedSessionId) ?? sessions[0];
  if (!focused) return [];

  const applicationRoot = {
    type: 'menu',
    id: 'itharbors:application',
    label: 'APP',
    children: focused.applicationMenuTree,
  };
  const kitRoots = sessions
    .filter((session) => session.kitMenuRoot)
    .map((session) => ({
      node: {
        type: 'menu',
        id: `itharbors:kit:${session.kitMenuRoot.id}`,
        label: session.kitMenuRoot.label,
        children: session.kitMenuTree,
      },
      sessionId: session.sessionId,
    }));

  return [
    toElectronTemplate(applicationRoot, focused.sessionId, adapters),
    ...kitRoots.map(({ node, sessionId }) => toElectronTemplate(node, sessionId, adapters)),
  ];
}

export function configureElectronApp(electronApp) {
  electronApp.disableHardwareAcceleration();
}

function toElectronTemplate(node, sessionId, adapters) {
  const nodeType = node.type ?? node.kind;
  if (nodeType === 'separator') {
    return { type: 'separator' };
  }

  const item = {
    label: node.label,
    ...(node.accelerator ? { accelerator: node.accelerator } : {}),
  };

  if (ALLOWED_ELECTRON_MENU_ROLES.has(node.role)) {
    item.role = node.role;
  }

  if (node.children?.length) {
    item.submenu = node.children.map((child) => toElectronTemplate(child, sessionId, adapters));
    return item;
  }

  if (node.id) {
    item.click = () => {
      adapters.sendToWindow({
        sessionId,
        menuId: node.id,
      });
    };
  }

  return item;
}

if (shouldStartElectronApp()) {
  startElectronApp();
}

function shouldStartElectronApp() {
  const entryPath = process.argv[1];
  return Boolean(app?.whenReady && entryPath && fileURLToPath(import.meta.url) === path.resolve(entryPath));
}

function startElectronApp() {
  configureElectronApp(app);
  app.whenReady()
    .then(async () => {
      electronOptions = parseElectronOptions(process.argv.slice(2));
      kitCatalog = await discoverKits({
        rootDir,
        requestedKit: electronOptions.requestedKit ?? undefined,
      });
      if (kitCatalog.length === 0) {
        throw new Error('No valid Kits were discovered');
      }
      workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'workspaces.json'));
      frameworkProcess = startFramework();
      await waitForUrl(startUrl);
      registerMenuIpc();
      registerOpenExternalUrlIpc();
      await prewarmKitWindows();
      await createApplicationTray();
    })
    .catch((error) => {
      console.error(error.message);
      app.quit();
    });

  app.on('browser-window-focus', (_event, window) => {
    applyMenuForWindow(window);
  });

  app.on('window-all-closed', () => {
    // The tray owns the application lifecycle; closing a Kit window keeps its runtime alive.
  });

  app.on('activate', async () => {
    const defaultKit = kitCatalog[0];
    if (defaultKit) {
      await openKit(defaultKit.name);
    }
  });

  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      const persist = workspaceStore
        ? persistOpenWindowBounds(kitWindows, workspaceStore)
        : Promise.resolve();
      void persist
        .catch((error) => console.error('Failed to persist window bounds before quit:', error))
        .finally(() => app.quit());
      return;
    }
    tray?.destroy();
    tray = undefined;
    unregisterMenuIpc();
    unregisterOpenExternalUrlIpc();
    stopFramework();
  });
}

function startFramework() {
  console.log('Starting ITHARBORS framework from Electron');
  const child = spawn('npm', frameworkArgs, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error('Failed to start framework:', error.message);
    app.quit();
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`Framework exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      app.quit();
    }
  });

  return child;
}

async function prewarmKitWindows() {
  const results = await Promise.allSettled(kitCatalog.map(async (kit) => {
    const workspace = await workspaceStore.getOrCreate(kit);
    const window = await createKitWindow(kit, workspace);
    kitWindows.set(kit.name, window);
    return { kit, window };
  }));

  let visibleWindow = null;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      visibleWindow ??= result.value.window;
      return;
    }
    console.error(`Failed to open Kit ${kitCatalog[index].name}:`, result.reason);
  });

  if (visibleWindow) {
    visibleWindow.show();
    visibleWindow.focus();
  }
}

async function createApplicationTray() {
  const image = nativeImage.createFromPath(trayIconPath);
  image.setTemplateImage?.(true);
  tray = new Tray(image);
  tray.setToolTip('ITHARBORS');
  const workspaceRecords = await workspaceStore.list(kitCatalog);
  const template = buildTrayTemplate({ kits: kitCatalog, workspaceRecords }, {
    openKit,
    quit: () => app.quit(),
  });
  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);
  if (process.platform === 'darwin') {
    tray.on('click', () => tray?.popUpContextMenu(contextMenu));
  }
}

async function openKit(kitName) {
  try {
    return await openOrFocusKitWindow(kitName, kitWindows, async () => {
      const kit = kitCatalog.find((candidate) => candidate.name === kitName);
      if (!kit) {
        throw new Error(`Kit "${kitName}" is unavailable`);
      }
      const workspace = await workspaceStore.getOrCreate(kit);
      return createKitWindow(kit, workspace);
    });
  } catch (error) {
    console.error(`Failed to open Kit ${kitName}:`, error);
    return null;
  }
}

async function createKitWindow(kit, workspace) {
  const savedBounds = workspace.bounds ?? {};
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    ...savedBounds,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    title: `ITHARBORS — ${kit.label}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  windowSessions.set(window.id, workspace.sessionId);
  sessionKits.set(workspace.sessionId, kit.name);
  window.on('close', () => {
    if (quitting || window.isDestroyed()) return;
    workspaceStore.updateBounds(kit.name, window.getBounds()).catch((error) => {
      console.error(`Failed to persist bounds for ${kit.name}:`, error);
    });
  });
  window.on('closed', () => {
    windowSessions.delete(window.id);
    if (kitWindows.get(kit.name) === window) {
      kitWindows.delete(kit.name);
    }
  });

  const url = createKitWindowUrl(startUrl, kit, workspace, electronOptions.mode);
  try {
    await window.loadURL(url);
  } catch (error) {
    window.destroy();
    throw error;
  }
  return window;
}

function registerMenuIpc() {
  if (menuSyncListenerRegistered) {
    return;
  }

  menuSyncListener = (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const sanitizedPayload = sanitizeMenuSyncPayload(payload);
    if (!window || !sanitizedPayload) {
      return;
    }

    windowSessions.set(window.id, sanitizedPayload.sessionId);
    sessionMenus.set(sanitizedPayload.sessionId, sanitizedPayload);
    resolveMenuSyncWaiters(sanitizedPayload.sessionId);

    applyMenuForWindow(window);
  };
  ipcMain.on('ce:menu-sync', menuSyncListener);
  menuSyncListenerRegistered = true;
}

function unregisterMenuIpc() {
  if (!menuSyncListenerRegistered || !menuSyncListener) {
    return;
  }

  ipcMain.removeListener('ce:menu-sync', menuSyncListener);
  menuSyncListener = undefined;
  menuSyncListenerRegistered = false;
}

function registerOpenExternalUrlIpc() {
  if (openExternalUrlListenerRegistered) {
    return;
  }

  ipcMain.handle('ce:open-external-url', async (_event, url) => {
    const safeUrl = sanitizeExternalUrl(url);
    if (!safeUrl) {
      throw new Error('Invalid external URL');
    }
    await shell.openExternal(safeUrl);
  });
  openExternalUrlListenerRegistered = true;
}

function unregisterOpenExternalUrlIpc() {
  if (!openExternalUrlListenerRegistered) {
    return;
  }
  ipcMain.removeHandler('ce:open-external-url');
  openExternalUrlListenerRegistered = false;
}

function sanitizeExternalUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function applyMenuForWindow(window) {
  const sessionId = windowSessions.get(window.id);
  if (!sessionId) {
    return;
  }

  const adapters = {
    sendToWindow(payload) {
      void sendMenuActionToSession(payload).catch((error) => {
        console.error('Failed to dispatch menu action:', error);
      });
    },
  };
  const state = sessionMenus.get(sessionId);
  const template = electronOptions?.mode === 'multi'
    ? buildMultiKitMenuTemplate({
        focusedSessionId: sessionId,
        sessions: getOrderedMenuSessions(),
      }, adapters)
    : buildElectronMenuTemplate(sessionId, state?.menuTree ?? [], adapters);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getOrderedMenuSessions() {
  const catalogOrder = new Map(kitCatalog.map((kit, index) => [kit.name, index]));
  return Array.from(sessionMenus.values()).sort((left, right) => {
    const leftOrder = catalogOrder.get(sessionKits.get(left.sessionId)) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = catalogOrder.get(sessionKits.get(right.sessionId)) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

async function sendMenuActionToSession(payload) {
  const kitName = sessionKits.get(payload.sessionId);
  if (!kitName) return;

  let window = kitWindows.get(kitName);
  let syncWaiter = null;
  if (!window || window.isDestroyed()) {
    syncWaiter = createMenuSyncWaiter(payload.sessionId);
  }
  window = await openKit(kitName);
  if (!window) {
    syncWaiter?.cancel();
    return;
  }
  if (syncWaiter) {
    await syncWaiter.promise;
  }
  if (!window.isDestroyed()) {
    window.webContents.send('ce:menu-action', payload);
  }
}

function createMenuSyncWaiter(sessionId, timeoutMs = 5000) {
  let done;
  const promise = new Promise((resolve, reject) => {
    const waiters = menuSyncWaiters.get(sessionId) ?? new Set();
    menuSyncWaiters.set(sessionId, waiters);
    const timeout = setTimeout(() => {
      waiters.delete(done);
      if (waiters.size === 0) menuSyncWaiters.delete(sessionId);
      reject(new Error(`Timed out waiting for menu sync from ${sessionId}`));
    }, timeoutMs);
    done = () => {
      clearTimeout(timeout);
      waiters.delete(done);
      if (waiters.size === 0) menuSyncWaiters.delete(sessionId);
      resolve();
    };
    waiters.add(done);
  });
  return { promise, cancel: () => done?.() };
}

function resolveMenuSyncWaiters(sessionId) {
  const waiters = menuSyncWaiters.get(sessionId);
  if (!waiters) return;
  menuSyncWaiters.delete(sessionId);
  for (const resolve of waiters) resolve();
}

function sanitizeMenuSyncPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length > 0
    ? payload.sessionId
    : null;
  const menuMode = payload.menuMode === 'single' || payload.menuMode === 'multi'
    ? payload.menuMode
    : null;
  const menuTree = Array.isArray(payload.menuTree) ? sanitizeMenuNodes(payload.menuTree) : null;
  const applicationMenuTree = Array.isArray(payload.applicationMenuTree)
    ? sanitizeMenuNodes(payload.applicationMenuTree)
    : null;
  const kitMenuTree = Array.isArray(payload.kitMenuTree)
    ? sanitizeMenuNodes(payload.kitMenuTree)
    : null;
  const kitMenuRoot = sanitizeKitMenuRoot(payload.kitMenuRoot);

  if (!sessionId || !menuMode || menuTree === null || applicationMenuTree === null || kitMenuTree === null) {
    return null;
  }
  if (menuMode === 'multi' && !kitMenuRoot) return null;

  return { sessionId, menuMode, menuTree, applicationMenuTree, kitMenuTree, kitMenuRoot };
}

function sanitizeKitMenuRoot(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.label !== 'string' || value.label.length === 0) return null;
  return { id: value.id, label: value.label };
}

function sanitizeMenuNodes(nodes, depth = 0) {
  if (depth > 20) {
    return null;
  }

  const sanitized = [];
  for (const node of nodes) {
    const next = sanitizeMenuNode(node, depth);
    if (next) {
      sanitized.push(next);
    }
  }
  return sanitized;
}

function sanitizeMenuNode(node, depth) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const nodeType = node.type ?? node.kind;
  const id = typeof node.id === 'string' ? node.id : null;
  if (!id) {
    return null;
  }

  const order = typeof node.order === 'number' ? node.order : undefined;

  if (nodeType === 'separator') {
    return {
      type: 'separator',
      id,
      ...(order === undefined ? {} : { order }),
    };
  }

  if (nodeType !== 'menu' || typeof node.label !== 'string') {
    return null;
  }

  const children = Array.isArray(node.children) ? sanitizeMenuNodes(node.children, depth + 1) : null;
  if (children === null) {
    return null;
  }

  const accelerator = typeof node.accelerator === 'string' ? node.accelerator : undefined;
  const role = ALLOWED_ELECTRON_MENU_ROLES.has(node.role) ? node.role : undefined;

  return {
    type: 'menu',
    id,
    label: node.label,
    ...(accelerator === undefined ? {} : { accelerator }),
    ...(role === undefined ? {} : { role }),
    children,
  };
}

function waitForUrl(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let done = false;

    const check = () => {
      const request = http.get(url, (response) => {
        if (done) return;
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          done = true;
          resolve();
          return;
        }
        retry();
      });

      request.on('error', retry);
      request.setTimeout(1000, () => {
        request.destroy();
      });
    };

    const retry = () => {
      if (done) return;
      if (Date.now() - startedAt > timeoutMs) {
        done = true;
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(check, 500);
    };

    check();
  });
}

function stopFramework() {
  if (frameworkProcess && !frameworkProcess.killed) {
    frameworkProcess.kill('SIGTERM');
  }
}

function parsePort(value, fallback) {
  const port = parseInt(value || '', 10);
  return Number.isFinite(port) ? port : fallback;
}
