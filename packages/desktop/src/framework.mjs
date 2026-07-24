import { createDefaultAssemblyConfig } from '../../server/src/assembly/config.ts';
import { createServer } from '../../server/src/server.ts';
import {
  createFrameworkProcessController,
  parseDesktopFrameworkEnvironment,
} from '../../../scripts/lib/desktop-framework.mjs';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function send(message) {
  process.send?.(message);
}

let shutdownPromise;

async function main() {
  const environment = parseDesktopFrameworkEnvironment(process.env);
  const assembly = createDefaultAssemblyConfig(environment.runtimeRoot, {
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
  const shutdown = () => {
    shutdownPromise ??= controller.stop();
    return shutdownPromise;
  };

  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.on('message', (message) => {
    if (message?.type === 'shutdown') void shutdown();
  });

  await controller.start();
}

try {
  await main();
} catch (error) {
  send({ type: 'fatal', message: errorMessage(error) });
  process.exitCode = 1;
}
