import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { createDefaultAssemblyConfig } from '../../packages/server/src/assembly/config.ts';
import { createServer } from '../../packages/server/src/server.ts';

const rootDir = process.cwd();
const tempRoot = process.env.HARBORS_TEST_DATA_ROOT;
const sources = parseSources(process.env.HARBORS_KIT_SOURCES);
const defaultKit = requireValue(process.env.CE_DEFAULT_KIT, 'CE_DEFAULT_KIT');
if (!tempRoot) throw new Error('HARBORS_TEST_DATA_ROOT is required');

const pluginPathRoots = {
  applicationData: path.join(tempRoot, 'application-data'),
  data: path.join(tempRoot, 'plugins', 'data'),
  cache: path.join(tempRoot, 'plugins', 'cache'),
  temp: path.join(tempRoot, 'plugins', 'temp'),
};
const configStorageRoots = { 'application-data': path.join(tempRoot, 'config') };
await Promise.all([
  ...Object.values(pluginPathRoots).map((directory) => mkdir(directory, { recursive: true })),
  mkdir(configStorageRoots['application-data'], { recursive: true }),
]);

const server = createServer({
  assembly: createDefaultAssemblyConfig(rootDir, { kitSources: sources, defaultKit }),
  pluginPathRoots,
  configStorageRoots,
  clientAssetsRoot: path.join(rootDir, 'packages', 'client', 'dist'),
  applicationHostMode: 'web',
  credentialMode: process.env.HARBORS_CREDENTIAL_MODE,
  ...(process.env.HARBORS_CREDENTIAL_MODE === 'on' ? { credentialVault: createMemoryCredentialVault() } : {}),
  dbPath: process.env.DB_PATH,
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
