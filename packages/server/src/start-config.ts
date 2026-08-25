import path from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { PluginPathRoots } from '@itharbors/magnet';

export interface StartEnv {
  DB_PATH?: string;
  PORT?: string;
  HARBORS_SERVER_PORT?: string;
  HARBORS_BIND_HOST?: string;
  HARBORS_PLUGIN_DATA_ROOT?: string;
  HARBORS_PLUGIN_CACHE_ROOT?: string;
  HARBORS_PLUGIN_TEMP_ROOT?: string;
}

export interface StartConfig {
  applicationDataDir: string;
  configDataDir: string;
  dbPath: string;
  legacyDbPaths: readonly string[];
  legacyPluginDataRoots: readonly string[];
  pluginPathRoots: PluginPathRoots;
  port: number;
  host: string;
}

const DEFAULT_PORT = 48381;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DB_FILENAME = 'harbors.db';

/**
 * Resolve the Web host startup configuration from the repository and user home.
 *
 * The database path follows this priority:
 * 1. `DB_PATH` environment variable (resolved to an absolute path).
 * 2. A stable file inside the user application data root: `~/.harbors/harbors.db`.
 *
 * `DB_PATH` only moves the Server database. Plugin and Kit data keep using the
 * stable application data root unless their explicit roots are overridden.
 */
export function resolveStartConfig(
  repositoryRoot: string,
  env: StartEnv = process.env,
  homeDirectory: string = homedir(),
): StartConfig {
  const applicationDataDir = path.join(homeDirectory, '.harbors');
  const explicitDbPath = env.DB_PATH?.trim();
  const dbPath = explicitDbPath
    ? path.resolve(explicitDbPath)
    : path.join(applicationDataDir, DEFAULT_DB_FILENAME);
  const pluginPathRoots = {
    applicationData: applicationDataDir,
    data: absoluteOverride(env.HARBORS_PLUGIN_DATA_ROOT, path.join(applicationDataDir, 'plugins', 'data'), 'HARBORS_PLUGIN_DATA_ROOT'),
    cache: absoluteOverride(env.HARBORS_PLUGIN_CACHE_ROOT, path.join(applicationDataDir, 'plugins', 'cache'), 'HARBORS_PLUGIN_CACHE_ROOT'),
    temp: absoluteOverride(env.HARBORS_PLUGIN_TEMP_ROOT, path.join(applicationDataDir, 'plugins', 'temp'), 'HARBORS_PLUGIN_TEMP_ROOT'),
  };
  const port = Number(env.PORT || env.HARBORS_SERVER_PORT) || DEFAULT_PORT;
  const host = env.HARBORS_BIND_HOST || DEFAULT_HOST;
  return {
    applicationDataDir,
    configDataDir: applicationDataDir,
    dbPath,
    legacyDbPaths: explicitDbPath ? [] : [
      path.join(repositoryRoot, '.data', DEFAULT_DB_FILENAME),
      path.join(repositoryRoot, 'packages', 'server', '.editor.db'),
    ],
    legacyPluginDataRoots: [
      path.join(repositoryRoot, '.data', 'plugins'),
      path.join(repositoryRoot, 'packages', 'server', 'plugins', 'data'),
    ],
    pluginPathRoots,
    port,
    host,
  };
}

/**
 * Ensure the project data directory exists, creating it (and any missing
 * parents) recursively. Safe to call when the directory already exists.
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dataDir, 0o700);
}

function absoluteOverride(value: string | undefined, fallback: string, name: string): string {
  if (!value) return fallback;
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}
