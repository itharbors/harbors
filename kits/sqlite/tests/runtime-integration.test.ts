import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultAssemblyConfig } from '../../../packages/server/src/assembly/config';
import { createEditor } from '../../../packages/server/src/editor/index';
import { createRuntimeDatabase } from './fixtures/create-runtime-database';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('SQLite kit runtime integration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads through the real editor and completes a CRUD cycle', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-kit-runtime-'));
    tempDirs.push(tempDir);
    const databasePath = path.join(tempDir, 'smoke.sqlite');
    const editor = createEditor('sqlite-kit-smoke', {
      assembly: createDefaultAssemblyConfig(projectRoot),
    });

    try {
      await editor.kit.load(path.join(projectRoot, 'kits/sqlite'));
      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-sqlite');
      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining([
        '@itharbors/sqlite-core',
        '@itharbors/sqlite-explorer',
        '@itharbors/sqlite-data',
        '@itharbors/sqlite-schema',
        '@itharbors/sqlite-relationships',
        '@itharbors/sqlite-sql',
      ]));
      editor.plugin.callPlugin('@itharbors/sqlite-core', 'openDatabase', {
        path: databasePath,
        create: true,
      });
      const createSql = 'CREATE TABLE smoke_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)';
      const analysis = editor.plugin.callPlugin('@itharbors/sqlite-core', 'analyzeSql', {
        sql: createSql,
      }) as { confirmationToken: string };
      await editor.plugin.callPlugin('@itharbors/sqlite-core', 'executeSql', {
        executionId: 'runtime-create-table',
        sql: createSql,
        confirmationToken: analysis.confirmationToken,
      });
      const schema = editor.plugin.callPlugin(
        '@itharbors/sqlite-core',
        'getSchema',
      ) as { connectionRevision: number; objects: Array<{ name: string }> };
      expect(schema.objects.map((object) => object.name)).toContain('smoke_items');
      await expect(editor.plugin.callPlugin('@itharbors/sqlite-explorer', 'selectObject', {
        connectionRevision: schema.connectionRevision,
        objectName: 'smoke_items',
      })).resolves.toEqual({ connectionRevision: schema.connectionRevision, objectName: 'smoke_items' });

      expect(editor.plugin.callPlugin('@itharbors/sqlite-core', 'insertRow', {
        name: 'smoke_items',
        values: { label: { type: 'text', value: 'first' } },
      })).toMatchObject({ changes: 1 });
      const inserted = editor.plugin.callPlugin('@itharbors/sqlite-core', 'getRows', {
        name: 'smoke_items',
        page: 1,
        pageSize: 25,
      }) as { rows: Array<{ identity: unknown; values: unknown[] }>; total: number };
      expect(inserted.total).toBe(1);

      expect(editor.plugin.callPlugin('@itharbors/sqlite-core', 'updateRow', {
        name: 'smoke_items',
        identity: inserted.rows[0].identity,
        values: { label: { type: 'text', value: 'changed' } },
      })).toMatchObject({ changes: 1 });
      expect(editor.plugin.callPlugin('@itharbors/sqlite-core', 'deleteRow', {
        name: 'smoke_items',
        identity: inserted.rows[0].identity,
      })).toMatchObject({ changes: 1 });

      const remaining = editor.plugin.callPlugin('@itharbors/sqlite-core', 'getRows', {
        name: 'smoke_items',
        page: 1,
        pageSize: 25,
      }) as { total: number };
      expect(remaining.total).toBe(0);
    } finally {
      await editor.dispose();
    }
  });

  it('exposes the relationship graph through the assembled plugin request', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-kit-runtime-relationships-'));
    tempDirs.push(tempDir);
    const databasePath = path.join(tempDir, 'relationships.sqlite');
    const fixtureDatabase = new Database(databasePath);
    try {
      fixtureDatabase.exec(`
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id)
        );
      `);
    } finally {
      fixtureDatabase.close();
    }
    const editor = createEditor('sqlite-kit-runtime-relationships', {
      assembly: createDefaultAssemblyConfig(projectRoot),
    });

    try {
      await editor.kit.load(path.join(projectRoot, 'kits/sqlite'));
      const plugin = '@itharbors/sqlite-core';
      editor.plugin.callPlugin(plugin, 'openDatabase', {
        path: databasePath,
        create: false,
      });

      const graph = editor.plugin.callPlugin(plugin, 'getRelationshipGraph');
      expect(graph).toMatchObject({
        tables: expect.arrayContaining([
          expect.objectContaining({ name: 'parents' }),
          expect.objectContaining({ name: 'children' }),
        ]),
        relationships: [expect.objectContaining({
          fromTable: 'children',
          toTable: 'parents',
          columns: [{ from: 'parent_id', to: 'id' }],
        })],
      });
    } finally {
      await editor.dispose();
    }
  });

  it('enforces readonly defaults and exposes schema, filtering, export, and undo through the runtime', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-kit-runtime-policy-'));
    tempDirs.push(tempDir);
    const databasePath = path.join(tempDir, 'fixture.sqlite');
    createRuntimeDatabase(databasePath);
    const editor = createEditor('sqlite-kit-runtime-policy', {
      assembly: createDefaultAssemblyConfig(projectRoot),
    });

    try {
      await editor.kit.load(path.join(projectRoot, 'kits/sqlite'));
      const plugin = '@itharbors/sqlite-core';
      expect(editor.plugin.callPlugin(plugin, 'openDatabase', {
        path: databasePath,
        create: false,
      })).toMatchObject({ mode: 'readonly', fileName: 'fixture.sqlite' });
      expect(editor.plugin.callPlugin(plugin, 'deleteRow', {
        name: 'members',
        identity: { kind: 'rowid', value: { type: 'integer', value: '1' } },
      })).toEqual({
        $sqliteError: {
          code: 'READ_ONLY',
          message: '当前连接为只读模式，无法修改记录。',
        },
      });

      expect(editor.plugin.callPlugin(plugin, 'getSchema')).toMatchObject({
        objects: expect.arrayContaining([
          expect.objectContaining({ name: 'members', kind: 'table' }),
          expect.objectContaining({ name: 'active_members', kind: 'view', writable: false }),
        ]),
      });
      expect(editor.plugin.callPlugin(plugin, 'getObjectSchema', { name: 'members' })).toMatchObject({
        indexes: expect.arrayContaining([expect.objectContaining({ name: 'members_name_idx' })]),
        foreignKeys: expect.arrayContaining([expect.objectContaining({ table: 'teams' })]),
      });
      expect(editor.plugin.callPlugin(plugin, 'getRows', {
        name: 'members',
        page: 1,
        pageSize: 25,
        filters: [{ column: 'name', operator: 'contains', value: 'Ali' }],
      })).toMatchObject({ total: 1, rows: [expect.any(Object)] });
      expect(editor.plugin.callPlugin(plugin, 'exportRows', {
        name: 'members',
        format: 'csv',
        search: 'Alice',
      })).toMatchObject({ format: 'csv', rows: 1, truncated: false });

      editor.plugin.callPlugin(plugin, 'setConnectionMode', { mode: 'readwrite' });
      const rows = editor.plugin.callPlugin(plugin, 'getRows', {
        name: 'members', page: 1, pageSize: 25,
      }) as { rows: Array<{ identity: unknown }> };
      const receipt = editor.plugin.callPlugin(plugin, 'deleteRow', {
        name: 'members', identity: rows.rows[0].identity,
      }) as { undoToken: string };
      expect(editor.plugin.callPlugin(plugin, 'undoLastMutation', { token: receipt.undoToken })).toMatchObject({
        undone: true,
      });
    } finally {
      await editor.dispose();
    }
  });
});
