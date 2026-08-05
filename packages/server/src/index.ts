import path from 'node:path';
import { createServer, parseKitSources } from './server';
import { startServerUntilShutdown } from './process-lifecycle';
import { captureApplicationHostSecrets } from './application/host-environment';
import { resolveApplicationPluginRunner } from './application/plugin-process/spawn';

const APPLICATION_HOST_SECRETS = captureApplicationHostSecrets(process.env);

const PORT = parseInt(process.env.PORT || '48381', 10);
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), '.editor.db');
const APPLICATION_DATA_ROOT = path.dirname(DB_PATH);
const DEFAULT_KIT = process.env.CE_DEFAULT_KIT || process.env.KIT || process.env.DEFAULT_KIT;

const APPLICATION_HOST_MODE = process.env.HARBORS_HOST_MODE === 'desktop' ? 'desktop' : 'web';
const HOST = process.env.HARBORS_BIND_HOST;

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
  pluginPathRoots: {
    applicationData: APPLICATION_DATA_ROOT,
    data: process.env.HARBORS_PLUGIN_DATA_ROOT
      ?? path.join(APPLICATION_DATA_ROOT, 'plugins', 'data'),
    cache: process.env.HARBORS_PLUGIN_CACHE_ROOT
      ?? path.join(APPLICATION_DATA_ROOT, 'plugins', 'cache'),
    temp: process.env.HARBORS_PLUGIN_TEMP_ROOT
      ?? path.join(APPLICATION_DATA_ROOT, 'plugins', 'temp'),
  },
  host: HOST,
});

const port = await startServerUntilShutdown(() => start(PORT), stop);
if (port !== undefined) {
  console.log(`Editor server running on http://localhost:${port}`);
  console.log(`Database: ${DB_PATH}`);
  if (DEFAULT_KIT) {
    console.log(`Session fallback Kit: ${DEFAULT_KIT}`);
  }
}
