import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { appUpdatesDisabled, createAppUpdater } from './lib/app-updater.mjs';
import { registerAppUpdaterIpc } from './lib/app-updater-ipc.mjs';
import { discoverKits, resolveRequestedKitName } from './lib/kit-catalog.mjs';
import {
  calculateToastPositions,
  createBadgeOverlayDataUrl,
  createNotificationHtml,
  createToastQueue,
  formatNotificationTooltip,
} from './lib/notification-desktop.mjs';
import {
  createNotificationHost,
  createNotificationStore,
} from './lib/notification-host.mjs';
import { createNpmSpawnSpec } from './lib/npm-spawn.mjs';
import { resolveCurrentProcessRuntime, resolveFrameworkRuntime } from './lib/framework-runtime.mjs';
import { resolveDesktopPaths } from './lib/desktop-paths.mjs';
import {
  createPackagedFrameworkSpec,
  startDesktopFrameworkProcess,
} from './lib/desktop-framework-process.mjs';
import { resolveRuntimePorts, resolveRuntimeProfile } from './lib/runtime-ports.mjs';
import {
  buildTrayTemplate,
  buildUpdateMenuItems,
  createBeforeQuitGate,
  createFrameworkArgs,
  createKitWindowUrl,
  initializeKitHost,
  openOrFocusKitWindow,
  parseElectronOptions,
  persistOpenWindowBounds,
  selectMenuWindow,
  shouldStartElectronApp,
  shutdownDesktopServices,
  finishDesktopShutdown,
  showKitChooser,
} from './lib/electron-launcher.mjs';
import { resolveCodexSkillSource } from './lib/codex-skill-resource.mjs';
import { WorkspaceStore } from './lib/workspace-store.mjs';
import { InstalledKitStore } from './lib/kit-store/state.mjs';
import {
  finalizePendingKitActivations,
  prepareInstalledKitsForStartup,
} from './lib/kit-store/startup.mjs';
import { createKitManagerService } from './lib/kit-manager-service.mjs';
import { registerKitManagerIpc } from './lib/kit-manager-ipc.mjs';
import { createKitManagerWindowController } from './lib/kit-manager-window.mjs';
import {
  createApplicationRuntimeClient,
  fetchApplicationBootstrap,
  triggerApplicationMenu,
  validateInstalledKitRuntime,
} from './lib/application-runtime-client.mjs';

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = fileURLToPath(new URL('./electron-preload.cjs', import.meta.url));
const notificationPreloadPath = fileURLToPath(new URL('./notification-preload.cjs', import.meta.url));
const kitManagerPreloadPath = fileURLToPath(new URL('./kit-manager-preload.cjs', import.meta.url));
const kitManagerHtmlPath = fileURLToPath(new URL('./kit-manager.html', import.meta.url));
const trayIconPath = fileURLToPath(new URL('./assets/tray-icon.png', import.meta.url));
const frameworkArgs = createFrameworkArgs(process.argv.slice(2));
const applicationControlToken = randomBytes(32).toString('hex');
const NOTIFICATION_KIT_NAME = '@itharbors/kit-notifications';
const TOAST_WIDTH = 360;
const TOAST_HEIGHT = 176;
let rootDir = repositoryRoot;
let desktopPaths;
let runtimeProfile;
let runtimePorts;
let startUrl;
let kitRuntime;

let frameworkProcess;
let frameworkStopPromise;
let frameworkReadyPromise;
let frameworkStop;
let tray;
let trayContextMenu;
let trayWorkspaceRecords = [];
let workspaceStore;
let kitStore;
let kitManagerService;
let kitManagerWindowController;
let kitManagerIpcRegistration;
let kitManagerCloseDrain = Promise.resolve();
let kitManagerRefreshTimer;
let kitManagerBackgroundRefresh;
let installedKits = [];
let pendingKitActivations = [];
let kitCatalog = [];
let electronOptions;
let quitting = false;
const kitWindows = new Map();
const kitWindowLoads = new Map();
const sessionKits = new Map();
const sessionMenus = new Map();
const menuSyncWaiters = new Map();
const windowSessions = new Map();
let menuSyncListenerRegistered = false;
let menuSyncListener;
let openExternalUrlListenerRegistered = false;
let updateController;
let updateIpcRegistration;
let updateUnsubscribe;
let updateCheckTimer;
let updateCheckScheduled = false;
let updatePromptPromise;
let installUpdateAfterShutdown = false;
let notificationStore;
let notificationHost;
let notificationPort;
let codexSkillSource;
let applicationMenuTree = [];
let applicationRuntimeClient;
let notificationStoreUnsubscribe;
let notificationStopPromise;
let toastQueue;
let toastIpcRegistered = false;
let currentUnreadCount = 0;
const toastWindows = new Map();
const toastWindowNotifications = new Map();

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
  return menuTree.map((node) => toElectronTemplate(
    node,
    { scope: 'session', sessionId },
    adapters,
  ));
}

