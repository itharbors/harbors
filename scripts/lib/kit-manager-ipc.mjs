const KIT_ID_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const registrations = new WeakMap();

export const KIT_MANAGER_CHANNELS = Object.freeze({
  list: 'harbors:kit-manager:list',
  refresh: 'harbors:kit-manager:refresh',
  install: 'harbors:kit-manager:install',
  activate: 'harbors:kit-manager:activate',
  rollback: 'harbors:kit-manager:rollback',
});

class IpcInputError extends Error {}

function exactObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcInputError();
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new IpcInputError();
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !KIT_ID_PATTERN.test(value)) throw new IpcInputError();
  return value;
}

function version(value) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) throw new IpcInputError();
  return value;
}

function parseNoArgs(args) {
  if (args.length !== 0) throw new IpcInputError();
}

function parseInstall(args) {
  if (args.length !== 1) throw new IpcInputError();
  const value = exactObject(args[0], ['id', 'version', 'channel']);
  if (!['stable', 'preview'].includes(value.channel)) throw new IpcInputError();
  return { id: id(value.id), version: version(value.version), channel: value.channel };
}

function parseActivate(args) {
  if (args.length !== 1) throw new IpcInputError();
  const value = exactObject(args[0], ['id', 'version', 'retryBad']);
  if (value.retryBad !== undefined && typeof value.retryBad !== 'boolean') throw new IpcInputError();
  return {
    id: id(value.id),
    version: version(value.version),
    ...(value.retryBad === undefined ? {} : { retryBad: value.retryBad }),
  };
}

function parseRollback(args) {
  if (args.length !== 1) throw new IpcInputError();
  return id(args[0]);
}

function serializeError(error) {
  if (error instanceof IpcInputError) {
    return { code: 'INVALID_INPUT', message: 'Invalid Kit Manager request' };
  }
  if (
    typeof error?.code === 'string'
    && CODE_PATTERN.test(error.code)
    && typeof error.message === 'string'
    && error.message.length > 0
    && error.message.length <= 240
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: 'OPERATION_FAILED', message: 'Kit Manager operation failed' };
}

function ownsSender(event, getManagerWindow) {
  const window = getManagerWindow();
  return Boolean(
    window
    && !window.isDestroyed()
    && event?.sender?.id === window.webContents?.id,
  );
}

export function registerKitManagerIpc({ ipcMain, getManagerWindow, service }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') {
    throw new TypeError('ipcMain is required');
  }
  if (typeof getManagerWindow !== 'function') throw new TypeError('getManagerWindow is required');
  if (!service || typeof service !== 'object') throw new TypeError('Kit Manager service is required');
  registrations.get(ipcMain)?.unregister();

  const operations = {
    list: { parse: parseNoArgs, invoke: () => service.list() },
    refresh: { parse: parseNoArgs, invoke: () => service.refresh() },
    install: { parse: parseInstall, invoke: (value) => service.install(value) },
    activate: { parse: parseActivate, invoke: (value) => service.activate(value) },
    rollback: { parse: parseRollback, invoke: (value) => service.rollback(value) },
  };
  const inFlight = new Set();
  let active = true;
  let registration;
  for (const [name, channel] of Object.entries(KIT_MANAGER_CHANNELS)) {
    const operation = operations[name];
    ipcMain.handle(channel, (event, ...args) => {
      const invocation = (async () => {
        if (!ownsSender(event, getManagerWindow)) {
          return {
            ok: false,
            error: { code: 'FORBIDDEN', message: 'Kit Manager request was rejected' },
          };
        }
        try {
          const input = operation.parse(args);
          return { ok: true, value: await operation.invoke(input) };
        } catch (error) {
          return { ok: false, error: serializeError(error) };
        }
      })();
      inFlight.add(invocation);
      invocation.finally(() => inFlight.delete(invocation));
      return invocation;
    });
  }
  registration = {
    unregister() {
      if (!active || registrations.get(ipcMain) !== registration) return;
      active = false;
      for (const channel of Object.values(KIT_MANAGER_CHANNELS)) ipcMain.removeHandler(channel);
      registrations.delete(ipcMain);
    },
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
  registrations.set(ipcMain, registration);
  return registration;
}
