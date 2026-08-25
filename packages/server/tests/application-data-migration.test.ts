import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { migrateApplicationData } from '../src/application-data-migration';

const roots: string[] = [];
const ownerKey = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-application-migration-'));
  roots.push(root);
  return root;
}

function createDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE authorized_devices (
      deviceId TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL DEFAULT 0,
      expiresAt INTEGER NOT NULL DEFAULT 0,
      lastSeenAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE credential_profiles (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      secret_reference TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'deleting')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, id)
    );
    CREATE TABLE credential_secret_cleanup (account TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY,
      workspacePath TEXT NOT NULL DEFAULT '',
      savedFileList TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL DEFAULT 0,
      lastAccessAt INTEGER NOT NULL DEFAULT 0
    );
  `);
  return database;
}

function insertSession(database: Database.Database, id: string, workspacePath: string, timestamp: number): void {
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
    .run(id, workspacePath, '[]', timestamp, timestamp);
}

function silentLogger() {
  return { info() {}, warn() {} };
}

async function runMigrationProcess(options: Omit<Parameters<typeof migrateApplicationData>[0], 'logger'>): Promise<void> {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/application-data-migration.ts')).href;
  const source = `
    import { migrateApplicationData } from ${JSON.stringify(moduleUrl)};
    const options = JSON.parse(process.argv[1]);
    await migrateApplicationData({ ...options, logger: { info() {}, warn() {} } });
  `;
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      '--input-type=module',
      '--eval', source,
      JSON.stringify(options),
    ], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`migration child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

