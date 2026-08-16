import path from 'node:path';
import { createServer } from './server.js';
import { createDefaultAssemblyConfig } from './assembly/config.js';
import { ensureDataDir, resolveStartConfig } from './start-config.js';

const rootDir = process.cwd();
const defaultKitDir = path.join(rootDir, 'kits', 'default');
const { dataDir, dbPath, port, host } = resolveStartConfig(rootDir, process.env);

await ensureDataDir(dataDir);
await ensureDataDir(path.dirname(dbPath));

const server = createServer({
  assembly: createDefaultAssemblyConfig(rootDir, {
    kitSources: [{ directory: defaultKitDir, source: 'builtin' }],
  }),
  pluginPathRoots: {
    applicationData: dataDir,
    data: path.join(dataDir, 'plugins'),
    cache: path.join(dataDir, 'cache'),
    temp: path.join(dataDir, 'temp'),
  },
  host,
  port,
  clientAssetsRoot: path.join(rootDir, 'packages', 'client', 'dist'),
  dbPath,
  applicationHostMode: 'web',
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
} catch (error) {
  console.error('Failed to start server:', error);
  process.exit(1);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
