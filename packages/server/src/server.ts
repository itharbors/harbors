import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveCredentialMode,
  type CredentialMode,
} from '@itharbors/host-security';
import { SessionStore } from './session/store';
import { SessionManager } from './session/manager';
import { SSEChannel } from './sse/channel';
import { BrowserRequestBroker } from './framework/browser-request-broker';
import type { Editor } from './editor/types';
import { createApp } from './app';
import {
  createDefaultAssemblyConfig,
  normalizeAssemblyConfig,
  type AssemblyConfig,
  type AssemblyKitSource,
  type KitSourceKind,
} from './assembly/config';
import { discoverApplicationPlugins } from './application/catalog';
import { ApplicationRuntime } from './application/runtime';
import type { ApplicationHostMode } from './editor/types';
import { createLocalCredentialVault, type CredentialVault } from './credentials/vault';

type CredentialVaultRuntime = Pick<CredentialVault, 'bind' | 'capability' | 'recover' | 'close'>;

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  defaultKit?: string;
  kitSources?: AssemblyKitSource[];
  assembly?: AssemblyConfig;
  applicationHostMode?: ApplicationHostMode;
  credentialMode?: string;
  credentialVault?: CredentialVaultRuntime;
  applicationControlToken?: string;
  agentGuardDataDir?: string;
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

export function createServer(options: ServerOptions = {}) {
  const applicationHostMode = options.applicationHostMode ?? 'web';
  const credentialMode: CredentialMode = resolveCredentialMode({
    hostMode: applicationHostMode,
    requested: options.credentialMode,
    bindHost: options.host,
  });
  if (options.agentGuardDataDir !== undefined && !path.isAbsolute(options.agentGuardDataDir)) {
    throw new Error('agentGuardDataDir must be an absolute path');
  }
  if (!options.assembly && (!options.kitSources || options.kitSources.length === 0)) {
    throw new Error('Server requires at least one Kit source');
  }
  if (options.assembly && options.assembly.kitSources.length === 0) {
    throw new Error('Server requires at least one Kit source');
  }
  const dbPath = options.dbPath || ':memory:';
  const credentialVaultPromise: Promise<CredentialVaultRuntime | undefined> = options.credentialVault
    ? Promise.resolve(options.credentialVault)
    : credentialMode === 'local'
      ? createLocalCredentialVault({ dbPath })
      : Promise.resolve(undefined);
  const store = new SessionStore(dbPath);
  const manager = new SessionManager(store);
  const channel = new SSEChannel();
  const broker = new BrowserRequestBroker();
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const assembly = freezeAssemblySnapshot(options.assembly
    ? normalizeAssemblyConfig(options.assembly)
    : createDefaultAssemblyConfig(
        path.resolve(serverDir, '../../..'),
        {
          defaultKit: options.defaultKit,
          kitSources: options.kitSources,
        },
      ));
  let recoveredCredentialVault: CredentialVaultRuntime | undefined;
  const applicationRuntime = options.applicationRuntime ?? new ApplicationRuntime({
    hostMode: applicationHostMode,
    catalogLoader: () => discoverApplicationPlugins({ assembly }),
    credentialMode,
    credentialStatusLoader: async () => (
      (await credentialVaultPromise)?.capability()
      ?? { mode: 'off', status: 'unavailable', reason: 'CREDENTIALS_DISABLED' }
    ),
  });
  const { handleRequest, registry, editorMap, stopDisconnectHandling } = createApp(manager, channel, {
    assembly,
    applicationRuntime,
    applicationControlToken: options.applicationControlToken,
    clientAssetsRoot: options.clientAssetsRoot,
    credentialVault: () => recoveredCredentialVault,
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
    if (credentialMode === 'local') {
      const credentialVault = await credentialVaultPromise;
      await credentialVault?.recover();
      recoveredCredentialVault = credentialVault;
    }
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
      (await credentialVaultPromise)?.close();
      recoveredCredentialVault = undefined;
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
    get credentialMode(): CredentialMode {
      return credentialMode;
    },
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
