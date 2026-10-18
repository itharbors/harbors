import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  ConfigLayerDefinition as KitConfigLayerDefinition,
  ConfigStorage,
  KitConfigDeclaration,
} from '@itharbors/kit-core';
import {
  createMemoryConfigLayerBackend,
} from '../framework/config/index';
import type {
  ConfigActivation,
  ConfigLayerBackend,
  ConfigLayerDefinition as RuntimeConfigLayerDefinition,
  JsonValue,
} from '../framework/config/types';

export const CONFIG_STORAGE_CLOSED = 'CONFIG_STORAGE_CLOSED';
export const CONFIG_STORAGE_CORRUPT = 'CONFIG_STORAGE_CORRUPT';

export class ConfigStorageClosedError extends Error {
  readonly code = CONFIG_STORAGE_CLOSED;

  constructor() {
    super('Config storage is closed');
    this.name = 'ConfigStorageClosedError';
  }
}

export class ConfigStorageCorruptError extends Error {
  readonly code = CONFIG_STORAGE_CORRUPT;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigStorageCorruptError';
  }
}

/** Bind the User directory while preserving the original Host root boundary. */
export function resolveUserConfigStorageRoot(applicationDataRoot: string, userId: string): string {
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('Config requires a non-empty userId');
  if (!path.isAbsolute(applicationDataRoot)) throw new Error('application-data root must be an absolute path');
  fs.mkdirSync(applicationDataRoot, { recursive: true });
  const root = fs.realpathSync.native(applicationDataRoot);
  const users = path.join(root, 'users');
  fs.mkdirSync(users, { recursive: true });
  assertInsideRoot(root, fs.realpathSync.native(users), 'User config parent');
  const userRoot = path.join(users, createHash('sha256').update(userId, 'utf8').digest('hex'));
  fs.mkdirSync(userRoot, { recursive: true });
  assertInsideRoot(root, fs.realpathSync.native(userRoot), 'User config directory');
  return userRoot;
}

export interface ConfigStorageResolverOptions {
  /** Absolute, host-controlled roots keyed by the manifest storage root. */
  roots: Readonly<{
    'application-data': string;
  }>;
}

/**
 * Creates the backend for one Kit configuration layer. A null storage
 * declaration deliberately creates a fresh in-memory backend per call.
 */
export function resolveConfigLayerBackend(
  kitId: string,
  layer: KitConfigLayerDefinition,
  options: ConfigStorageResolverOptions,
): ConfigLayerBackend {
  if (layer.storage === null) return createMemoryConfigLayerBackend();
  if (layer.storage.driver !== 'sqlite' || layer.storage.root !== 'application-data') {
    throw new Error('Unsupported config storage declaration');
  }
  return new SqliteConfigLayerBackend(
    resolveSqlitePath(options.roots['application-data'], layer.storage),
    kitId,
    layer.name,
  );
}

export function resolveConfigActivation(
  kitId: string,
  declaration: KitConfigDeclaration,
  options: ConfigStorageResolverOptions,
): ConfigActivation {
  const layers: RuntimeConfigLayerDefinition[] = [];
  try {
    for (const layer of declaration.layers) {
      layers.push({
        name: layer.name,
        priority: layer.priority,
        backend: resolveConfigLayerBackend(kitId, layer, options),
      });
    }
    return { kitId, layers, writeLayer: declaration.writeLayer };
  } catch (error) {
    for (const layer of layers) layer.backend.destroy?.();
    throw error;
  }
}

export class SqliteConfigLayerBackend implements ConfigLayerBackend {
  private readonly database: Database.Database;
  private readonly statementGet: Database.Statement;
  private readonly statementSet: Database.Statement;
  private readonly statementDelete: Database.Statement;
  private closed = false;

  constructor(
    databasePath: string,
    private readonly kitId: string,
    private readonly layerName: string,
  ) {
    const database = new Database(databasePath);
    try {
      database.pragma('journal_mode = WAL');
      ensureCurrentSchema(database);
      this.statementGet = database.prepare(`
        SELECT value_json
        FROM config_values
        WHERE kit_id = ? AND plugin_name = ? AND layer_name = ? AND key = ?
      `);
      this.statementSet = database.prepare(`
        INSERT INTO config_values (kit_id, plugin_name, layer_name, key, value_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (kit_id, plugin_name, layer_name, key) DO UPDATE SET value_json = excluded.value_json
      `);
      this.statementDelete = database.prepare(`
        DELETE FROM config_values
        WHERE kit_id = ? AND plugin_name = ? AND layer_name = ? AND key = ?
      `);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  get(key: string, namespace = ''): JsonValue | undefined {
    this.assertOpen();
    const row = this.statementGet.get(this.kitId, namespace, this.layerName, key) as { value_json?: unknown } | undefined;
    if (!row) return undefined;
    if (typeof row.value_json !== 'string') {
      throw new ConfigStorageCorruptError(`Config row for "${key}" has a non-string JSON value`);
    }
    return parseStoredJson(row.value_json, this.kitId, this.layerName, key);
  }

  set(key: string, value: JsonValue, namespace = ''): void {
    this.assertOpen();
    assertJsonValue(value);
    this.statementSet.run(this.kitId, namespace, this.layerName, key, JSON.stringify(value));
  }

  delete(key: string, namespace = ''): void {
    this.assertOpen();
    this.statementDelete.run(this.kitId, namespace, this.layerName, key);
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new ConfigStorageClosedError();
  }
}

function ensureCurrentSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS config_values (
      kit_id TEXT NOT NULL,
      plugin_name TEXT NOT NULL,
      layer_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (kit_id, plugin_name, layer_name, key)
    )
  `);
}

function resolveSqlitePath(applicationDataRoot: string, storage: Exclude<ConfigStorage, null>): string {
  if (!path.isAbsolute(applicationDataRoot)) {
    throw new Error('application-data root must be an absolute path');
  }
  fs.mkdirSync(applicationDataRoot, { recursive: true });
  const root = fs.realpathSync.native(applicationDataRoot);
  const relativePath = validateRelativeStoragePath(storage.path);
  const databasePath = path.resolve(root, relativePath);
  assertInsideRoot(root, databasePath, 'storage path');

  const parent = path.dirname(databasePath);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync.native(parent);
  assertInsideRoot(root, realParent, 'storage parent', true);
  if (fs.existsSync(databasePath)) {
    assertInsideRoot(root, fs.realpathSync.native(databasePath), 'storage file');
  }
  return databasePath;
}

function validateRelativeStoragePath(value: string): string {
  if (
    value.length === 0
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:/u.test(value)
    || /[\\\0\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    throw new Error('storage.path must be a safe relative path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('storage.path must not contain empty, . or .. path segments');
  }
  return value;
}

function assertInsideRoot(root: string, candidate: string, label: string, allowRoot = false): void {
  const relative = path.relative(root, candidate);
  if (
    (!allowRoot && relative.length === 0)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must remain inside applicationDataRoot`);
  }
}

function parseStoredJson(raw: string, kitId: string, layerName: string, key: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ConfigStorageCorruptError(
      `Invalid JSON in config row for Kit "${kitId}", layer "${layerName}", key "${key}"`,
      { cause: error },
    );
  }
  if (!isJsonValue(value)) {
    throw new ConfigStorageCorruptError(
      `Invalid JSON value in config row for Kit "${kitId}", layer "${layerName}", key "${key}"`,
    );
  }
  return value;
}

function assertJsonValue(value: JsonValue): void {
  if (!isJsonValue(value)) throw new Error('Config value must be JSON-serializable');
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
    || typeof value === 'boolean'
  ) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}