export function buildMultiKitMenuTemplate({
  applicationMenuTree: globalMenuTree,
  focusedSessionId,
  sessions,
}, adapters) {
  const focused = sessions.find((session) => session.sessionId === focusedSessionId) ?? sessions[0];
  const kitRoots = sessions
    .filter((session) => session.kitMenuRoot)
    .map((session) => ({
      label: session.kitMenuRoot.label,
      children: session.kitMenuTree,
      sessionId: session.sessionId,
    }));

  const applicationItems = mergeElectronMenuTemplates(
    globalMenuTree.map((node) => toElectronTemplate(node, { scope: 'application' }, adapters)),
    (focused?.applicationMenuTree ?? []).map((node) => toElectronTemplate(
      node,
      { scope: 'session', sessionId: focused.sessionId },
      adapters,
    )),
  );
  if (typeof adapters.checkForUpdates === 'function') {
    applicationItems.push(...buildUpdateMenuItems({
      check: adapters.checkForUpdates,
      onError: adapters.onUpdateError,
    }));
  }

  return [
    electronRootTemplate('APP', applicationItems),
    ...kitRoots.map(({ label, children, sessionId }) => (
      toElectronRootTemplate(label, children, { scope: 'session', sessionId }, adapters)
    )),
  ];
}

export function configureElectronApp(electronApp) {
  electronApp.disableHardwareAcceleration();
}

function toElectronTemplate(node, target, adapters) {
  const nodeType = node.type ?? node.kind;
  if (nodeType === 'separator') {
    return { type: 'separator' };
  }

  const item = {
    id: node.id,
    label: node.label,
    ...(node.accelerator ? { accelerator: node.accelerator } : {}),
  };

  if (ALLOWED_ELECTRON_MENU_ROLES.has(node.role)) {
    item.role = node.role;
  }

  if (node.children?.length) {
    item.submenu = node.children.map((child) => toElectronTemplate(child, target, adapters));
    return item;
  }

  if (node.id) {
    item.click = () => {
      if (target.scope === 'application') {
        adapters.triggerApplication(node.id);
      } else {
        adapters.sendToWindow({ sessionId: target.sessionId, menuId: node.id });
      }
    };
  }

  return item;
}

function toElectronRootTemplate(label, children, target, adapters) {
  return electronRootTemplate(
    label,
    children.map((child) => toElectronTemplate(child, target, adapters)),
  );
}

function electronRootTemplate(label, submenu) {
  return {
    label,
    submenu,
    ...(submenu.length === 0 ? { enabled: false } : {}),
  };
}

function mergeElectronMenuTemplates(primary, secondary) {
  const merged = [...primary];
  for (const item of secondary) {
    const existing = item.id
      ? merged.find((candidate) => candidate.id === item.id)
      : undefined;
    if (existing?.submenu && item.submenu) {
      existing.submenu = mergeElectronMenuTemplates(existing.submenu, item.submenu);
    } else if (!existing) {
      merged.push(item);
    }
  }
  return merged;
}

if (shouldStartElectronApp({
  isPackaged: app?.isPackaged,
  entryPath: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
  modulePath: fileURLToPath(import.meta.url),
})) {
  startElectronApp();
}

function loadAutoUpdater() {
  return require('electron-updater').autoUpdater;
}

