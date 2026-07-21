import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './session/store';
import { SessionManager } from './session/manager';
import { SSEChannel } from './sse/channel';
import { BrowserRequestBroker } from './framework/browser-request-broker';
import type { Editor } from './editor/types';
import { createApp } from './app';
import { createDefaultAssemblyConfig } from './assembly/config';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  defaultKit?: string;
}

export function createServer(options: ServerOptions = {}) {
  const dbPath = options.dbPath || ':memory:';
  const store = new SessionStore(dbPath);
  const manager = new SessionManager(store);
  const channel = new SSEChannel();
  const broker = new BrowserRequestBroker();
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const assembly = createDefaultAssemblyConfig(path.resolve(serverDir, '../../..'), {
    defaultKit: options.defaultKit,
  });
  const { handleRequest, registry, editorMap, stopDisconnectHandling } = createApp(manager, channel, {
    assembly,
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

  const start = (port?: number): Promise<number> => {
    return new Promise((resolve, reject) => {
      const p = port || options.port || 0;
      server.listen(p, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          resolve(p);
        }
      });
      server.once('error', reject);
    });
  };

  const stop = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await registry.disposeAll();
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Server shutdown failed');
    }
  };

  return { server, start, stop, manager, channel, broker, registry, editorMap };
}
