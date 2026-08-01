import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CsvRequestError, unwrapCsvResponse } from '../../../packages/csv-contracts/src/request.ts';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('CSV kit manifest', () => {
  it('declares the focused CSV plugins and workspace layout', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(kitRoot, 'package.json'), 'utf8'));
    const layout = JSON.parse(fs.readFileSync(path.join(kitRoot, 'layout.json'), 'utf8'));

    expect(pkg.name).toBe('@itharbors/kit-csv');
    expect(pkg['ce-editor'].kit.plugin).toEqual([
      '@itharbors/csv-core',
      '@itharbors/csv-explorer',
      '@itharbors/csv-data',
    ]);
    expect(pkg['ce-editor'].kit.theme).toEqual({ '--ce-accent': '#56b6a9' });
    expect(layout.activePanel).toBe('@itharbors/csv-data.data');
    expect(layout.windows[0].layout).toEqual({
      type: 'vsplit',
      sizes: [78, 1],
      children: [
        {
          type: 'leaf',
          panel: '@itharbors/csv-explorer.connection',
          panelType: 'simple',
        },
        {
          type: 'hsplit',
          sizes: [250, 1],
          children: [
            {
              type: 'leaf',
              panel: '@itharbors/csv-explorer.explorer',
              panelType: 'simple',
            },
            {
              type: 'tab',
              activeIndex: 0,
              children: [
                { type: 'leaf', panel: '@itharbors/csv-data.data' },
                { type: 'leaf', panel: '@itharbors/csv-data.schema' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('gives every declared plugin a local package owner', () => {
    const pluginPackages = {
      core: JSON.parse(fs.readFileSync(path.join(kitRoot, 'plugins/csv-core/package.json'), 'utf8')),
      explorer: JSON.parse(fs.readFileSync(path.join(kitRoot, 'plugins/csv-explorer/package.json'), 'utf8')),
      data: JSON.parse(fs.readFileSync(path.join(kitRoot, 'plugins/csv-data/package.json'), 'utf8')),
    };

    expect(pluginPackages.core.dependencies).toEqual({
      '@itharbors/csv-contracts': '0.0.1',
      'better-sqlite3': '^12.10.1',
      'csv-parse': '^7.0.1',
      'iconv-lite': '^0.7.3',
    });
    expect(pluginPackages.explorer.dependencies).toEqual({ '@itharbors/csv-contracts': '0.0.1' });
    expect(pluginPackages.data.dependencies).toEqual({ '@itharbors/csv-contracts': '0.0.1' });
  });

  it('declares only the csv-core server request contributions', () => {
    for (const pluginName of ['csv-core', 'csv-explorer', 'csv-data']) {
      const pluginRoot = path.join(kitRoot, 'plugins', pluginName);
      const pluginPackage = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));

      if (pluginName === 'csv-core') {
        expect(pluginPackage['ce-editor']).toEqual({
          contribute: {
            message: {
              request: expect.objectContaining({
                listDirectory: ['listDirectory'],
                getDefaultDirectory: ['getDefaultDirectory'],
                sampleFile: ['sampleFile'],
                openFile: ['openFile'],
                getConnectionState: ['getConnectionState'],
                cancelOpen: ['cancelOpen'],
                closeFile: ['closeFile'],
                getSchema: ['getSchema'],
                getRows: ['getRows'],
                getColumnStats: ['getColumnStats'],
                exportRows: ['exportRows'],
                cancelExport: ['cancelExport'],
              }),
            },
          },
        });
      } else if (pluginName === 'csv-explorer') {
        expect(pluginPackage['ce-editor']).toEqual({
          contribute: {
            panel: {
              connection: {
                entry: './panel.connection/dist/index.html',
                title: 'CSV 文件连接',
                minWidth: 320,
                minHeight: 78,
                multiInstance: false,
              },
              explorer: {
                entry: './panel.explorer/dist/index.html',
                title: 'CSV 字段',
                minWidth: 220,
                minHeight: 320,
                multiInstance: false,
              },
            },
            message: {
              broadcast: {
                '@itharbors/csv.connection.changed': ['panel.onConnectionChanged', 'panel.onExplorerConnectionChanged'],
                '@itharbors/csv.progress.changed': ['panel.onProgressChanged'],
                '@itharbors/csv.schema.changed': ['panel.onSchemaChanged'],
              },
            },
          },
        });
      } else if (pluginName === 'csv-data') {
        expect(pluginPackage['ce-editor']).toEqual({
          contribute: {
            panel: {
              data: {
                entry: './panel.data/dist/index.html',
                title: 'CSV 数据',
                minWidth: 480,
                minHeight: 320,
                multiInstance: false,
              },
              schema: {
                entry: './panel.schema/dist/index.html',
                title: 'CSV 结构',
                minWidth: 420,
                minHeight: 320,
                multiInstance: false,
              },
            },
            message: {
              broadcast: {
                '@itharbors/csv.connection.changed': ['panel.onDataConnectionChanged', 'panel.onSchemaConnectionChanged'],
                '@itharbors/csv.schema.changed': ['panel.onDataSchemaChanged', 'panel.onSchemaChanged'],
                '@itharbors/csv.export.progress': ['panel.onExportProgress'],
              },
            },
          },
        });
      } else {
        expect(pluginPackage['ce-editor']).toEqual({ contribute: {} });
      }
      expect(pluginPackage.main).toBe('./main/dist/index.js');
      expect(fs.existsSync(path.join(pluginRoot, 'main/src/index.ts'))).toBe(true);
    }
  });
});

describe('CSV response contracts', () => {
  it('unwraps successful responses', () => {
    expect(unwrapCsvResponse<{ rows: string[] }>({ rows: ['one'] })).toEqual({ rows: ['one'] });
  });

  it('publishes bounded sample previews and connection metadata through shared contracts', () => {
    const input: import('../../../packages/csv-contracts/src/contracts.ts').CsvSampleInput = {
      path: '/tmp/people.csv', encoding: 'utf8', delimiter: ',',
    };
    const preview: import('../../../packages/csv-contracts/src/contracts.ts').CsvSamplePreview = {
      cells: ['name', 'city'],
      truncated: false,
    };
    const snapshot: import('../../../packages/csv-contracts/src/contracts.ts').CsvConnectionSnapshot = {
      connectionRevision: 1, phase: 'ready', path: '/tmp/people.csv', fileName: 'people.csv',
      encoding: 'utf8', delimiter: ',', hasHeader: true, progress: 1, error: null,
      byteSize: 123, rowCount: 2, columnCount: 2, irregularRowCount: 0,
    };
    expect(preview.cells).toEqual(['name', 'city']);
    expect(input.delimiter).toBe(',');
    expect(snapshot).toMatchObject({ byteSize: 123, rowCount: 2, columnCount: 2 });
  });

  it('throws a typed public error envelope', () => {
    expect(() => unwrapCsvResponse({
      $csvError: { code: 'INVALID_CSV', message: 'CSV 格式无效。', record: 3, line: 4 },
    })).toThrow(CsvRequestError);

    try {
      unwrapCsvResponse({
        $csvError: { code: 'INVALID_CSV', message: 'CSV 格式无效。', record: 3, line: 4 },
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: 'CsvRequestError',
        code: 'INVALID_CSV',
        message: 'CSV 格式无效。',
        record: 3,
        line: 4,
      });
    }
  });
});
