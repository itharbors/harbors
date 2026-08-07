import { formatNotificationKitLabel } from './notification-desktop.mjs';

export function shouldStartElectronApp({ isPackaged, entryPath, modulePath }) {
  return isPackaged === true || (typeof entryPath === 'string' && entryPath === modulePath);
}

export function shouldUseBundledFramework({ isPackaged, runtimeProfile }) {
  if (runtimeProfile !== 'stable' && runtimeProfile !== 'development') {
    throw new TypeError('runtimeProfile must be stable or development');
  }
  return isPackaged === true || runtimeProfile === 'stable';
}

export function registerDesktopSignalHandlers({ signalSource, quit }) {
  let disposed = false;
  let quitRequested = false;
  const requestQuit = () => {
    if (disposed || quitRequested) return;
    quitRequested = true;
    quit();
  };

  signalSource.on('SIGTERM', requestQuit);
  signalSource.on('SIGINT', requestQuit);

  return () => {
    if (disposed) return;
    disposed = true;
    signalSource.off('SIGTERM', requestQuit);
    signalSource.off('SIGINT', requestQuit);
  };
}

export function parseElectronOptions(args) {
  let requestedKit = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = ['--kit', '--kit-path', '--kitPath'].find((candidate) => (
      argument === candidate || argument.startsWith(`${candidate}=`)
    ));
    if (!name) {
      throw new Error(`Unknown Electron argument: ${argument}`);
    }
    if (requestedKit !== null) {
      throw new Error('--kit may only be specified once');
    }

    if (argument === name) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a Kit package name or path`);
      }
      requestedKit = value;
      index += 1;
    } else {
      const value = argument.slice(name.length + 1);
      if (!value) {
        throw new Error(`${name} requires a Kit package name or path`);
      }
      requestedKit = value;
    }
  }

  return { requestedKit };
}

export function createFrameworkArgs(args) {
  return [
    'run',
    'dev:web',
    ...(args.length > 0 ? ['--', ...args] : []),
  ];
}

export function createKitSourceSnapshot(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array');
  return Object.freeze(catalog.map((kit) => Object.freeze({
    directory: kit.directory,
    source: kit.source,
    ...(kit.artifactSha256 ? { artifactSha256: kit.artifactSha256 } : {}),
  })));
}

export async function initializeKitHost(options, adapters) {
  await adapters.createTray();
  await adapters.startFramework();
  adapters.registerIpc();
  if (options.requestedKit) {
    await adapters.openKit(options.requestedKit);
  }
}

export function showKitChooser(tray) {
  if (!tray || tray.isDestroyed?.()) return false;
  tray.popUpContextMenu();
  return true;
}

export function createKitWindowUrl(startUrl, kit, workspace) {
  const url = new URL(startUrl);
  url.searchParams.set('session', workspace.sessionId);
  url.searchParams.set('kit', kit.directory);
  url.searchParams.set('menuMode', 'multi');
  return url.href;
}

export function buildTrayTemplate({
  kits,
  workspaceRecords,
  unreadCount = 0,
  notificationKitName = null,
}, adapters) {
  const availableEntries = kits.map((kit) => ({
    label: kit.name === notificationKitName
      ? formatNotificationKitLabel(kit.label, unreadCount)
      : kit.label,
    enabled: true,
    click: () => adapters.openKit(kit.name),
  }));

  return [
    ...availableEntries,
    { type: 'separator' },
    { label: 'Kit Manager…', click: () => adapters.openKitManager() },
    { type: 'separator' },
    { label: 'Quit ITHARBORS', click: () => adapters.quit() },
  ];
}

export function buildUpdateMenuItems({ check, onError = () => {} }) {
  return [
    { type: 'separator' },
    {
      label: '检查更新…',
      click() {
        try {
          Promise.resolve(check()).catch(onError);
        } catch (error) {
          onError(error);
        }
      },
    },
  ];
}

export async function openOrFocusKitWindow(kitName, registry, pendingLoads, createWindow) {
  let window = registry.get(kitName);
  if (!window || window.isDestroyed()) {
    let pending = pendingLoads.get(kitName);
    if (!pending) {
      pending = Promise.resolve(createWindow(kitName))
        .then((createdWindow) => {
          registry.set(kitName, createdWindow);
          return createdWindow;
        })
        .finally(() => {
          pendingLoads.delete(kitName);
        });
      pendingLoads.set(kitName, pending);
    }
    window = await pending;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  return window;
}

export function closeKitWindow(kitWindows, kitName) {
  const window = kitWindows.get(kitName);
  if (!window || window.isDestroyed()) {
    kitWindows.delete(kitName);
    return false;
  }
  kitWindows.delete(kitName);
  window.close();
  return true;
}

export async function reloadKitWindows({
  kitWindows,
  catalog,
  startUrl,
  workspaceStore,
}) {
  const current = new Map(catalog.map((kit) => [kit.name, kit]));
  for (const [kitName, window] of Array.from(kitWindows.entries())) {
    if (!window || window.isDestroyed()) {
      kitWindows.delete(kitName);
      continue;
    }
    const kit = current.get(kitName);
    if (!kit) {
      closeKitWindow(kitWindows, kitName);
      continue;
    }
    const workspace = await workspaceStore.getOrCreate(kit);
    window.setTitle?.(`ITHARBORS — ${kit.label}`);
    await window.loadURL(createKitWindowUrl(startUrl, kit, workspace));
  }
}

export async function shutdownDesktopServices({
  persistWorkspace,
  stopKitManagerService = () => Promise.resolve(),
  stopFramework,
  stopNotificationService,
}) {
  const controlResults = await Promise.allSettled([
    persistWorkspace(),
    stopKitManagerService(),
  ]);
  const frameworkResults = await Promise.allSettled([
    stopFramework(),
  ]);
  const notificationResults = await Promise.allSettled([
    stopNotificationService(),
  ]);
  return [...controlResults, ...frameworkResults, ...notificationResults];
}

export function createBeforeQuitGate({ shutdown, finalize, onFailure }) {
  let shutdownPromise;
  let finalizing = false;

  return Object.freeze({
    handle(event) {
      if (finalizing) return undefined;
      event.preventDefault();
      if (!shutdownPromise) {
        shutdownPromise = Promise.resolve()
          .then(shutdown)
          .then((results) => {
            finalizing = true;
            return finalize(results);
          })
          .catch(() => {
            finalizing = true;
            return onFailure();
          });
      }
      return shutdownPromise;
    },
  });
}

export function finishDesktopShutdown({
  results,
  installUpdateAfterShutdown,
  updater,
  quit,
  logError,
}) {
  const failed = results.some((result) => result.status === 'rejected');
  if (installUpdateAfterShutdown && !failed) {
    updater.quitAndInstall();
    return;
  }
  if (installUpdateAfterShutdown) {
    updater.autoInstallOnAppQuit = false;
    logError('Update installation deferred because application shutdown failed');
  } else if (failed) {
    logError('Failed to complete one or more application shutdown steps');
  }
  quit();
}

export async function persistOpenWindowBounds(registry, workspaceStore) {
  const results = await Promise.allSettled(Array.from(registry.entries()).map(([kitName, window]) => {
    if (window.isDestroyed()) return undefined;
    return workspaceStore.updateBounds(kitName, window.getBounds());
  }));
  const errors = results.flatMap((result) => (
    result.status === 'rejected' ? [result.reason] : []
  ));
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to persist Kit window bounds');
  }
}

export function selectMenuWindow(focusedWindow, sourceWindow, windowSessions) {
  if (
    focusedWindow
    && !focusedWindow.isDestroyed()
    && windowSessions.has(focusedWindow.id)
  ) {
    return focusedWindow;
  }
  return sourceWindow;
}

export function mergeMenuTrees(primary, secondary) {
  const merged = structuredClone(Array.isArray(primary) ? primary : []);
  for (const sourceNode of Array.isArray(secondary) ? secondary : []) {
    const existing = merged.find((node) => (
      node.type === 'menu' && sourceNode.type === 'menu' && node.id === sourceNode.id
    ));
    if (!existing) {
      merged.push(structuredClone(sourceNode));
      continue;
    }
    existing.children = mergeMenuTrees(existing.children, sourceNode.children);
  }
  return merged;
}