function startElectronApp() {
  const autoUpdater = loadAutoUpdater();
  configureElectronApp(app);
  const beforeQuitGate = createBeforeQuitGate({
    shutdown: () => shutdownDesktopServices({
      persistWorkspace: () => workspaceStore
        ? persistOpenWindowBounds(kitWindows, workspaceStore)
        : Promise.resolve(),
      stopFramework,
      stopKitManagerService,
      stopNotificationService,
    }),
    finalize: (results) => finishDesktopShutdown({
      results,
      installUpdateAfterShutdown,
      updater: autoUpdater,
      quit: () => app.quit(),
      logError: (message) => console.error(message),
    }),
    onFailure() {
      if (installUpdateAfterShutdown) autoUpdater.autoInstallOnAppQuit = false;
      console.error('Failed to complete application shutdown');
      app.quit();
    },
  });
  app.whenReady()
    .then(async () => {
      electronOptions = parseElectronOptions(process.argv.slice(2));
      desktopPaths = resolveDesktopPaths({
        isPackaged: app.isPackaged,
        repositoryRoot,
        resourcesPath: process.resourcesPath,
        moduleDirectory,
        userData: app.getPath('userData'),
      });
      rootDir = desktopPaths.rootDir;
      runtimeProfile = resolveRuntimeProfile(process.env.HARBORS_RUNTIME_PROFILE, 'stable');
      runtimePorts = resolveRuntimePorts(process.env, runtimeProfile);
      startUrl = app.isPackaged
        ? undefined
        : process.env.ELECTRON_START_URL || `http://localhost:${runtimePorts.gateway}/`;
      kitRuntime = Object.freeze({
        harborsVersion: app.getVersion(),
        kitApiVersion: '1.0.0',
        protocolVersion: 1,
        ...(app.isPackaged ? resolveCurrentProcessRuntime(process) : resolveFrameworkRuntime()),
      });
      updateController = createAppUpdater({
        updater: autoUpdater,
        currentVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        updatesDisabled: appUpdatesDisabled(process.env.HARBORS_DISABLE_UPDATE_CHECKS),
        onInstall() {
          installUpdateAfterShutdown = true;
          app.quit();
        },
      });
      updateUnsubscribe = updateController.subscribe(handleUpdateSnapshot);
      const kitStoreRoot = desktopPaths.kitStoreRoot;
      kitStore = new InstalledKitStore(kitStoreRoot);
      kitManagerService = createKitManagerService({
        storeRoot: kitStoreRoot,
        store: kitStore,
        runtime: kitRuntime,
      });
      const prepared = await prepareInstalledKitsForStartup({
        store: kitStore,
        audit: kitManagerService.audit,
        validateCatalog: async (sources) => discoverKits({ rootDir, installedKits: sources }),
      });
      installedKits = prepared.activeSources;
      pendingKitActivations = prepared.pendingActivations;
      kitCatalog = await discoverKits({
        rootDir,
        requestedKit: electronOptions.requestedKit ?? undefined,
        installedKits,
      });
      electronOptions = {
        ...electronOptions,
        requestedKit: resolveRequestedKitName(
          kitCatalog,
          electronOptions.requestedKit,
          rootDir,
        ),
      };
      if (kitCatalog.length === 0) {
        throw new Error('No valid Kits were discovered');
      }
      workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'workspaces.json'));
      kitManagerWindowController = createKitManagerWindowController({
        BrowserWindow,
        preloadPath: kitManagerPreloadPath,
        htmlPath: kitManagerHtmlPath,
        onClosed() {
          const registration = kitManagerIpcRegistration;
          registration?.unregister();
          kitManagerIpcRegistration = undefined;
          kitManagerCloseDrain = registration?.drain() ?? Promise.resolve();
        },
      });
      codexSkillSource = resolveCodexSkillSource({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        rootDir,
      });
      await initializeKitHost(electronOptions, {
        createTray: createApplicationTray,
        startFramework: startFrameworkAndTrackReadiness,
        registerIpc() {
          registerMenuIpc();
          registerOpenExternalUrlIpc();
          updateIpcRegistration = registerAppUpdaterIpc({
            ipcMain,
            BrowserWindow,
            controller: updateController,
            getApplicationWindows: getLiveKitWindows,
          });
        },
        openKit,
      });
      scheduleKitManagerRefresh();
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

  app.on('activate', () => {
    showKitChooser(tray);
  });

  app.on('before-quit', (event) => {
    const pendingShutdown = beforeQuitGate.handle(event);
    if (pendingShutdown) {
      quitting = true;
      return;
    }
    tray?.destroy();
    tray = undefined;
    unregisterMenuIpc();
    unregisterOpenExternalUrlIpc();
    if (updateCheckTimer) clearTimeout(updateCheckTimer);
    updateCheckTimer = undefined;
    updateIpcRegistration?.unregister();
    updateIpcRegistration = undefined;
    updateUnsubscribe?.();
    updateUnsubscribe = undefined;
    updateController?.dispose();
    updateController = undefined;
    kitManagerIpcRegistration?.unregister();
    kitManagerIpcRegistration = undefined;
    applicationRuntimeClient?.close();
    applicationRuntimeClient = undefined;
  });
}

