import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DeviceStore } from './auth/device-store.js';
import { CredentialStore } from './credentials/store.js';
import { SessionStore } from './session/store.js';

const DATABASE_TABLES = [
  'users',
  'authorized_devices',
  'credential_profiles',
  'credential_secret_cleanup',
  'sessions',
] as const;
const OWNER_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const LOCK_STALE_MS = 120_000;
const LOCK_TIMEOUT_MS = 30_000;

export interface ApplicationDataMigrationOptions {
  applicationDataDir: string;
  dbPath: string;
  legacyDbPaths: readonly string[];
  pluginDataRoot: string;
  legacyPluginDataRoots: readonly string[];
  logger?: Pick<Console, 'info' | 'warn'>;
  /** @internal Deterministic publication hook used only by migration race tests. */
  beforeTargetPublish?: () => void | Promise<void>;
}

export interface MigrationCounters {
  discovered: number;
  imported: number;
  skipped: number;
  conflicted: number;
  failed: number;
}

export interface ApplicationDataMigrationSummary {
  database: MigrationCounters;
  plugins: MigrationCounters;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: unknown;
  pk: number;
}

interface Snapshot {
  path: string;
}

export async function migrateApplicationData(
  options: ApplicationDataMigrationOptions,
): Promise<ApplicationDataMigrationSummary> {
  await ensurePrivateDirectory(options.applicationDataDir);
  const lockPath = path.join(options.applicationDataDir, '.application-data-migration-v1.lock');
  return withMigrationLock(lockPath, async () => {
    const database = await migrateDatabases(
      options.dbPath,
      options.legacyDbPaths,
      options.applicationDataDir,
      options.beforeTargetPublish,
    );
    const plugins = await migratePluginData(
      options.applicationDataDir,
      options.pluginDataRoot,
      options.legacyPluginDataRoots,
    );
    const summary = { database, plugins };
    const logger = options.logger ?? console;
    logger.info(`[application-data-migration] ${JSON.stringify(summary)}`);
    return summary;
  });
}

async function migrateDatabases(
  targetPath: string,
  legacyPaths: readonly string[],
  temporaryRoot: string,
  beforeTargetPublish?: () => void | Promise<void>,
): Promise<MigrationCounters> {
  const counters = emptyCounters();
  const snapshots: Snapshot[] = [];
  try {
    for (const sourcePath of legacyPaths) {
      const exists = await inspectRegularFile(sourcePath);
      if (!exists) continue;
      counters.discovered += 1;
      const snapshotPath = path.join(temporaryRoot, `.legacy-db-${process.pid}-${randomUUID()}.sqlite`);
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 10_000 });
      try {
        assertDatabaseIntegrity(source, `legacy database ${path.basename(sourcePath)}`);
        await source.backup(snapshotPath);
      } finally {
        source.close();
      }
      await chmod(snapshotPath, 0o600);
      const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        assertDatabaseIntegrity(snapshot, `legacy snapshot ${path.basename(sourcePath)}`);
      } finally {
        snapshot.close();
      }
      snapshots.push({ path: snapshotPath });
    }
    if (snapshots.length === 0) return counters;
    await ensurePrivateDirectory(path.dirname(targetPath));

    let mergeIntoExistingTarget = await inspectRegularFile(targetPath);
    await preflightDatabaseSchemas(
      mergeIntoExistingTarget ? targetPath : undefined,
      snapshots,
      temporaryRoot,
    );
    if (!mergeIntoExistingTarget) {
      const temporaryTarget = path.join(path.dirname(targetPath), `.harbors-db-${process.pid}-${randomUUID()}.tmp`);
      const stagedCounters = emptyCounters();
      try {
        createCurrentDatabaseSchema(temporaryTarget);
        await mergeSnapshots(temporaryTarget, snapshots, stagedCounters);
        createCurrentDatabaseSchema(temporaryTarget);
        await validateAndSyncDatabase(temporaryTarget);
        try {
          await beforeTargetPublish?.();
          await link(temporaryTarget, targetPath);
          await syncDirectory(path.dirname(targetPath));
          addCounters(counters, stagedCounters);
        } catch (error) {
          if (!isNodeError(error, 'EEXIST')) throw error;
          mergeIntoExistingTarget = true;
          // The target appeared after the initial preflight. Validate the
          // actual competing file before any schema upgrade or merge write.
          await preflightDatabaseSchemas(targetPath, snapshots, temporaryRoot);
        }
      } finally {
        await removeDatabaseArtifacts(temporaryTarget);
      }
    }

    if (!(await inspectRegularFile(targetPath))) throw new Error('APPLICATION_DATABASE_TARGET_INVALID');
    if (mergeIntoExistingTarget) {
      // Upgrade the target first so a current identity-bearing source can be
      // merged into an older, otherwise valid application database.
      createCurrentDatabaseSchema(targetPath);
      await mergeSnapshots(targetPath, snapshots, counters);
    }
    createCurrentDatabaseSchema(targetPath);
    await validateAndSyncDatabase(targetPath);
    return counters;
  } finally {
    await Promise.all(snapshots.map((snapshot) => unlink(snapshot.path).catch(() => undefined)));
  }
}

