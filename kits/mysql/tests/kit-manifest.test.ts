import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const pluginNames = [
  '@itharbors/mysql-core',
  '@itharbors/mysql-explorer',
  '@itharbors/mysql-data',
  '@itharbors/mysql-schema',
  '@itharbors/mysql-relationships',
  '@itharbors/mysql-sql',
];

describe('MySQL kit manifest', () => {
  it('declares six independent plugins in the native split layout', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));
    const mainEntry = fs.readFileSync(path.join(kitRoot, 'main.html'), 'utf8');
    const secondaryEntry = fs.readFileSync(path.join(kitRoot, 'secondary.html'), 'utf8');

    expect(pkg.name).toBe('@itharbors/kit-mysql');
    expect(pkg.dependencies.mysql2).toBe('^3.23.0');
    expect(pkg['ce-editor'].kit.plugin).toEqual(pluginNames);
    expect(layout.windows[0].layout).toEqual({
      type: 'vsplit',
      sizes: [78, 1],
      children: [
        {
          type: 'leaf',
          panel: '@itharbors/mysql-explorer.connection',
          panelType: 'simple',
        },
        {
          type: 'hsplit',
          sizes: [270, 1],
          children: [
            {
              type: 'leaf',
              panel: '@itharbors/mysql-explorer.explorer',
              panelType: 'simple',
            },
            {
              type: 'tab',
              activeIndex: 0,
              children: [
                { type: 'leaf', panel: '@itharbors/mysql-data.data' },
                { type: 'leaf', panel: '@itharbors/mysql-schema.schema' },
                { type: 'leaf', panel: '@itharbors/mysql-relationships.relationships' },
                { type: 'leaf', panel: '@itharbors/mysql-sql.sql' },
              ],
            },
          ],
        },
      ],
    });
    expect(layout.activePanel).toBe('@itharbors/mysql-data.data');
    expect(mainEntry).toContain('<title>MySQL 工作台</title>');
    expect(secondaryEntry).toContain('<title>MySQL 工作台窗口</title>');

    for (const name of pluginNames) {
      const slug = name.replace('@itharbors/', '');
      const plugin = readJson(path.join(kitRoot, `plugins/${slug}/package.json`));
      expect(plugin.name).toBe(name);
      if (name === '@itharbors/mysql-core') expect(plugin.dependencies.mysql2).toBe('^3.23.0');
      else expect(plugin.dependencies?.mysql2).toBeUndefined();
    }

    const explorer = readJson(path.join(kitRoot, 'plugins/mysql-explorer/package.json'));
    expect(explorer['ce-editor'].contribute.panel).toEqual({
      connection: {
        entry: './panel.connection/dist/index.html',
        title: 'MySQL 数据库连接',
        minWidth: 320,
        minHeight: 78,
        multiInstance: false,
      },
      explorer: {
        entry: './panel.explorer/dist/index.html',
        title: 'MySQL 数据库对象',
        minWidth: 220,
        minHeight: 320,
        multiInstance: false,
      },
    });
    expect(explorer['ce-editor'].contribute.message.request).toEqual({
      getSelection: ['getSelection'],
      getObjectsSnapshot: ['getObjectsSnapshot'],
      refreshObjects: ['refreshObjects'],
      selectObject: ['selectObject'],
    });
    expect(explorer['ce-editor'].contribute.message.broadcast).toMatchObject({
      '@itharbors/mysql.connection.changed': ['onConnectionChanged', 'panel.onConnectionChanged'],
      '@itharbors/mysql.schema.changed': ['onSchemaChanged'],
      '@itharbors/mysql.objects.changed': ['panel.onObjectsChanged'],
    });
  });

  it('runs the MySQL kit tests from the repository test gate', () => {
    const rootPackage = readJson(path.join(projectRoot, 'package.json'));
    expect(rootPackage.scripts.test).toContain('npm run test -w @itharbors/kit-mysql');
  });
});

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
