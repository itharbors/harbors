import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './session/store';
import { SessionManager } from './session/manager';
import { SSEChannel } from './sse/channel';
import { BrowserRequestBroker } from './framework/browser-request-broker';
import type { Editor } from './editor/types';
import { createApp } from './app';
import {
  createDefaultAssemblyConfig,
  normalizeAssemblyConfig,
  resolveDefaultKitFromSources,
  type AssemblyConfig,
  type AssemblyKitSource,
  type KitSourceKind,
} from './assembly/config';
import { discoverApplicationPlugins } from './application/catalog';
import { ApplicationRuntime } from './application/runtime';
import type { ApplicationHostMode } from './editor/types';
import type { PluginPathRoots } from './framework/plugin/paths';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  defaultKit?: string;
  kitSources?: AssemblyKitSource[];
  assembly?: AssemblyConfig;
  applicationHostMode?: ApplicationHostMode;
  applicationControlToken?: string;
  notificationPort?: number;
  pluginPathRoots: PluginPathRoots;
  clientAssetsRoot?: string;
  host?: string;
  applicationRuntime?: Pick<
    ApplicationRuntime,
    'start' | 'getBootstrap' | 'request' | 'triggerMenu' | 'subscribe' | 'dispose'
  >;
}

export const SERVER_STOPPING_ERROR_CODE = 'HARBORS_SERVER_STOPPING';

export class ServerStoppingError extends Error {
  readonly code = SERVER_STOPPING_ERROR_CODE;

  constructor() {
    super('Editor server is stopping');
    this.name = 'ServerStoppingError';
  }
}

const KIT_SOURCE_KINDS = new Set<KitSourceKind>([
  'builtin', 'installed', 'development', 'explicit',
]);

export function parseKitSources(value: string | undefined): AssemblyKitSource[] {
  const message = 'HARBORS_KIT_SOURCES must be a JSON array of exact source objects with unique absolute paths';
  if (value === undefined) throw new Error(message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(message);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(message);
  const seen = new Set<string>();
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(message);
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'directory,source'
      || typeof record.directory !== 'string' || !path.isAbsolute(record.directory)
      || typeof record.source !== 'string' || !KIT_SOURCE_KINDS.has(record.source as KitSourceKind)) {
      throw new Error(message);
    }
    const directory = path.resolve(record.directory);
    if (seen.has(directory)) throw new Error(message);
    seen.add(directory);
    return { directory, source: record.source as KitSourceKind };
  });
}

export function createServer(options: ServerOptions) {
  if (!options.assembly && (!options.kitSources || options.kitSources.length === 0)) {
    throw new Error('Server requires at least one Kit source');
  }
  if (options.assembly && options.assembly.kitSources.length === 0) {
    throw new Error('Server requires at least one Kit source');
  }
  const pluginPathRoots = requirePluginPathRoots(options.pluginPathRoots);
  const dbPath = options.dbPath || ':memory:';
  const store = new SessionStore(dbPath);
  const manager = new SessionManager(store);
  const channel = new SSEChannel();
  const broker = new BrowserRequestBroker();
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const configuredAssembly = options.assembly
    ? normalizeAssemblyConfig(options.assembly)
    : createDefaultAssemblyConfig(
        path.resolve(serverDir, '../../..'),
        {
          defaultKit: options.defaultKit,
          kitSources: options.kitSources,
        },
      );
  if (!configuredAssembly.defaultKit) {
    configuredAssembly.defaultKit = resolveDefaultKitFromSources(configuredAssembly.kitSources);
  }
  const assembly = freezeAssemblySnapshot(configuredAssembly);
  const applicationRuntime = options.applicationRuntime ?? new ApplicationRuntime({
    hostMode: options.applicationHostMode ?? 'web',
    catalogLoader: () => discoverApplicationPlugins({ assembly }),
    pluginPathRoots,
    notificationPort: options.notificationPort,
    notificationOwnerAuthToken: options.applicationControlToken,
  });
  const { handleRequest, registry, editorMap, stopDisconnectHandling } = createApp(manager, channel, {
    assembly,
    applicationRuntime,
    applicationControlToken: options.applicationControlToken,
    clientAssetsRoot: options.clientAssetsRoot,
    pluginPathRoots,
  }, broker);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('Unhandled error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  let startPromise: Promise<number> | undefined;
  let stopping = false;
  const start = (port?: number): Promise<number> => {
    if (stopping) return Promise.reject(new ServerStoppingError());
    if (!startPromise) startPromise = startInternal(port);
    return startPromise;
  };

  const startInternal = async (port?: number): Promise<number> => {
    await applicationRuntime.start();
    if (stopping) throw new ServerStoppingError();
    const listeningPort = await new Promise<number>((resolve, reject) => {
      const p = port || options.port || 0;
      server.listen(p, options.host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          resolve(p);
        }
      });
      server.once('error', reject);
    });
    if (stopping) throw new ServerStoppingError();
    return listeningPort;
  };

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = stopInternal();
    return stopPromise;
  };

  const stopInternal = async (): Promise<void> => {
    const errors: unknown[] = [];
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        // Startup reports its own failure; shutdown still owns resource cleanup.
      }
    }
    const closePromise = server.listening
      ? new Promise<void>((resolve) => {
          server.close((error) => {
            if (error) errors.push(error);
            resolve();
          });
        })
      : Promise.resolve();
    try {
      await registry.disposeAll();
    } catch (error) {
      errors.push(error);
    }
    try {
      await applicationRuntime.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      channel.closeAll();
    } catch (error) {
      errors.push(error);
    }
    stopDisconnectHandling();
    try {
      broker.destroy();
    } catch (error) {
      errors.push(error);
    }
    try {
      store.close();
    } catch (error) {
      errors.push(error);
    }
    server.closeIdleConnections();
    await closePromise;
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Server shutdown failed');
    }
  };

  return {
    server,
    start,
    stop,
    manager,
    channel,
    broker,
    registry,
    editorMap,
    applicationRuntime,
  };
}

function requirePluginPathRoots(roots: PluginPathRoots): PluginPathRoots {
  if (!roots || typeof roots !== 'object') {
    throw new Error('pluginPathRoots is required');
  }
  for (const [name, value] of Object.entries(roots)) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error(`pluginPathRoots.${name} must be an absolute path`);
    }
  }
  for (const name of ['applicationData', 'data', 'cache', 'temp'] as const) {
    if (!Object.hasOwn(roots, name)) throw new Error(`pluginPathRoots.${name} is required`);
  }
  return Object.freeze({
    applicationData: path.resolve(roots.applicationData),
    data: path.resolve(roots.data),
    cache: path.resolve(roots.cache),
    temp: path.resolve(roots.temp),
  });
}

function freezeAssemblySnapshot(assembly: AssemblyConfig): AssemblyConfig {
  const kitSources = Object.freeze(assembly.kitSources.map((source) => Object.freeze({
    directory: source.directory,
    source: source.source,
  })));
  return Object.freeze({
    ...assembly,
    kitSources,
  }) as AssemblyConfig;
}
