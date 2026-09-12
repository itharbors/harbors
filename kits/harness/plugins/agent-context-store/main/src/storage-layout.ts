import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ContextStoreError } from './errors.js';

export interface StorePointer {
  formatVersion: 2;
  versionId: string;
  epoch: string;
}

export interface StoreLayout {
  root: string;
  versionDirectory: string;
  databasePath: string;
  pointer: StorePointer;
  fresh: boolean;
  migrationLock?: { path: string; fd: number };
}

const VERSION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

export function resolveStoreLayout(dataDirectory: string): StoreLayout {
  const root = join(dataDirectory, 'storage-v2');
  const versions = join(root, 'versions');
  mkdirSync(versions, { recursive: true });
  mkdirSync(join(root, 'tombstones'), { recursive: true });
  const currentPath = join(root, 'current.json');
  if (existsSync(currentPath)) {
    const pointer = parsePointer(readFileSync(currentPath, 'utf8'));
    const versionDirectory = join(versions, pointer.versionId);
    if (!existsSync(versionDirectory)) throw new ContextStoreError('MIGRATION_FAILED');
    const databasePath = join(versionDirectory, 'context.sqlite');
    try {
      const database = lstatSync(databasePath);
      if (!database.isFile() || database.isSymbolicLink()) throw new Error('invalid database file');
    } catch {
      throw new ContextStoreError('DATABASE_CORRUPT');
    }
    return { root, versionDirectory, databasePath, pointer, fresh: false };
  }
  const migrationLock = acquireMigrationLock(root);
  if (existsSync(currentPath)) {
    releaseMigrationLockHandle(root, migrationLock);
    return resolveStoreLayout(dataDirectory);
  }
  try {
    const pointer: StorePointer = { formatVersion: 2, versionId: `v1-${randomUUID()}`, epoch: randomUUID() };
    const versionDirectory = join(versions, pointer.versionId);
    mkdirSync(versionDirectory, { recursive: false });
    atomicWriteJson(join(versionDirectory, 'migration-journal.json'), {
      oldVersionId: null,
      newVersionId: pointer.versionId,
      epoch: pointer.epoch,
      stage: 'prepare',
    });
    return { root, versionDirectory, databasePath: join(versionDirectory, 'context.sqlite'), pointer, fresh: true, migrationLock };
  } catch (error) {
    releaseMigrationLockHandle(root, migrationLock);
    throw error;
  }
}

export function activateStoreLayout(layout: StoreLayout): void {
  if (existsSync(join(layout.root, 'current.json'))) throw new ContextStoreError('STORE_VERSION_STALE');
  atomicWriteJson(join(layout.versionDirectory, 'migration-journal.json'), {
    oldVersionId: null,
    newVersionId: layout.pointer.versionId,
    epoch: layout.pointer.epoch,
    stage: 'verified',
  });
  atomicWriteJson(join(layout.root, 'current.json'), layout.pointer);
  atomicWriteJson(join(layout.versionDirectory, 'migration-journal.json'), {
    oldVersionId: null,
    newVersionId: layout.pointer.versionId,
    epoch: layout.pointer.epoch,
    stage: 'activated',
  });
}

export function acceptStoreLayout(layout: StoreLayout): void {
  assertActiveStoreLayout(layout);
  atomicWriteJson(join(layout.versionDirectory, 'migration-journal.json'), {
    oldVersionId: null,
    newVersionId: layout.pointer.versionId,
    epoch: layout.pointer.epoch,
    stage: 'accepted',
  });
}