async function startFramework() {
  if (app.isPackaged) return startPackagedFramework();
  return startDevelopmentFramework();
}

async function startPackagedFramework() {
  console.log('Starting packaged ITHARBORS framework from Electron');
  const started = startDesktopFrameworkProcess(createPackagedFrameworkSpec({
    executable: process.execPath,
    frameworkEntry: desktopPaths.frameworkEntry,
    env: {
      ...process.env,
      HARBORS_RUNTIME_ROOT: desktopPaths.runtimeRoot,
      HARBORS_CLIENT_ASSETS_ROOT: desktopPaths.clientAssetsRoot,
      HARBORS_DB_PATH: desktopPaths.dbPath,
      HARBORS_NOTIFICATION_PORT: String(notificationPort),
      HARBORS_NOTIFY_SKILL_SOURCE: codexSkillSource,
      HARBORS_APPLICATION_TOKEN: applicationControlToken,
      HARBORS_INSTALLED_KITS: JSON.stringify(installedKits.map((kit) => kit.directory)),
    },
  }));
  frameworkProcess = started.child;
  frameworkStop = started.stop;
  observeFrameworkProcess(started.child);
  const ready = await started.ready;
  return Object.freeze({ ...ready, stop: started.stop });
}

function startDevelopmentFramework() {
  console.log('Starting ITHARBORS framework from Electron');
  const npm = createNpmSpawnSpec(frameworkArgs);
  const child = spawn(npm.command, npm.args, {
    ...npm.spawnOptions,
    cwd: rootDir,
    env: {
      ...process.env,
      HARBORS_RUNTIME_PROFILE: runtimeProfile,
      HARBORS_GATEWAY_PORT: String(runtimePorts.gateway),
      HARBORS_SERVER_PORT: String(runtimePorts.server),
      HARBORS_CLIENT_PORT: String(runtimePorts.client),
      HARBORS_NOTIFICATION_PORT: String(notificationPort),
      HARBORS_NOTIFY_SKILL_SOURCE: codexSkillSource,
      HARBORS_HOST_MODE: 'desktop',
      HARBORS_APPLICATION_TOKEN: applicationControlToken,
      HARBORS_BIND_HOST: '127.0.0.1',
      HARBORS_INSTALLED_KITS: JSON.stringify(installedKits.map((kit) => kit.directory)),
    },
    stdio: 'inherit',
  });

  observeFrameworkProcess(child);
  return Object.freeze({ child, startUrl, stop: undefined });
}