async function preflightDatabaseSchemas(
  targetPath: string | undefined,
  snapshots: readonly Snapshot[],
  temporaryRoot: string,
): Promise<void> {
  const referencePath = path.join(
    temporaryRoot,
    `.current-schema-${process.pid}-${randomUUID()}.sqlite`,
  );
  try {
    createCurrentDatabaseSchema(referencePath);
    const reference = new Database(referencePath, { readonly: true, fileMustExist: true });
    try {
      const candidates = [
        ...(targetPath ? [{ path: targetPath, label: 'target database' }] : []),
        ...snapshots.map((snapshot) => ({ path: snapshot.path, label: 'legacy snapshot' })),
      ];
      for (const candidate of candidates) {
        const database = new Database(candidate.path, { readonly: true, fileMustExist: true });
        try {
          assertDatabaseIntegrity(database, candidate.label);
          for (const table of DATABASE_TABLES) {
            const columns = tableColumns(database, table);
            if (columns.length === 0) continue;
            const currentColumns = tableColumns(reference, table);
            if (!sameSchema(columns, currentColumns)
              && !isApprovedIdentitySchemaUpgrade(table, columns, currentColumns)) {
              throw new Error(`APPLICATION_DATABASE_SCHEMA_MISMATCH:${table}`);
            }
          }
        } finally {
          database.close();
        }
      }
    } finally {
      reference.close();
    }
  } finally {
    await removeDatabaseArtifacts(referencePath);
  }
}

async function mergeSnapshots(
  targetPath: string,
  snapshots: readonly Snapshot[],
  counters: MigrationCounters,
): Promise<void> {
  if (snapshots.length === 0) return;
  const target = new Database(targetPath, { fileMustExist: true, timeout: 10_000 });
  try {
    assertDatabaseIntegrity(target, 'target database');
    target.pragma('busy_timeout = 10000');
    const sources = snapshots.map((snapshot) => ({
      snapshot,
      database: new Database(snapshot.path, { readonly: true, fileMustExist: true }),
    }));
    try {
      const merge = target.transaction(() => {
        for (const { database: source } of sources) mergeDatabase(target, source, counters);
      });
      merge.immediate();
    } finally {
      for (const source of sources) source.database.close();
    }
  } finally {
    target.close();
  }
}

