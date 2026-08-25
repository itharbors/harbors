import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, parseKitSources } from './server';
import { startServerUntilShutdown } from './process-lifecycle';
import { captureApplicationHostSecrets } from './application/host-environment';
import { resolveApplicationPluginRunner } from './application/plugin-process/spawn';
import { ensureDataDir, resolveStartConfig } from './start-config';
import { migrateApplicationData } from './application-data-migration';

const APPLICATION_HOST_SECRETS = captureApplicationHostSecrets(process.env);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const START_CONFIG = resolveStartConfig(REPOSITORY_ROOT, process.env);
const { applicationDataDir: APPLICATION_DATA_ROOT, dbPath: DB_PATH, pluginPathRoots: PLUGIN_PATH_ROOTS } = START_CONFIG;
const DEFAULT_KIT = process.env.CE_DEFAULT_KIT || process.env.KIT || process.env.DEFAULT_KIT;

const APPLICATION_HOST_MODE = process.env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web';
const HOST = process.env.HARBORS_BIND_HOST;

await ensureDataDir(APPLICATION_DATA_ROOT);
await ensureDataDir(path.dirname(DB_PATH));
await migrateApplicationData({
  applicationDataDir: APPLICATION_DATA_ROOT,
  dbPath: DB_PATH,
  legacyDbPaths: START_CONFIG.legacyDbPaths,
  pluginDataRoot: PLUGIN_PATH_ROOTS.data,
  legacyPluginDataRoots: START_CONFIG.legacyPluginDataRoots,
});

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
  configStorageRoots: { 'application-data': APPLICATION_DATA_ROOT },
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
