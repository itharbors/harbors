import { formatNotificationKitLabel } from './notification-desktop.mjs';

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

  return requestedKit
    ? { mode: 'single', requestedKit }
    : { mode: 'multi', requestedKit: null };
}

export function createFrameworkArgs(args) {
  return [
    'run',
    'dev:web',
    ...(args.length > 0 ? ['--', ...args] : []),
  ];
}

export function createKitWindowUrl(startUrl, kit, workspace, mode) {
  const url = new URL(startUrl);
  url.searchParams.set('session', workspace.sessionId);
  url.searchParams.set('kit', kit.directory);
  url.searchParams.set('menuMode', mode);
  return url.href;
}

export function buildTrayTemplate({
  kits,
  workspaceRecords,
  unreadCount = 0,
  notificationKitName = null,
}, adapters) {
  const availableNames = new Set(kits.map((kit) => kit.name));
  const availableEntries = kits.map((kit) => ({
    label: kit.name === notificationKitName
      ? formatNotificationKitLabel(kit.label, unreadCount)
      : kit.label,
    enabled: true,
    click: () => adapters.openKit(kit.name),
  }));
  const unavailableEntries = workspaceRecords
    .filter((record) => record.available === false && !availableNames.has(record.kitName))
    .map((record) => ({
      label: `${record.kitName} (Unavailable)`,
      enabled: false,
    }));

  return [
    ...availableEntries,
    ...unavailableEntries,
    { type: 'separator' },
    { label: 'Quit ITHARBORS', click: () => adapters.quit() },
  ];
}

export async function openOrFocusKitWindow(kitName, registry, createWindow) {
  let window = registry.get(kitName);
  if (!window || window.isDestroyed()) {
    window = await createWindow(kitName);
    registry.set(kitName, window);
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  return window;
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
