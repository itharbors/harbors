import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const requireFromKit = createRequire(path.join(kitRoot, 'package.json'));
const pluginNames = [
  '@itharbors/mysql-core',
  '@itharbors/mysql-explorer',
  '@itharbors/mysql-data',
  '@itharbors/mysql-schema',
  '@itharbors/mysql-relationships',
  '@itharbors/mysql-sql',
];

describe('MySQL kit manifest', () => {
  it('resolves its private contracts package inside the MySQL Kit', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const contractsRoot = resolvePackageRoot('@itharbors/mysql-contracts');
    const relativeOwner = path.relative(fs.realpathSync(kitRoot), contractsRoot);

    expect(relativeOwner).not.toBe('');
    expect(relativeOwner.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativeOwner)).toBe(false);
    expect(pkg.workspaces).toEqual(['packages/*', 'plugins/*']);
    expect(pkg.dependencies['@itharbors/mysql-contracts']).toBe('file:packages/contracts');
    for (const pluginName of pluginNames) {
      const plugin = readJson(path.join(
        kitRoot,
        'plugins',
        pluginName.replace('@itharbors/', ''),
        'package.json',
      ));
      expect(plugin.dependencies['@itharbors/mysql-contracts']).toBe(
        'file:../../packages/contracts',
      );
    }
  });

  it('resolves an independently owned Relationship Graph inside the MySQL Kit', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const relationshipRoot = resolvePackageRoot('@itharbors/relationship-graph');
    const relativeOwner = path.relative(fs.realpathSync(kitRoot), relationshipRoot);
    const relationshipPlugin = readJson(path.join(
      kitRoot,
      'plugins/mysql-relationships/package.json',
    ));

    expect(relativeOwner).not.toBe('');
    expect(relativeOwner.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativeOwner)).toBe(false);
    expect(pkg.dependencies['@itharbors/relationship-graph']).toBe(
      'file:packages/relationship-graph',
    );
    expect(relationshipPlugin.dependencies['@itharbors/relationship-graph']).toBe(
      'file:../../packages/relationship-graph',
    );
  });

  it('declares six independent plugins in the native split layout', () => {
    const pkg = readJson(path.join(kitRoot, 'package.json'));
    const layout = readJson(path.join(kitRoot, 'layout.json'));
    const mainEntry = fs.readFileSync(path.join(kitRoot, 'main.html'), 'utf8');
    const secondaryEntry = fs.readFileSync(path.join(kitRoot, 'secondary.html'), 'utf8');

    expect(pkg.name).toBe('@itharbors/kit-mysql');
    const kit = readJson(path.join(kitRoot, 'kit.json'));
    expect(kit.permissions).toEqual(['network', 'credentials']);
    expect(pkg['ce-editor'].kit.menuRoot).toEqual({ id: 'mysql', label: 'MySQL' });
    expect(pkg.dependencies.mysql2).toBe('^3.23.0');
    expect(pkg['ce-editor'].kit.plugin).toEqual(pluginNames);
    expect(layout.windows[0].layout).toEqual({
      type: 'vsplit',
      sizes: [112, 1],
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
      if (name === '@itharbors/mysql-core') {
        expect(plugin.dependencies.mysql2).toBe('^3.23.0');
        expect(plugin['ce-editor'].capabilities).toEqual(['credentials']);
      } else {
        expect(plugin.dependencies?.mysql2).toBeUndefined();
        expect(plugin['ce-editor'].capabilities).toBeUndefined();
      }
    }

    const explorer = readJson(path.join(kitRoot, 'plugins/mysql-explorer/package.json'));
    const core = readJson(path.join(kitRoot, 'plugins/mysql-core/package.json'));
    expect(core['ce-editor'].contribute.message.request).toMatchObject({
      getCredentialCapability: ['getCredentialCapability'],
      listConnectionProfiles: ['listConnectionProfiles'],
      connectSaved: ['connectSaved'],
      saveCurrentConnection: ['saveCurrentConnection'],
      updateConnectionProfile: ['updateConnectionProfile'],
      deleteConnectionProfile: ['deleteConnectionProfile'],
      getDatabases: ['getDatabases'],
      selectDatabase: ['selectDatabase'],
    });
    expect(explorer['ce-editor'].contribute.panel).toEqual({
      connection: {
        entry: './panel.connection/dist/index.html',
        title: 'MySQL 数据库连接',
        minWidth: 320,
        minHeight: 112,
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
      selectDatabase: ['selectDatabase'],
      selectObject: ['selectObject'],
    });
    expect(explorer['ce-editor'].contribute.message.broadcast).toMatchObject({
      '@itharbors/mysql.connection.changed': ['onConnectionChanged', 'panel.onConnectionChanged'],
      '@itharbors/mysql.schema.changed': ['onSchemaChanged'],
      '@itharbors/mysql.objects.changed': ['panel.onObjectsChanged'],
    });
  });

});

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolvePackageRoot(packageName: string): string {
  const packageJson = requireFromKit.resolve.paths(packageName)
    ?.map((directory) => path.join(directory, packageName, 'package.json'))
    .find((candidate) => fs.existsSync(candidate));
  if (!packageJson) throw new Error(`Cannot resolve ${packageName} from ${kitRoot}`);
  return fs.realpathSync(path.dirname(packageJson));
}