function observeFrameworkProcess(child) {
  child.on('error', (error) => {
    console.error('Failed to start framework:', error.message);
    process.exitCode = 1;
    app.quit();
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`Framework exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      app.quit();
    }
  });
}

function scheduleKitManagerRefresh(delayMs = 1500) {
  if (!kitManagerService || kitManagerRefreshTimer) return;
  kitManagerRefreshTimer = setTimeout(() => {
    kitManagerRefreshTimer = undefined;
    kitManagerBackgroundRefresh = kitManagerService.manager.refresh()
      .catch((error) => {
        console.error('Kit Registry background refresh failed:', error.message);
      })
      .finally(() => {
        kitManagerBackgroundRefresh = undefined;
      });
  }, delayMs);
}

async function openKitManager() {
  if (quitting || !kitManagerWindowController || !kitManagerService) return null;
  if (!kitManagerIpcRegistration) {
    kitManagerIpcRegistration = registerKitManagerIpc({
      ipcMain,
      getManagerWindow: () => kitManagerWindowController?.getWindow(),
      service: kitManagerService.manager,
    });
  }
  try {
    return await kitManagerWindowController.open();
  } catch (error) {
    kitManagerIpcRegistration?.unregister();
    kitManagerIpcRegistration = undefined;
    console.error('Failed to open Kit Manager:', error.message);
    return null;
  }
}

async function stopKitManagerService() {
  if (kitManagerRefreshTimer) {
    clearTimeout(kitManagerRefreshTimer);
    kitManagerRefreshTimer = undefined;
  }
  const registration = kitManagerIpcRegistration;
  kitManagerIpcRegistration = undefined;
  registration?.unregister();
  kitManagerWindowController?.destroy();
  await Promise.allSettled([
    registration?.drain(),
    kitManagerCloseDrain,
    kitManagerBackgroundRefresh,
  ].filter(Boolean));
  kitManagerBackgroundRefresh = undefined;
}

async function startFrameworkAndTrackReadiness() {
  await startNotificationService();
  frameworkStopPromise = undefined;
  const started = await startFramework();
  frameworkProcess = started.child;
  frameworkStop = started.stop;
  startUrl = started.startUrl;
  frameworkReadyPromise = waitForApplicationRuntime(startUrl);
  const bootstrap = await frameworkReadyPromise;
  const activation = await finalizePendingKitActivations({
    store: kitStore,
    selections: pendingKitActivations,
    audit: kitManagerService.audit,
    validateRuntime: (selection) => validateInstalledKitRuntime(
      startUrl,
      bootstrap,
      selection.id,
    ),
  });
  pendingKitActivations = [];
  if (activation.restartRequired) {
    app.relaunch();
    throw new Error('A Kit failed its first runtime load; restored state will be applied after restart');
  }
  updateApplicationBootstrap(bootstrap);
  applicationRuntimeClient = createApplicationRuntimeClient({
    baseUrl: startUrl,
    onBootstrap: updateApplicationBootstrap,
    onError: (error) => console.error('Application event stream failed:', error.message),
  });
  applicationRuntimeClient.startEvents();
  scheduleUpdateCheck();
}

function scheduleUpdateCheck(delayMs = 5000) {
  if (updateCheckScheduled || updateController?.getSnapshot().status === 'disabled') return;
  updateCheckScheduled = true;
  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = undefined;
    void updateController.check().catch(() => {
      console.error('Unable to update ITHARBORS');
    });
  }, delayMs);
}

function handleUpdateSnapshot(snapshot) {
  applyMenuForWindow(BrowserWindow.getFocusedWindow());
  if (snapshot.status === 'available') {
    void updateController.download().catch(() => {
      console.error('Unable to update ITHARBORS');
    });
    return;
  }
  if (snapshot.status !== 'downloaded' || updatePromptPromise) return;
  updatePromptPromise = dialog.showMessageBox({
    type: 'info',
    title: 'ITHARBORS 更新已就绪',
    message: `ITHARBORS ${snapshot.availableVersion} 已下载完成`,
    detail: '立即重启以安装更新，或稍后在退出应用时安装。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
    .then(({ response }) => (response === 0 ? updateController.install() : undefined))
    .catch(() => {
      console.error('Unable to update ITHARBORS');
    })
    .finally(() => {
      updatePromptPromise = undefined;
    });
}

function getLiveKitWindows() {
  return Array.from(kitWindows.values()).filter((window) => !window.isDestroyed());
}

async function createApplicationTray() {
  const image = nativeImage.createFromPath(trayIconPath);
  image.setTemplateImage?.(true);
  tray = new Tray(image);
  tray.setToolTip('ITHARBORS');
  trayWorkspaceRecords = await workspaceStore.list(kitCatalog);
  refreshApplicationTray();
  tray.on('click', () => showKitChooser(tray));
}

async function openKit(kitName) {
  try {
    await frameworkReadyPromise;
    return await openOrFocusKitWindow(
      kitName,
      kitWindows,
      kitWindowLoads,
      async () => {
        const kit = kitCatalog.find((candidate) => candidate.name === kitName);
        if (!kit) {
          throw new Error(`Kit "${kitName}" is unavailable`);
        }
        const workspace = await workspaceStore.getOrCreate(kit);
        return createKitWindow(kit, workspace);
      },
    );
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
  applyNotificationBadgeToWindow(window);
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

  const url = createKitWindowUrl(startUrl, kit, workspace);
  try {
    await window.loadURL(url);
  } catch (error) {
    window.destroy();
    throw error;
  }
  return window;
}

async function startNotificationService() {
  notificationStore = createNotificationStore();
  toastQueue = createToastQueue({
    onShow(notification, markShown) {
      void createToastWindow(notification)
        .then(() => markShown())
        .catch((error) => {
          console.error(`Failed to show notification ${notification.id}:`, error);
          toastQueue?.close(notification.id, 'failed');
        });
    },
    onHide(notification) {
      destroyToastWindow(notification.id);
    },
    onError(error) {
      console.error('Notification toast adapter failed:', error);
    },
  });
  notificationStoreUnsubscribe = notificationStore.subscribe((event) => {
    try {
      currentUnreadCount = event.snapshot.unreadCount;
      if (event.type === 'created' && event.notification) {
        toastQueue?.enqueue(event.notification);
      }
      if (event.type === 'removed' && event.id) {
        toastQueue?.remove(event.id);
      }
      refreshNotificationIndicators();
    } catch (error) {
      // Store listeners must never turn a successful state mutation into an HTTP 500.
      console.error('Failed to apply notification event:', error);
    }
  });

  registerNotificationToastIpc();
  notificationHost = createNotificationHost({
    store: notificationStore,
    port: runtimePorts.notification,
  });
  notificationPort = await notificationHost.start();
  refreshNotificationIndicators();
  console.log(`Notification Host listening on http://127.0.0.1:${notificationPort}`);
}

function stopNotificationService() {
  if (notificationStopPromise) return notificationStopPromise;

  notificationStopPromise = (async () => {
    // Stop accepting and drain HTTP requests before detaching their UI observers.
    await notificationHost?.stop();
    notificationStoreUnsubscribe?.();
    notificationStoreUnsubscribe = undefined;
    toastQueue?.dispose();
    toastQueue = undefined;
    for (const notificationId of Array.from(toastWindows.keys())) {
      destroyToastWindow(notificationId);
    }
    unregisterNotificationToastIpc();

    currentUnreadCount = 0;
    refreshNotificationIndicators();
    notificationHost = undefined;
    notificationStore = undefined;
    notificationPort = undefined;
  })();

  return notificationStopPromise;
}

function registerNotificationToastIpc() {
  if (toastIpcRegistered) return;

  ipcMain.handle('harbors:notification-open-center', async (event) => {
    const notificationId = toastWindowNotifications.get(event.sender.id);
    if (!notificationId) return false;

    try {
      notificationStore?.markRead(notificationId);
    } catch (error) {
      console.error(`Failed to mark notification ${notificationId} as read:`, error);
    }
    toastQueue?.close(notificationId, 'opened');
    return Boolean(await openKit(NOTIFICATION_KIT_NAME));
  });
  ipcMain.handle('harbors:notification-close-toast', (event) => {
    const notificationId = toastWindowNotifications.get(event.sender.id);
    return notificationId ? toastQueue?.close(notificationId, 'closed') ?? false : false;
  });
  toastIpcRegistered = true;
}

function unregisterNotificationToastIpc() {
  if (!toastIpcRegistered) return;
  ipcMain.removeHandler('harbors:notification-open-center');
  ipcMain.removeHandler('harbors:notification-close-toast');
  toastIpcRegistered = false;
}

async function createToastWindow(notification) {
  if (quitting || !toastQueue) return;

  const window = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: notificationPreloadPath,
    },
  });

  toastWindows.set(notification.id, window);
  const webContentsId = window.webContents.id;
  toastWindowNotifications.set(webContentsId, notification.id);
  window.on('closed', () => {
    toastWindowNotifications.delete(webContentsId);
    if (toastWindows.get(notification.id) === window) {
      toastWindows.delete(notification.id);
      toastQueue?.close(notification.id, 'window-closed');
      reflowToastWindows();
    }
  });

  try {
    const html = createNotificationHtml(notification);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (!window.isDestroyed()) {
      reflowToastWindows();
      window.showInactive();
    }
  } catch (error) {
    destroyToastWindow(notification.id);
    throw error;
  }
}

