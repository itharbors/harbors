import path from 'node:path';
import { createServer, parseKitSources } from './server';
import { startServerUntilShutdown } from './process-lifecycle';
import { captureApplicationHostSecrets } from './application/host-environment';
import { resolveApplicationPluginRunner } from './application/plugin-process/spawn';
import { ensureDataDir, resolveStartConfig } from './start-config';

const APPLICATION_HOST_SECRETS = captureApplicationHostSecrets(process.env);
const START_CONFIG = resolveStartConfig(process.env);
const {
  applicationDataDir: APPLICATION_DATA_ROOT,
  configDataDir: CONFIG_DATA_ROOT,
  dbPath: DB_PATH,
  pluginPathRoots: PLUGIN_PATH_ROOTS,
} = START_CONFIG;
const DEFAULT_KIT = process.env.CE_DEFAULT_KIT || process.env.KIT || process.env.DEFAULT_KIT;

const APPLICATION_HOST_MODE = process.env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web';
const HOST = process.env.HARBORS_BIND_HOST;

await ensureDataDir(APPLICATION_DATA_ROOT);
await ensureDataDir(CONFIG_DATA_ROOT);
await ensureDataDir(path.dirname(DB_PATH));
const { start, stop } = createServer({
  dbPath: DB_PATH,
  defaultKit: DEFAULT_KIT,
  kitSources: parseKitSources(process.env.HARBORS_KIT_SOURCES),
  applicationHostMode: APPLICATION_HOST_MODE,
  credentialMode: process.env.HARBORS_CREDENTIAL_MODE,
  applicationControlToken: APPLICATION_HOST_SECRETS.applicationControlToken,
  notificationPort: APPLICATION_HOST_SECRETS.notificationPort,
  applicationPluginProcess: {
    runner: resolveApplicationPluginRunner(),
    cwd: process.cwd(),
    env: process.env,
  },
  pluginPathRoots: PLUGIN_PATH_ROOTS,
  configStorageRoots: { 'application-data': CONFIG_DATA_ROOT },
  host: HOST,
});

const port = await startServerUntilShutdown(() => start(START_CONFIG.port), stop);
if (port !== undefined) {
  console.log(`Editor server running on http://localhost:${port}`);
  console.log(`Application data: ${APPLICATION_DATA_ROOT}`);
  console.log(`Database: ${DB_PATH}`);
  if (DEFAULT_KIT) {
    console.log(`Session fallback Kit: ${DEFAULT_KIT}`);
  }
}
