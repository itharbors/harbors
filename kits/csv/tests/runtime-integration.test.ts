import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultAssemblyConfig } from '../../../packages/server/src/assembly/config';
import { createEditor } from '../../../packages/server/src/editor/index';
import { createCsvFixture } from './fixtures/create-csv-fixture';
import { createPluginPathRoots } from './fixtures/create-plugin-path-roots';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const kitSources = [
  { directory: path.join(projectRoot, 'kits/default'), source: 'builtin' },
  { directory: path.join(projectRoot, 'kits/csv'), source: 'development' },
];

describe('CSV kit runtime integration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads all plugins and preserves source bytes through schema, query, stats, and export', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-kit-runtime-'));
    tempDirs.push(tempDir);
    const sourcePath = path.join(tempDir, 'edge-cases.csv');
    createCsvFixture(sourcePath);
    const sourceBefore = fs.readFileSync(sourcePath);
    const outputPath = path.join(tempDir, 'filtered.csv');
    const editor = createEditor('csv-kit-runtime', {
      assembly: createDefaultAssemblyConfig(projectRoot, { kitSources }),
      pluginPathRoots: createPluginPathRoots(tempDir),
    });

    try {
      await editor.kit.load(path.join(projectRoot, 'kits/csv'));
      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-csv');
      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining([
        '@itharbors/csv-core',
        '@itharbors/csv-explorer',
        '@itharbors/csv-data',
      ]));

      const plugin = '@itharbors/csv-core';
      const opened = await editor.plugin.callPlugin(plugin, 'openFile', {
        path: sourcePath,
        encoding: 'utf8',
        delimiter: ',',
        hasHeader: true,
      }) as { connectionRevision: number };
      const revision = opened.connectionRevision;

      expect(editor.plugin.callPlugin(plugin, 'getSchema')).toEqual({
        connectionRevision: revision,
        irregularRecordCount: 0,
        columns: [
          { id: 'column-1', index: 0, name: 'id', displayName: 'id' },
          { id: 'column-2', index: 1, name: '', displayName: '未命名列 2' },
          { id: 'column-3', index: 2, name: 'name', displayName: 'name' },
          { id: 'column-4', index: 3, name: 'name', displayName: 'name (2)' },
          { id: 'column-5', index: 4, name: 'note', displayName: 'note' },
        ],
      });

      const allRows = editor.plugin.callPlugin(plugin, 'getRows', {
        connectionRevision: revision,
        page: 1,
        pageSize: 25,
        search: '',
        filters: [],
        sort: null,
      });
      expect(allRows).toEqual({
        connectionRevision: revision,
        page: 1,
        pageSize: 25,
        totalRows: 3,
        rows: [
          { record: 1, values: ['0007', 'x', 'Alice', 'A-duplicate', 'hello,world'] },
          { record: 2, values: ['0010', '', 'Bob', 'B-duplicate', 'line one\r\nline two'] },
          { record: 3, values: ['0002', 'y', 'Alice', 'C-duplicate', ''] },
        ],
      });

      const query = {
        connectionRevision: revision,
        page: 1,
        pageSize: 25,
        search: '',
        filters: [{ columnId: 'column-3', operator: 'equals', value: 'alice' }],
        sort: { columnId: 'column-1', direction: 'desc' },
      };
      expect(editor.plugin.callPlugin(plugin, 'getRows', query)).toEqual({
        connectionRevision: revision,
        page: 1,
        pageSize: 25,
        totalRows: 2,
        rows: [
          { record: 1, values: ['0007', 'x', 'Alice', 'A-duplicate', 'hello,world'] },
          { record: 3, values: ['0002', 'y', 'Alice', 'C-duplicate', ''] },
        ],
      });
      expect(editor.plugin.callPlugin(plugin, 'getColumnStats', {
        connectionRevision: revision,
        columnId: 'column-2',
      })).toEqual({
        connectionRevision: revision,
        columnId: 'column-2',
        emptyCount: 1,
        nonEmptyCount: 2,
        maxLength: 1,
      });

      await expect(editor.plugin.callPlugin(plugin, 'exportRows', {
        ...query,
        exportId: 'runtime-export',
        outputPath,
      })).resolves.toMatchObject({
        connectionRevision: revision,
        exportId: 'runtime-export',
        outputPath,
        rowCount: 2,
      });
      expect(fs.readFileSync(outputPath)).toEqual(Buffer.from(
        '\uFEFFid,未命名列 2,name,name (2),note\r\n'
        + '0007,x,Alice,A-duplicate,"hello,world"\r\n'
        + '0002,y,Alice,C-duplicate,\r\n',
        'utf8',
      ));
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
    } finally {
      await editor.dispose();
    }
  });
});
