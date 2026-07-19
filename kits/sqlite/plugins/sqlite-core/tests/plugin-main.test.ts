import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_TOPICS } from '@itharbors/sqlite-contracts';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: unknown): void;
    unload?(): void | Promise<void>;
  };
  methods: Record<string, (...args: unknown[]) => unknown>;
};

describe('SQLite core plugin main', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exposes the database API with revision snapshots and success broadcasts', async () => {
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

    const broadcast = vi.fn();
    definition!.lifecycle?.load?.({ message: { broadcast } });
    expect(definition!.methods.getConnectionState()).toMatchObject({
      connected: false,
      connectionRevision: 0,
      schemaRevision: 0,
      dataRevision: 0,
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-core-plugin-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'fixture.sqlite');
    const fixture = new Database(dbPath);
    fixture.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
    fixture.close();

    expect(definition!.methods.openDatabase({ path: dbPath, create: false })).toMatchObject({
      connected: true,
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 1,
    });
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ connected: true, connectionRevision: 1 }),
    );

    expect(definition!.methods.deleteRow({
      name: 'items',
      identity: { kind: 'rowid', value: { type: 'integer', value: '1' } },
    })).toEqual({
      $sqliteError: {
        code: 'READ_ONLY',
        message: '当前连接为只读模式，无法修改记录。',
      },
    });
    expect(broadcast).toHaveBeenCalledTimes(1);

    await definition!.lifecycle?.unload?.();
    await definition!.lifecycle?.unload?.();
  });
});
