import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const preloadPath = fileURLToPath(new URL('./electron-preload.cjs', import.meta.url));
const gatewayPort = parsePort(process.env.PORT, 8080);
const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${gatewayPort}/`;
const frameworkArgs = ['run', 'dev', ...(process.argv.slice(2).length > 0 ? ['--', ...process.argv.slice(2)] : [])];

let frameworkProcess;
let mainWindow;
const sessionMenus = new Map();
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
      frameworkProcess = startFramework();
      await waitForUrl(startUrl);
      registerMenuIpc();
      registerOpenExternalUrlIpc();
      mainWindow = createMainWindow();
      await mainWindow.loadURL(startUrl);
    })
    .catch((error) => {
      console.error(error.message);
      app.quit();
    });

  app.on('browser-window-focus', (_event, window) => {
    applyMenuForWindow(window);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      await mainWindow.loadURL(startUrl);
    }
  });

  app.on('before-quit', () => {
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

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  window.on('closed', () => {
    const sessionId = windowSessions.get(window.id);
    windowSessions.delete(window.id);
    if (sessionId && !Array.from(windowSessions.values()).includes(sessionId)) {
      sessionMenus.delete(sessionId);
    }
  });

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
    sessionMenus.set(sanitizedPayload.sessionId, sanitizedPayload.menuTree);

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

  const menuTree = sessionMenus.get(sessionId) ?? [];
  const template = buildElectronMenuTemplate(sessionId, menuTree, {
    sendToWindow(payload) {
      if (window.isDestroyed()) {
        return;
      }
      window.webContents.send('ce:menu-action', payload);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sanitizeMenuSyncPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length > 0
    ? payload.sessionId
    : null;
  const menuTree = Array.isArray(payload.menuTree) ? sanitizeMenuNodes(payload.menuTree) : null;

  if (!sessionId || menuTree === null) {
    return null;
  }

  return { sessionId, menuTree };
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
