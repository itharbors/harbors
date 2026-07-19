import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultAssemblyConfig } from '../../../packages/server/src/assembly/config';
import { createEditor } from '../../../packages/server/src/editor/index';

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
      expect(editor.plugin.listLoaded()).toContain('@itharbors/sqlite-workbench');

      editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'openDatabase', {
        path: databasePath,
        create: true,
      });
      editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'executeSql', {
        sql: 'CREATE TABLE smoke_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)',
      });
      const schema = editor.plugin.callPlugin(
        '@itharbors/sqlite-workbench',
        'getSchema',
      ) as { objects: Array<{ name: string }> };
      expect(schema.objects.map((object) => object.name)).toContain('smoke_items');

      expect(editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'insertRow', {
        name: 'smoke_items',
        values: { label: { type: 'text', value: 'first' } },
      })).toMatchObject({ changes: 1 });
      const inserted = editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'getRows', {
        name: 'smoke_items',
        page: 1,
        pageSize: 25,
      }) as { rows: Array<{ identity: unknown; values: unknown[] }>; total: number };
      expect(inserted.total).toBe(1);

      expect(editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'updateRow', {
        name: 'smoke_items',
        identity: inserted.rows[0].identity,
        values: { label: { type: 'text', value: 'changed' } },
      })).toEqual({ changes: 1 });
      expect(editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'deleteRow', {
        name: 'smoke_items',
        identity: inserted.rows[0].identity,
      })).toEqual({ changes: 1 });

      const remaining = editor.plugin.callPlugin('@itharbors/sqlite-workbench', 'getRows', {
        name: 'smoke_items',
        page: 1,
        pageSize: 25,
      }) as { total: number };
      expect(remaining.total).toBe(0);
    } finally {
      await editor.dispose();
    }
  });
});
