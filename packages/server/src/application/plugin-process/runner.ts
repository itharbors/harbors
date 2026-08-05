import { runApplicationPluginRunner } from './runner-host.js';
import type { PluginProcessEnvelope } from './protocol.js';

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
      process.send?.(envelope);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  exit: ({ failed }) => process.exit(failed ? 1 : 0),
  timers: {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});

process.once('uncaughtException', (error) => { void runner.fatal(error); });
process.once('unhandledRejection', (reason) => { void runner.fatal(reason); });
process.once('disconnect', () => { void runner.disconnect(); });
process.once('SIGINT', () => { void runner.fatal(new Error('Application plugin runner received SIGINT')); });
process.once('SIGTERM', () => { void runner.fatal(new Error('Application plugin runner received SIGTERM')); });