export function rollbackFreshActivation(layout: StoreLayout): void {
  const currentPath = join(layout.root, 'current.json');
  if (!existsSync(currentPath)) return;
  const current = parsePointer(readFileSync(currentPath, 'utf8'));
  if (current.versionId !== layout.pointer.versionId || current.epoch !== layout.pointer.epoch) return;
  unlinkSync(currentPath);
  const directory = openSync(layout.root, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function releaseMigrationLock(layout: StoreLayout): void {
  if (!layout.migrationLock) return;
  const lock = layout.migrationLock;
  layout.migrationLock = undefined;
  releaseMigrationLockHandle(layout.root, lock);
}

export function assertActiveStoreLayout(layout: StoreLayout): void {
  const currentPath = join(layout.root, 'current.json');
  if (!existsSync(currentPath)) {
    if (layout.fresh) return;
    throw new ContextStoreError('STORE_VERSION_STALE');
  }
  const active = parsePointer(readFileSync(currentPath, 'utf8'));
  if (active.versionId !== layout.pointer.versionId || active.epoch !== layout.pointer.epoch) {
    throw new ContextStoreError('STORE_VERSION_STALE');
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const file = openSync(temporary, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function parsePointer(raw: string): StorePointer {
  try {
    const value = JSON.parse(raw) as Partial<StorePointer>;
    if (value.formatVersion !== 2 || typeof value.versionId !== 'string' || !VERSION_ID.test(value.versionId) || typeof value.epoch !== 'string' || value.epoch.length === 0) {
      throw new Error('invalid pointer');
    }
    return value as StorePointer;
  } catch {
    throw new ContextStoreError('MIGRATION_FAILED');
  }
}

function acquireMigrationLock(root: string): { path: string; fd: number } {
  const path = join(root, 'migration.lock');
  try {
    return createMigrationLock(path);
  } catch {
    if (!existsSync(path) || !recoverStaleMigrationLock(root, path)) {
      throw new ContextStoreError('MIGRATION_FAILED');
    }
    try {
      return createMigrationLock(path);
    } catch {
      throw new ContextStoreError('MIGRATION_FAILED');
    }
  }
}

function createMigrationLock(path: string): { path: string; fd: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
    fsyncSync(fd);
    return { path, fd };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } finally {
        try { unlinkSync(path); } catch { /* retain the original lock creation failure */ }
      }
    }
    throw error;
  }
}

function recoverStaleMigrationLock(root: string, lockPath: string): boolean {
  const claimPath = join(root, `migration.lock.recovery.${process.pid}.${randomUUID()}`);
  try {
    const originalStat = lstatSync(lockPath);
    if (!originalStat.isFile() || originalStat.isSymbolicLink()) return false;
    if (existsSync(join(root, 'current.json'))) return false;
    const metadata = parseMigrationLock(readFileSync(lockPath, 'utf8'));
    if (!metadata || isProcessAlive(metadata.pid) || !hasOnlyRecoverableMigrationJournals(root)) return false;
    linkSync(lockPath, claimPath);
    const claimedStat = lstatSync(claimPath);
    if (claimedStat.dev !== originalStat.dev || claimedStat.ino !== originalStat.ino) return false;
    unlinkSync(lockPath);
    const directory = openSync(root, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(claimPath); } catch { /* no recovery claim was published */ }
  }
}

function parseMigrationLock(raw: string): { pid: number; createdAt: string } | undefined {
  try {
    const value = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.createdAt !== 'string') return undefined;
    const createdAt = new Date(value.createdAt);
    if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== value.createdAt) return undefined;
    return { pid: Number(value.pid), createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function hasOnlyRecoverableMigrationJournals(root: string): boolean {
  const versions = join(root, 'versions');
  for (const entry of readdirSync(versions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VERSION_ID.test(entry.name)) return false;
    const directory = join(versions, entry.name);
    const journalPath = join(directory, 'migration-journal.json');
    if (!existsSync(journalPath)) {
      const leftovers = readdirSync(directory);
      if (leftovers.every((name) => {
        const candidate = lstatSync(join(directory, name));
        return candidate.isFile()
          && !candidate.isSymbolicLink()
          && name.startsWith('migration-journal.json.')
          && name.endsWith('.tmp');
      })) continue;
      return false;
    }
    try {
      const journalStat = lstatSync(journalPath);
      if (!journalStat.isFile() || journalStat.isSymbolicLink()) return false;
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
      if (journal.oldVersionId !== null
        || journal.newVersionId !== entry.name
        || typeof journal.epoch !== 'string'
        || !['prepare', 'verified', 'failed'].includes(String(journal.stage))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function releaseMigrationLockHandle(root: string, lock: { path: string; fd: number }): void {
  try { closeSync(lock.fd); } finally {
    try { unlinkSync(lock.path); } catch { /* another failure already owns the result */ }
  }
  const directory = openSync(root, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
