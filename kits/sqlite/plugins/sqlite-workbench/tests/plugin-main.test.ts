import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: {
    unload?(): void | Promise<void>;
  };
  methods: Record<string, (...args: unknown[]) => unknown>;
};

describe('SQLite plugin main', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exposes the manifest methods and closes its service on repeated unload', async () => {
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: {
        define(value: PluginDefinition) {
          definition = value;
        },
      },
    };

    await import('../main/src/index');

    expect(Object.keys(definition!.methods).sort()).toEqual([
      'analyzeSql',
      'cancelSql',
      'closeDatabase',
      'deleteRow',
      'executeSql',
      'explainSql',
      'exportRows',
      'getConnectionState',
      'getObjectSchema',
      'getRecentDatabases',
      'getRelationshipGraph',
      'getRows',
      'getSchema',
      'insertRow',
      'listDirectory',
      'openDatabase',
      'setConnectionMode',
      'undoLastMutation',
      'updateRow',
    ]);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-plugin-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'fixture.sqlite');
    const fixture = new Database(dbPath);
    fixture.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
    fixture.close();

    expect(definition!.methods.openDatabase({ path: dbPath, create: false })).toMatchObject({
      connected: true,
      path: fs.realpathSync(dbPath),
    });
    expect(definition!.methods.getRelationshipGraph()).toMatchObject({
      tables: [expect.objectContaining({ name: 'items' })],
      relationships: [],
    });
    expect(definition!.methods.deleteRow({
      name: 'items',
      identity: { kind: 'rowid', value: { type: 'integer', value: '1' } },
    })).toEqual({
      $sqliteWorkbenchError: {
        code: 'READ_ONLY',
        message: '当前连接为只读模式，无法修改记录。',
      },
    });
    await definition!.lifecycle?.unload?.();
    await definition!.lifecycle?.unload?.();
    expect(definition!.methods.getConnectionState()).toEqual({
      connected: false,
      path: null,
      fileName: null,
      mode: null,
      sqliteVersion: null,
      foreignKeys: null,
      busyTimeout: null,
    });
  });
});
