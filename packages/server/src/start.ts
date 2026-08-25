import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { createDefaultAssemblyConfig, discoverBuiltinKitSources } from './assembly/config.js';
import { ensureDataDir, resolveStartConfig } from './start-config.js';
import { migrateApplicationData } from './application-data-migration.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const config = resolveStartConfig(rootDir, process.env);
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