describe('application data migration', () => {
  it('merges both legacy databases and persistent Plugin files without deleting sources', async () => {
    const root = await makeRoot();
    const applicationData = path.join(root, 'home', '.harbors');
    const firstPath = path.join(root, '.data', 'harbors.db');
    const secondPath = path.join(root, 'packages', 'server', '.editor.db');
    await mkdir(path.dirname(firstPath), { recursive: true });
    await mkdir(path.dirname(secondPath), { recursive: true });
    const first = createDatabase(firstPath);
    first.prepare('INSERT INTO authorized_devices VALUES (?, ?, ?, ?)').run('device-a', 1, 2, 3);
    first.prepare('INSERT INTO credential_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('kit:plugin', 'profile-a', 'Profile', '{}', 'secret:a', 'active', '2026-08-25', '2026-08-25');
    insertSession(first, 'session-a', '/workspace/a', 1);
    first.close();
    const second = createDatabase(secondPath);
    insertSession(second, 'session-b', '/workspace/b', 2);
    second.close();

    const legacyPluginRoot = path.join(root, 'packages', 'server', 'plugins', 'data');
    const legacyPluginOwner = path.join(legacyPluginRoot, ownerKey, 'storage-v1', 'sessions');
    await mkdir(legacyPluginOwner, { recursive: true });
    await writeFile(path.join(legacyPluginOwner, 'trace.jsonl'), 'legacy\n', 'utf8');

    const options = {
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'harbors.db'),
      legacyDbPaths: [firstPath, secondPath],
      pluginDataRoot: path.join(applicationData, 'plugins', 'data'),
      legacyPluginDataRoots: [legacyPluginRoot],
      logger: silentLogger(),
    };
    const summary = await migrateApplicationData(options);
    expect(summary.database.discovered).toBe(2);
    expect(summary.database.imported).toBe(4);
    expect(summary.plugins).toMatchObject({ discovered: 1, imported: 1, failed: 0 });

    const target = new Database(options.dbPath, { readonly: true });
    expect(target.prepare('SELECT sessionId FROM sessions ORDER BY sessionId').all())
      .toEqual([{ sessionId: 'session-a' }, { sessionId: 'session-b' }]);
    expect(target.prepare('SELECT COUNT(*) AS count FROM authorized_devices').get()).toEqual({ count: 1 });
    expect(target.prepare('SELECT COUNT(*) AS count FROM credential_profiles').get()).toEqual({ count: 1 });
    target.close();
    expect(await readFile(path.join(options.pluginDataRoot, ownerKey, 'storage-v1', 'sessions', 'trace.jsonl'), 'utf8')).toBe('legacy\n');
    expect(await readFile(path.join(legacyPluginOwner, 'trace.jsonl'), 'utf8')).toBe('legacy\n');

    const repeated = await migrateApplicationData(options);
    expect(repeated.database.imported).toBe(0);
    expect(repeated.database.skipped).toBe(4);
    expect(repeated.plugins).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('keeps existing target rows, reports divergent conflicts, and imports only missing keys', async () => {
    const root = await makeRoot();
    const applicationData = path.join(root, 'home', '.harbors');
    const targetPath = path.join(applicationData, 'harbors.db');
    const sourcePath = path.join(root, '.data', 'harbors.db');
    await mkdir(applicationData, { recursive: true });
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const target = createDatabase(targetPath);
    insertSession(target, 'same-id', '/target', 10);
    target.close();
    const source = createDatabase(sourcePath);
    insertSession(source, 'same-id', '/legacy', 1);
    insertSession(source, 'missing-id', '/legacy/missing', 2);
    source.close();

    const summary = await migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: targetPath,
      legacyDbPaths: [sourcePath],
      pluginDataRoot: path.join(applicationData, 'plugins', 'data'),
      legacyPluginDataRoots: [],
      logger: silentLogger(),
    });
    expect(summary.database).toMatchObject({ imported: 1, conflicted: 1 });
    const result = new Database(targetPath, { readonly: true });
    expect(result.prepare('SELECT workspacePath FROM sessions WHERE sessionId = ?').get('same-id'))
      .toEqual({ workspacePath: '/target' });
    expect(result.prepare('SELECT workspacePath FROM sessions WHERE sessionId = ?').get('missing-id'))
      .toEqual({ workspacePath: '/legacy/missing' });
    result.close();
  });

  it('backs up an active WAL source and serializes concurrent migrations', async () => {
    const root = await makeRoot();
    const applicationData = path.join(root, 'home', '.harbors');
    const sourcePath = path.join(root, '.data', 'harbors.db');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const source = createDatabase(sourcePath);
    source.pragma('journal_mode = WAL');
    insertSession(source, 'wal-session', '/wal', 3);
    const options = {
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'harbors.db'),
      legacyDbPaths: [sourcePath],
      pluginDataRoot: path.join(applicationData, 'plugins', 'data'),
      legacyPluginDataRoots: [],
      logger: silentLogger(),
    };

    const processOptions = { ...options };
    delete (processOptions as { logger?: unknown }).logger;
    await Promise.all([
      runMigrationProcess(processOptions),
      runMigrationProcess(processOptions),
    ]);
    source.close();
    const target = new Database(options.dbPath, { readonly: true });
    expect(target.prepare('SELECT workspacePath FROM sessions WHERE sessionId = ?').get('wal-session'))
      .toEqual({ workspacePath: '/wal' });
    target.close();
  });

  it('fails closed on incompatible schema and skips linked Plugin entries', async () => {
    const root = await makeRoot();
    const applicationData = path.join(root, 'home', '.harbors');
    const targetPath = path.join(applicationData, 'harbors.db');
    const sourcePath = path.join(root, '.data', 'harbors.db');
    await mkdir(applicationData, { recursive: true });
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const target = createDatabase(targetPath);
    target.close();
    const source = createDatabase(sourcePath);
    source.exec('ALTER TABLE sessions ADD COLUMN incompatible TEXT');
    source.close();

    await expect(migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'absent-target.db'),
      legacyDbPaths: [sourcePath],
      pluginDataRoot: path.join(applicationData, 'plugins', 'data'),
      legacyPluginDataRoots: [],
      logger: silentLogger(),
    })).rejects.toThrow(/SCHEMA_MISMATCH:sessions/u);

    await expect(migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: targetPath,
      legacyDbPaths: [sourcePath],
      pluginDataRoot: path.join(applicationData, 'plugins', 'data'),
      legacyPluginDataRoots: [],
      logger: silentLogger(),
    })).rejects.toThrow(/SCHEMA_MISMATCH:sessions/u);

    const legacyPluginRoot = path.join(root, 'legacy-plugins');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(legacyPluginRoot, ownerKey), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret'), 'outside', 'utf8');
    await symlink(path.join(outside, 'secret'), path.join(legacyPluginRoot, ownerKey, 'linked'));
    const summary = await migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'custom.db'),
      legacyDbPaths: [],
      pluginDataRoot: path.join(applicationData, 'plugins', 'data'),
      legacyPluginDataRoots: [legacyPluginRoot],
      logger: silentLogger(),
    });
    expect(summary.plugins).toMatchObject({ discovered: 1, imported: 0, failed: 1 });

    const secondOwnerKey = 'b'.repeat(64);
    const linkedTarget = path.join(applicationData, 'linked-target-plugins');
    const secondLegacyRoot = path.join(root, 'second-legacy-plugins');
    await mkdir(path.join(secondLegacyRoot, secondOwnerKey), { recursive: true });
    await writeFile(path.join(secondLegacyRoot, secondOwnerKey, 'session.jsonl'), 'legacy', 'utf8');
    await mkdir(linkedTarget, { recursive: true });
    await symlink(outside, path.join(linkedTarget, secondOwnerKey));
    await expect(migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'custom.db'),
      legacyDbPaths: [],
      pluginDataRoot: linkedTarget,
      legacyPluginDataRoots: [secondLegacyRoot],
      logger: silentLogger(),
    })).rejects.toThrow(/DIRECTORY_INVALID/u);
    await expect(readFile(path.join(outside, 'session.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const linkedRoot = path.join(applicationData, 'linked-plugin-root');
    await symlink(outside, linkedRoot);
    await expect(migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'custom.db'),
      legacyDbPaths: [],
      pluginDataRoot: linkedRoot,
      legacyPluginDataRoots: [secondLegacyRoot],
      logger: silentLogger(),
    })).rejects.toThrow(/DIRECTORY_INVALID/u);

    const linkedParentRoot = path.join(applicationData, 'linked-parent', 'data');
    await symlink(outside, path.join(applicationData, 'linked-parent'));
    await expect(migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'custom.db'),
      legacyDbPaths: [],
      pluginDataRoot: linkedParentRoot,
      legacyPluginDataRoots: [secondLegacyRoot],
      logger: silentLogger(),
    })).rejects.toThrow(/DIRECTORY_INVALID/u);
    await expect(lstat(path.join(outside, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });

    const thirdOwnerKey = 'c'.repeat(64);
    const thirdLegacyRoot = path.join(root, 'third-legacy-plugins');
    const intermediateTarget = path.join(applicationData, 'intermediate-target-plugins');
    await mkdir(path.join(thirdLegacyRoot, thirdOwnerKey, 'nested'), { recursive: true });
    await writeFile(path.join(thirdLegacyRoot, thirdOwnerKey, 'nested', 'session.jsonl'), 'legacy', 'utf8');
    await mkdir(path.join(intermediateTarget, thirdOwnerKey), { recursive: true });
    await symlink(outside, path.join(intermediateTarget, thirdOwnerKey, 'nested'));
    await expect(migrateApplicationData({
      applicationDataDir: applicationData,
      dbPath: path.join(applicationData, 'custom.db'),
      legacyDbPaths: [],
      pluginDataRoot: intermediateTarget,
      legacyPluginDataRoots: [thirdLegacyRoot],
      logger: silentLogger(),
    })).rejects.toThrow(/DIRECTORY_INVALID/u);
  });
});
