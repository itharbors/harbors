import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface StartEnv {
  DB_PATH?: string;
  HARBORS_SERVER_PORT?: string;
  HARBORS_BIND_HOST?: string;
}

export interface StartConfig {
  dataDir: string;
  dbPath: string;
  port: number;
  host: string;
}

const DEFAULT_PORT = 48381;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DB_FILENAME = 'harbors.db';

/**
 * Resolve the startup configuration from the project root and environment.
 *
 * The database path follows this priority:
 * 1. `DB_PATH` environment variable (resolved to an absolute path).
 * 2. A stable file inside the project data directory: `<rootDir>/.data/harbors.db`.
 *
 * Passing `env` explicitly keeps the logic deterministic and testable without
 * mutating `process.env`.
 */
export function resolveStartConfig(rootDir: string, env: StartEnv = process.env): StartConfig {
  const dataDir = path.join(rootDir, '.data');
  const dbPath = env.DB_PATH
    ? path.resolve(env.DB_PATH)
    : path.join(dataDir, DEFAULT_DB_FILENAME);
  const port = Number(env.HARBORS_SERVER_PORT) || DEFAULT_PORT;
  const host = env.HARBORS_BIND_HOST || DEFAULT_HOST;
  return { dataDir, dbPath, port, host };
}

/**
 * Ensure the project data directory exists, creating it (and any missing
 * parents) recursively. Safe to call when the directory already exists.
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
}
