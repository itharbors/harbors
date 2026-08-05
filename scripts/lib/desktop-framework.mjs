import path from 'node:path';

const SERVER_STOPPING_ERROR_CODE = 'HARBORS_SERVER_STOPPING';

function requireAbsolutePath(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

const KIT_SOURCE_KINDS = new Set(['builtin', 'installed', 'development', 'explicit']);

function parseKitSources(value) {
  const message = 'HARBORS_KIT_SOURCES must be a JSON array of exact source objects with unique absolute paths';
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(message);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(message);
  }
  const seen = new Set();
  const sources = parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'directory,source'
      || typeof item.directory !== 'string' || !path.isAbsolute(item.directory)
      || !KIT_SOURCE_KINDS.has(item.source)
      || seen.has(path.resolve(item.directory))) {
      throw new Error(message);
    }
    const directory = path.resolve(item.directory);
    seen.add(directory);
    return Object.freeze({ directory, source: item.source });
  });
  return Object.freeze(sources);
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
    pluginDataRoot: requireAbsolutePath(env, 'HARBORS_PLUGIN_DATA_ROOT'),
    pluginCacheRoot: requireAbsolutePath(env, 'HARBORS_PLUGIN_CACHE_ROOT'),
    pluginTempRoot: requireAbsolutePath(env, 'HARBORS_PLUGIN_TEMP_ROOT'),
    kitSources: parseKitSources(env.HARBORS_KIT_SOURCES),
    notificationPort: parseNotificationPort(env.HARBORS_NOTIFICATION_PORT),
    applicationControlToken,
    host: '0.0.0.0',
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

function isServerStoppingError(error) {
  return typeof error === 'object'
    && error !== null
    && error.code === SERVER_STOPPING_ERROR_CODE;
}

export async function runDesktopFrameworkProcess({
  env,
  applicationPluginProcess,
  createAssembly,
  createServer,
  send,
  subscribeShutdown,
  exit,
}) {
  let controller;
  let unsubscribeShutdown;
  let finalizationPromise;
  let failure;
  let hasFailure = false;
  let shutdownRequested = false;
  const recordFailure = (error) => {
    if (!hasFailure) {
      failure = error;
      hasFailure = true;
    }
  };
  const finalize = (error) => {
    if (error !== undefined) {
      recordFailure(error);
    }
    finalizationPromise ??= (async () => {
      try {
        await controller?.stop();
      } catch (stopError) {
        recordFailure(stopError);
      }
      try {
        unsubscribeShutdown?.();
      } catch (unsubscribeError) {
        recordFailure(unsubscribeError);
      }
      try {
        if (hasFailure) {
          send?.({ type: 'fatal', message: errorMessage(failure) });
        }
      } finally {
        exit?.({ failed: hasFailure });
      }
    })();
    return finalizationPromise;
  };
  const requestShutdown = () => {
    shutdownRequested = true;
    return finalize();
  };

  try {
    const environment = parseDesktopFrameworkEnvironment(env);
    const assembly = createAssembly(environment.runtimeRoot, {
      kitSources: environment.kitSources,
    });
    const framework = createServer({
      assembly,
      clientAssetsRoot: environment.clientAssetsRoot,
      dbPath: environment.dbPath,
      pluginPathRoots: {
        applicationData: path.dirname(environment.dbPath),
        data: environment.pluginDataRoot,
        cache: environment.pluginCacheRoot,
        temp: environment.pluginTempRoot,
      },
      host: environment.host,
      port: environment.port,
      applicationHostMode: 'desktop',
      applicationControlToken: environment.applicationControlToken,
      applicationPluginProcess,
    });
    controller = createFrameworkProcessController({
      send,
      start: () => framework.start(),
      stop: () => framework.stop(),
    });
    unsubscribeShutdown = subscribeShutdown?.(requestShutdown);
    return await controller.start();
  } catch (error) {
    await finalize(shutdownRequested && isServerStoppingError(error) ? undefined : error);
    return undefined;
  }
}
