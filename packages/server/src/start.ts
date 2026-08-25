import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { createDefaultAssemblyConfig, discoverBuiltinKitSources } from './assembly/config.js';
import { ensureDataDir, resolveStartConfig } from './start-config.js';
import { migrateApplicationData } from './application-data-migration.js';
import { applyStartArgumentsToEnv, parseStartArguments, startHelp } from './start-args.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let startArguments;
try {
  startArguments = parseStartArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(startHelp());
  process.exit(1);
}
if (startArguments.help) {
  console.log(startHelp());
  process.exit(0);
}
const startEnv = applyStartArgumentsToEnv(process.env, startArguments);
const config = resolveStartConfig(rootDir, startEnv);
const { applicationDataDir, configDataDir, dbPath, port, host, pluginPathRoots } = config;

await ensureDataDir(applicationDataDir);
await ensureDataDir(configDataDir);
await ensureDataDir(path.dirname(dbPath));
await migrateApplicationData({
  applicationDataDir,
  dbPath,
  legacyDbPaths: config.legacyDbPaths,
  pluginDataRoot: pluginPathRoots.data,
  legacyPluginDataRoots: config.legacyPluginDataRoots,
});

const server = createServer({
  assembly: createDefaultAssemblyConfig(rootDir, {
    kitSources: await discoverBuiltinKitSources(rootDir),
  }),
  pluginPathRoots,
  configStorageRoots: { 'application-data': configDataDir },
  host,
  port,
  clientAssetsRoot: path.join(rootDir, 'packages', 'client', 'dist'),
  applicationHostMode: 'web',
  credentialMode: process.env.HARBORS_CREDENTIAL_MODE,
  dbPath,
});

const shutdown = async (): Promise<void> => {
  console.log('Shutting down...');
  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

try {
  const actualPort = await server.start(port);
  console.log(`Server running at http://localhost:${actualPort}`);
  console.log(`Application data: ${applicationDataDir}`);
  console.log(`Database: ${dbPath}`);
} catch (error) {
  console.error('Failed to start server:', error);
  process.exit(1);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
