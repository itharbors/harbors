import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './session/store';
import { SessionManager } from './session/manager';
import { SSEChannel } from './sse/channel';
import { BrowserRequestBroker } from './framework/browser-request-broker';
import type { Editor } from './editor/types';
import { createApp } from './app';
import { createDefaultAssemblyConfig, type AssemblyConfig } from './assembly/config';
import { discoverApplicationPlugins } from './application/catalog';
import { ApplicationRuntime } from './application/runtime';
import type { ApplicationHostMode } from './editor/types';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  defaultKit?: string;
  assembly?: AssemblyConfig;
  applicationHostMode?: ApplicationHostMode;
  applicationControlToken?: string;
  host?: string;
  applicationRuntime?: Pick<
    ApplicationRuntime,
    'start' | 'getBootstrap' | 'triggerMenu' | 'subscribe' | 'dispose'
  >;
}

export function createServer(options: ServerOptions = {}) {
  const dbPath = options.dbPath || ':memory:';
  const store = new SessionStore(dbPath);
  const manager = new SessionManager(store);
  const channel = new SSEChannel();
  const broker = new BrowserRequestBroker();
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const assembly = options.assembly ?? createDefaultAssemblyConfig(
    path.resolve(serverDir, '../../..'),
    { defaultKit: options.defaultKit },
  );
  const applicationRuntime = options.applicationRuntime ?? new ApplicationRuntime({
    hostMode: options.applicationHostMode ?? 'web',
    catalogLoader: () => discoverApplicationPlugins({ assembly }),
  });
  const { handleRequest, registry, editorMap, stopDisconnectHandling } = createApp(manager, channel, {
    assembly,
    applicationRuntime,
    applicationControlToken: options.applicationControlToken,
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
    if (stopping) return Promise.reject(new Error('Editor server is stopping'));
    if (!startPromise) startPromise = startInternal(port);
    return startPromise;
  };

  const startInternal = async (port?: number): Promise<number> => {
    await applicationRuntime.start();
    if (stopping) throw new Error('Editor server is stopping');
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
    if (stopping) throw new Error('Editor server is stopping');
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
