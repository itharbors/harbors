import { createDefaultAssemblyConfig } from '../../server/src/assembly/config.ts';
import { createServer } from '../../server/src/server.ts';
import {
  runDesktopFrameworkProcess,
} from '../../../scripts/lib/desktop-framework.mjs';

function send(message) {
  process.send?.(message);
}

function subscribeShutdown(shutdown) {
  const onSignal = () => shutdown();
  const onMessage = (message) => {
    if (message?.type === 'shutdown') shutdown();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.on('message', onMessage);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('message', onMessage);
  };
}

function exit() {
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

await runDesktopFrameworkProcess({
  env: process.env,
  createAssembly: createDefaultAssemblyConfig,
  createServer,
  send,
  subscribeShutdown,
  exit,
});