function destroyToastWindow(notificationId) {
  const window = toastWindows.get(notificationId);
  if (!window) return;

  toastWindows.delete(notificationId);
  if (!window.isDestroyed()) {
    toastWindowNotifications.delete(window.webContents.id);
  }
  if (!window.isDestroyed()) window.destroy();
  reflowToastWindows();
}

function reflowToastWindows() {
  if (!toastQueue || toastWindows.size === 0) return;

  const visibleWindows = toastQueue.snapshot().visible
    .map((notificationId) => toastWindows.get(notificationId))
    .filter((window) => window && !window.isDestroyed());
  if (visibleWindows.length === 0) return;

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const positions = calculateToastPositions(
    display.workArea,
    visibleWindows.map((window) => window.getBounds().height),
    { width: TOAST_WIDTH },
  );
  visibleWindows.forEach((window, index) => {
    window.setPosition(positions[index].x, positions[index].y, false);
  });
}

function refreshNotificationIndicators() {
  if (process.platform !== 'win32') {
    app.setBadgeCount?.(currentUnreadCount);
  }
  for (const window of kitWindows.values()) {
    applyNotificationBadgeToWindow(window);
  }
  refreshApplicationTray();
}

function applyNotificationBadgeToWindow(window) {
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return;

  const badgeUrl = createBadgeOverlayDataUrl(currentUnreadCount);
  const image = badgeUrl ? nativeImage.createFromDataURL(badgeUrl) : null;
  window.setOverlayIcon(image, currentUnreadCount > 0
    ? `${currentUnreadCount} unread notifications`
    : '');
}

