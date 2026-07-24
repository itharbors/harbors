import path from 'node:path';

function requireAbsolutePath(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function parseInstalledKitDirs(value) {
  const message = 'HARBORS_INSTALLED_KITS must be a JSON array of non-empty absolute paths';
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(message);
  }
  if (!Array.isArray(parsed)
    || parsed.some((item) => typeof item !== 'string' || item.length === 0 || !path.isAbsolute(item))) {
    throw new Error(message);
  }
  return Object.freeze([...parsed]);
}

function parseNotificationPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HARBORS_NOTIFICATION_PORT must be an integer from 1 through 65535');
  }
  return port;
}

export function parseDesktopFrameworkEnvironment(env) {
  const applicationControlToken = env.HARBORS_APPLICATION_TOKEN;
  if (typeof applicationControlToken !== 'string' || applicationControlToken.trim().length === 0) {
    throw new Error('HARBORS_APPLICATION_TOKEN must be a non-empty string');
  }

  return Object.freeze({
    runtimeRoot: requireAbsolutePath(env, 'HARBORS_RUNTIME_ROOT'),
    clientAssetsRoot: requireAbsolutePath(env, 'HARBORS_CLIENT_ASSETS_ROOT'),
    dbPath: requireAbsolutePath(env, 'HARBORS_DB_PATH'),
    installedKitDirs: parseInstalledKitDirs(env.HARBORS_INSTALLED_KITS),
    notificationPort: parseNotificationPort(env.HARBORS_NOTIFICATION_PORT),
    applicationControlToken,
    host: '127.0.0.1',
    port: 0,
  });
}

export function createFrameworkProcessController({ send, start, stop }) {
  let startPromise;
  let stopPromise;
  return {
    start() {
      startPromise ??= Promise.resolve(start()).then((port) => {
        send?.({ type: 'ready', port });
        return port;
      });
      return startPromise;
    },
    stop() {
      stopPromise ??= Promise.resolve(startPromise).catch(() => undefined).then(() => stop());
      return stopPromise;
    },
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runDesktopFrameworkProcess({
  env,
  createAssembly,
  createServer,
  send,
  subscribeShutdown,
  exit,
}) {
  let shutdown;
  let unsubscribeShutdown;
  const fail = async (error) => {
    try {
      await shutdown?.();
    } catch {
      // Preserve the startup failure as the fatal IPC message.
    }
    unsubscribeShutdown?.();
    send?.({ type: 'fatal', message: errorMessage(error) });
    exit?.();
  };

  try {
    const environment = parseDesktopFrameworkEnvironment(env);
    const assembly = createAssembly(environment.runtimeRoot, {
      installedKitDirs: environment.installedKitDirs,
    });
    const framework = createServer({
      assembly,
      clientAssetsRoot: environment.clientAssetsRoot,
      dbPath: environment.dbPath,
      host: environment.host,
      port: environment.port,
      applicationHostMode: 'desktop',
      applicationControlToken: environment.applicationControlToken,
    });
    const controller = createFrameworkProcessController({
      send,
      start: () => framework.start(),
      stop: () => framework.stop(),
    });
    shutdown = () => controller.stop();
    unsubscribeShutdown = subscribeShutdown?.(() => { void shutdown().catch(fail); });
    return await controller.start();
  } catch (error) {
    await fail(error);
    return undefined;
  }
}