function mergeDatabase(
  target: Database.Database,
  source: Database.Database,
  counters: MigrationCounters,
): void {
  assertDatabaseIntegrity(source, 'legacy snapshot');
  for (const table of DATABASE_TABLES) {
    const sourceColumns = tableColumns(source, table);
    if (sourceColumns.length === 0) continue;
    const targetColumns = tableColumns(target, table);
    if (!sameSchema(sourceColumns, targetColumns)
      && !isApprovedIdentitySchemaUpgrade(table, sourceColumns, targetColumns)) {
      throw new Error(`APPLICATION_DATABASE_SCHEMA_MISMATCH:${table}`);
    }
    const primary = sourceColumns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
    if (primary.length === 0) throw new Error(`APPLICATION_DATABASE_PRIMARY_KEY_MISSING:${table}`);
    const names = sourceColumns.map((column) => column.name);
    const selectExisting = target.prepare(
      `SELECT ${names.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} WHERE ${primary.map((column) => `${quoteIdentifier(column.name)} = ?`).join(' AND ')}`,
    );
    const insert = target.prepare(
      `INSERT INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    );
    const rows = source.prepare(`SELECT ${names.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const existing = selectExisting.get(...primary.map((column) => row[column.name])) as Record<string, unknown> | undefined;
      if (existing) {
        if (names.every((name) => equalSqlValue(existing[name], row[name]))) counters.skipped += 1;
        else counters.conflicted += 1;
        continue;
      }
      insert.run(...names.map((name) => row[name]));
      counters.imported += 1;
    }
  }
}

function tableColumns(database: Database.Database, table: string): ColumnInfo[] {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
}

function sameSchema(left: readonly ColumnInfo[], right: readonly ColumnInfo[]): boolean {
  return left.length === right.length && left.every((column, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && column.name === candidate.name
      && column.type === candidate.type
      && column.notnull === candidate.notnull
      && column.pk === candidate.pk
      && String(column.dflt_value) === String(candidate.dflt_value);
  });
}

function isApprovedIdentitySchemaUpgrade(
  table: string,
  source: readonly ColumnInfo[],
  target: readonly ColumnInfo[],
): boolean {
  const approvedColumn = table === 'authorized_devices'
    ? 'userId'
    : table === 'sessions'
      ? 'ownerUserId'
      : undefined;
  if (!approvedColumn || target.length !== source.length + 1) return false;
  const added = target.find((column) => column.name === approvedColumn);
  if (!added || added.type !== 'TEXT' || added.notnull !== 0 || added.pk !== 0 || added.dflt_value !== null) {
    return false;
  }
  const projected = target.filter((column) => column.name !== approvedColumn);
  return sameSchema(source, projected);
}

function createCurrentDatabaseSchema(databasePath: string): void {
  const deviceStore = new DeviceStore(databasePath);
  deviceStore.close();
  const credentialStore = new CredentialStore(databasePath);
  credentialStore.close();
  const sessionStore = new SessionStore(databasePath);
  sessionStore.close();
}

async function removeDatabaseArtifacts(databasePath: string): Promise<void> {
  await Promise.all([
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ].map((candidate) => unlink(candidate).catch(() => undefined)));
}

function assertDatabaseIntegrity(database: Database.Database, label: string): void {
  const result = database.pragma('integrity_check', { simple: true });
  if (result !== 'ok') throw new Error(`APPLICATION_DATABASE_INTEGRITY_FAILED:${label}`);
}

async function validateAndSyncDatabase(databasePath: string): Promise<void> {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    assertDatabaseIntegrity(database, 'published database');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
  const handle = await open(databasePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function migratePluginData(
  applicationDataRoot: string,
  targetRoot: string,
  legacyRoots: readonly string[],
): Promise<MigrationCounters> {
  const counters = emptyCounters();
  await ensurePrivateDirectoryChain(applicationDataRoot, targetRoot);
  for (const sourceRoot of legacyRoots) {
    let entries: import('node:fs').Dirent[];
    try {
      const source = await lstat(sourceRoot);
      if (!source.isDirectory() || source.isSymbolicLink()) {
        counters.failed += 1;
        continue;
      }
      entries = await readdir(sourceRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      counters.failed += 1;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !OWNER_KEY_PATTERN.test(entry.name)) {
        if (entry.name !== '.DS_Store') counters.failed += 1;
        continue;
      }
      await migratePluginTree(
        targetRoot,
        path.join(sourceRoot, entry.name),
        path.join(targetRoot, entry.name),
        counters,
      );
    }
  }
  return counters;
}

async function migratePluginTree(
  targetRoot: string,
  sourceDirectory: string,
  targetDirectory: string,
  counters: MigrationCounters,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    const sourceStat = await lstat(sourceDirectory);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      counters.failed += 1;
      return;
    }
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch {
    counters.failed += 1;
    return;
  }
  if (entries.length === 0) return;
  await ensurePrivateDirectoryChain(targetRoot, targetDirectory);
  for (const entry of entries) {
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      await migratePluginTree(targetRoot, source, target, counters);
      continue;
    }
    counters.discovered += 1;
    if (!entry.isFile()) {
      counters.failed += 1;
      continue;
    }
    if (await pathExists(target)) {
      counters.skipped += 1;
      continue;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.migration`;
    try {
      await copyOpenFile(source, temporary);
      try {
        await link(temporary, target);
        await syncDirectory(path.dirname(target));
        counters.imported += 1;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        counters.skipped += 1;
      }
    } catch {
      counters.failed += 1;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

async function copyOpenFile(sourcePath: string, targetPath: string): Promise<void> {
  const source = await open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile()) throw new Error('APPLICATION_DATA_SOURCE_NOT_REGULAR');
    target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await target.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const sourceAfter = await source.stat();
    if (sourceAfter.dev !== sourceStat.dev || sourceAfter.ino !== sourceStat.ino || sourceAfter.size !== sourceStat.size) {
      throw new Error('APPLICATION_DATA_SOURCE_CHANGED');
    }
    await target.sync();
  } catch (error) {
    await unlink(targetPath).catch(() => undefined);
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function withMigrationLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(JSON.stringify({ token, createdAt: Date.now() }), 'utf8');
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!isNodeError(error, 'EEXIST')) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
      } catch (inspectError) {
        if (!isNodeError(inspectError, 'ENOENT')) throw inspectError;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error('APPLICATION_DATA_MIGRATION_LOCK_TIMEOUT');
      await delay(25);
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void handle.utimes(now, now).catch(() => undefined);
  }, Math.floor(LOCK_STALE_MS / 4));
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => undefined);
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown };
      if (current.token === token) await unlink(lockPath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
}

async function inspectRegularFile(candidate: string): Promise<boolean> {
  try {
    const file = await lstat(candidate);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('APPLICATION_DATA_FILE_INVALID');
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('APPLICATION_DATA_DIRECTORY_INVALID');
  }
  const canonical = await realpath(directory);
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()
      || opened.dev !== directoryStat.dev
      || opened.ino !== directoryStat.ino
      || await realpath(directory) !== canonical) {
      throw new Error('APPLICATION_DATA_DIRECTORY_CHANGED');
    }
    if (process.platform !== 'win32') await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectoryChain(root: string, target: string): Promise<void> {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('APPLICATION_DATA_DIRECTORY_OUTSIDE_ROOT');
  }
  await ensurePrivateDirectory(normalizedRoot);
  let current = normalizedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await ensurePrivateDirectory(current);
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error('APPLICATION_DATABASE_IDENTIFIER_INVALID');
  return `"${value}"`;
}

function equalSqlValue(left: unknown, right: unknown): boolean {
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  return Object.is(left, right);
}

function emptyCounters(): MigrationCounters {
  return { discovered: 0, imported: 0, skipped: 0, conflicted: 0, failed: 0 };
}

function addCounters(target: MigrationCounters, source: MigrationCounters): void {
  target.discovered += source.discovered;
  target.imported += source.imported;
  target.skipped += source.skipped;
  target.conflicted += source.conflicted;
  target.failed += source.failed;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