function refreshApplicationTray() {
  if (!tray || tray.isDestroyed()) return;

  const template = buildTrayTemplate({
    kits: kitCatalog,
    workspaceRecords: trayWorkspaceRecords,
    unreadCount: currentUnreadCount,
    notificationKitName: NOTIFICATION_KIT_NAME,
  }, {
    openKit,
    openKitManager,
    quit: () => app.quit(),
  });
  trayContextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(trayContextMenu);
  tray.setToolTip(formatNotificationTooltip(currentUnreadCount));
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

    applyMenuForWindow(selectMenuWindow(
      BrowserWindow.getFocusedWindow(),
      window,
      windowSessions,
    ));
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
  const sessionId = window && !window.isDestroyed()
    ? windowSessions.get(window.id)
    : undefined;

  const adapters = {
    sendToWindow(payload) {
      void sendMenuActionToSession(payload).catch((error) => {
        console.error('Failed to dispatch menu action:', error);
      });
    },
    triggerApplication(menuId) {
      void triggerApplicationMenu(startUrl, menuId, applicationControlToken).catch((error) => {
        console.error('Failed to dispatch application menu action:', error);
      });
    },
    checkForUpdates() {
      return updateController.check();
    },
    onUpdateError() {
      console.error('Unable to update ITHARBORS');
    },
  };
  const template = buildMultiKitMenuTemplate({
    applicationMenuTree,
    focusedSessionId: sessionId,
    sessions: getOrderedMenuSessions(),
  }, adapters);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateApplicationBootstrap(bootstrap) {
  const nextTree = sanitizeMenuNodes(bootstrap?.menu?.tree);
  if (!nextTree || (bootstrap.phase !== 'ready' && bootstrap.phase !== 'degraded')) return;
  applicationMenuTree = nextTree;
  if (bootstrap.phase === 'degraded') {
    console.warn('Application Runtime started in degraded mode:', bootstrap.diagnostics ?? []);
  }
  applyMenuForWindow(BrowserWindow.getFocusedWindow());
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

function waitForApplicationRuntime(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  const check = async () => {
    try {
      const bootstrap = await fetchApplicationBootstrap(url);
      if (bootstrap.phase === 'ready' || bootstrap.phase === 'degraded') return bootstrap;
    } catch {
      // The gateway or Framework may still be starting.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Application Runtime at ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return check();
  };
  return check();
}

function stopFramework() {
  if (frameworkStopPromise) return frameworkStopPromise;
  const child = frameworkProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  if (frameworkStop) {
    frameworkStopPromise = frameworkStop();
    return frameworkStopPromise;
  }
  frameworkStopPromise = new Promise((resolve) => {
    let forceStopTimer;
    const finish = () => {
      if (forceStopTimer) clearTimeout(forceStopTimer);
      child.off('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    if (!child.kill('SIGTERM')) {
      finish();
      return;
    }
    forceStopTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 10_000);
  });
  return frameworkStopPromise;
}

function parsePort(value, fallback) {
  const port = parseInt(value || '', 10);
  return Number.isFinite(port) ? port : fallback;
}
