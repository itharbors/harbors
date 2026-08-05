import { runApplicationPluginRunner } from './runner-host.js';
import type { PluginProcessEnvelope } from './protocol.js';
import { normalizePluginProcessError } from './error.js';

const IPC_SEND_TIMEOUT_MS = 2_000;

if (typeof process.send !== 'function') {
  process.exit(1);
}

const listeners = new Set<(input: unknown) => void>();
const onMessage = (message: unknown) => {
  for (const listener of [...listeners]) listener(message);
};
process.on('message', onMessage);

const runner = runApplicationPluginRunner({
  transport: {
    send(envelope: PluginProcessEnvelope) {
      return new Promise<void>((resolve, reject) => {
        if (!process.connected || typeof process.send !== 'function') {
          reject(new Error('Application plugin IPC parent is disconnected'));
          return;
        }
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Application plugin IPC send timed out'));
        }, IPC_SEND_TIMEOUT_MS);
        const complete = (error: Error | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        try {
          process.send(envelope, complete);
        } catch (error) {
          complete(normalizePluginProcessError(error));
        }
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (process.connected) process.disconnect();
    },
  },
  exit: ({ failed }) => process.exit(failed ? 1 : 0),
  timers: {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});

process.on('uncaughtException', (error) => { void runner.fatal(error); });
process.on('unhandledRejection', (reason) => { void runner.fatal(reason); });
process.on('disconnect', () => { void runner.disconnect(); });
process.on('SIGINT', () => { void runner.fatal(new Error('Application plugin runner received SIGINT')); });
process.on('SIGTERM', () => { void runner.fatal(new Error('Application plugin runner received SIGTERM')); });
