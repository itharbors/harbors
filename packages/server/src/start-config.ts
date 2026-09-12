import path from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { PluginPathRoots } from '@itharbors/magnet';

export interface StartEnv {
  DB_PATH?: string;
  HARBORS_DATA_ROOT?: string;
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
  pluginPathRoots: PluginPathRoots;
  port: number;
  host: string;
}

const DEFAULT_PORT = 48381;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DB_FILENAME = 'harbors.db';

/**
 * Resolve the Web host startup configuration from the user home and environment.
 *
 * The unified data root defaults to `~/.harbors`. `HARBORS_DATA_ROOT` moves
 * the database, configuration storage, and all Plugin roots together. The
 * explicit component-specific variables remain higher-priority overrides.
 */
export function resolveStartConfig(
  env: StartEnv = process.env,
  homeDirectory: string = homedir(),
): StartConfig {
  const defaultApplicationDataDir = path.join(homeDirectory, '.harbors');
  const explicitDataRoot = env.HARBORS_DATA_ROOT?.trim();
  const applicationDataDir = absoluteOverride(
    explicitDataRoot,
    defaultApplicationDataDir,
    'HARBORS_DATA_ROOT',
  );
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
