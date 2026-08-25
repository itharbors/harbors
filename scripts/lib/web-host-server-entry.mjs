import path from 'node:path';

import { createDefaultAssemblyConfig } from '../../packages/server/src/assembly/config.ts';
import { createServer } from '../../packages/server/src/server.ts';
import { ensureDataDir, resolveStartConfig } from '../../packages/server/src/start-config.ts';
import { migrateApplicationData } from '../../packages/server/src/application-data-migration.ts';

const rootDir = process.cwd();
const sources = parseSources(process.env.HARBORS_KIT_SOURCES);
const defaultKit = requireValue(process.env.CE_DEFAULT_KIT, 'CE_DEFAULT_KIT');
const config = resolveStartConfig(rootDir, process.env);
if (!process.env.HARBORS_DATA_ROOT) throw new Error('HARBORS_DATA_ROOT is required');

const pluginPathRoots = config.pluginPathRoots;
const configStorageRoots = { 'application-data': config.configDataDir };
await Promise.all([
  ...Object.values(pluginPathRoots).map((directory) => ensureDataDir(directory)),
  ensureDataDir(configStorageRoots['application-data']),
  ensureDataDir(path.dirname(config.dbPath)),
]);
await migrateApplicationData({
  applicationDataDir: config.applicationDataDir,
  dbPath: config.dbPath,
  legacyDbPaths: config.legacyDbPaths,
  pluginDataRoot: config.pluginPathRoots.data,
  legacyPluginDataRoots: config.legacyPluginDataRoots,
});

const server = createServer({
  assembly: createDefaultAssemblyConfig(rootDir, { kitSources: sources, defaultKit }),
  pluginPathRoots,
  configStorageRoots,
  clientAssetsRoot: path.join(rootDir, 'packages', 'client', 'dist'),
  applicationHostMode: 'web',
  credentialMode: process.env.HARBORS_CREDENTIAL_MODE,
  ...(process.env.HARBORS_CREDENTIAL_MODE === 'on' ? { credentialVault: createMemoryCredentialVault() } : {}),
  dbPath: config.dbPath,
  host: process.env.HARBORS_BIND_HOST ?? '127.0.0.1',
});

const shutdown = async (code = 0) => {
  try {
    await server.stop();
  } finally {
    process.exit(code);
  }
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  const port = await server.start(Number(process.env.PORT));
  console.log(`Web Host Server running at http://127.0.0.1:${port}`);
} catch (error) {
  console.error('Web Host Server failed to start:', error);
  await shutdown(1);
}

function parseSources(value) {
  if (!value) throw new Error('HARBORS_KIT_SOURCES is required');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('HARBORS_KIT_SOURCES must be valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('HARBORS_KIT_SOURCES must be a non-empty array');
  return parsed;
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createMemoryCredentialVault() {
  const records = new Map();
  return {
    capability: () => ({ mode: 'on', status: 'available' }),
    async recover() {},
    async close() {},
    bind: () => ({
      capability: () => ({ mode: 'on', status: 'available' }),
      async available() { return true; },
      async put(input) {
        const id = input.id ?? 'web-host-credential';
        records.set(id, input.secret);
        return { id };
      },
      async get(id) {
        if (!records.has(id)) throw new Error('credential not found');
        return { profile: { id }, secret: records.get(id) };
      },
      async delete(id) { records.delete(id); },
      async list() { return []; },
    }),
  };
}
