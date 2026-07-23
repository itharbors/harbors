// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

describe('SQLite Schema panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('distinguishes a disconnected database from a missing object selection', async () => {
    const disconnected = {
      connected: false,
      path: null,
      mode: null,
      sqliteVersion: null,
      connectionRevision: 0,
      schemaRevision: 0,
      dataRevision: 0,
    };
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') {
        return { connectionRevision: 0, objectName: null };
      }
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.querySelector('.empty-state')?.textContent).toBe('请先打开 SQLite 数据库。');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('等待数据库连接');

    await definition.methods.onConnectionChanged({
      ...disconnected,
      connected: true,
      path: '/tmp/demo.sqlite',
      mode: 'readonly',
      sqliteVersion: '3.46',
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 1,
    });

    expect(document.querySelector('.empty-state')?.textContent).toBe('请从资源管理器选择一个数据库对象。');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('等待选择数据库对象');
  });

  it('renders the complete schema for the selected object as safe text', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return { connected: true, path: '/tmp/demo.sqlite', mode: 'readonly', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (method === 'getObjectSchema') return {
        name: input.name, kind: 'table', type: 'table', writable: false, readOnlyReason: '只读连接', hasRowid: true,
        sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES teams(id)); -- <script>alert(1)</script>',
        primaryKey: ['id'],
        columns: [{ name: 'id', type: 'INTEGER', notNull: false, primaryKeyOrder: 1, defaultValue: null, hidden: false, generated: false }],
        indexes: [{ name: 'users_email', unique: true, origin: 'c', partial: true, columns: ['email'] }],
        foreignKeys: [{ table: 'teams', from: 'team_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE' }],
        triggers: [{ name: 'users_touch', sql: 'CREATE TRIGGER users_touch AFTER UPDATE ON users BEGIN SELECT 1; END' }],
      };
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getObjectSchema', { name: 'users' });
    expect(document.body.textContent).toContain('users_email');
    expect(document.body.textContent).toContain('teams.id');
    expect(document.body.textContent).toContain('users_touch');
    expect(document.body.textContent).toContain('<script>alert(1)</script>');
    expect(document.querySelector('script')).toBeNull();
    const indexRow = document.querySelector('.schema-indexes .index-row');
    expect(indexRow?.querySelector('strong')?.textContent).toBe('users_email');
    expect(indexRow?.querySelector('code')?.textContent).toBe('email');
    expect(indexRow?.querySelector('small')?.textContent).toBe('UNIQUE · C · PARTIAL');
    const foreignKeyRow = document.querySelector('.schema-foreign-keys .index-row');
    expect(foreignKeyRow?.querySelector('strong')?.textContent).toBe('team_id');
    expect(foreignKeyRow?.querySelector('code')?.textContent).toBe('teams.id');
    expect(foreignKeyRow?.querySelector('small')?.textContent).toBe('ON UPDATE NO ACTION · ON DELETE CASCADE');
    (document.querySelector('[data-action="copy-ddl"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE users')));
  });

  it('restores the historical workspace hierarchy and schema section styling contract', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') {
        return { connected: true, path: '/tmp/demo.sqlite', mode: 'readonly', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      }
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') {
        return { connectionRevision: 1, objectName: 'users' };
      }
      if (method === 'getObjectSchema') {
        return {
          name: input.name, kind: 'table', type: 'table', writable: false, readOnlyReason: '只读连接', hasRowid: true,
          sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES teams(id))',
          primaryKey: ['id'],
          columns: [{ name: 'id', type: 'INTEGER', notNull: false, primaryKeyOrder: 1, defaultValue: null, hidden: false, generated: false }],
          indexes: [{ name: 'users_id', unique: true, origin: 'pk', partial: false, columns: ['id'] }],
          foreignKeys: [{ table: 'teams', from: 'team_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE' }],
          triggers: [{ name: 'users_touch', sql: 'CREATE TRIGGER users_touch AFTER UPDATE ON users BEGIN SELECT 1; END' }],
        };
      }
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > small')?.textContent).toBe('TABLE');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > h1')?.textContent).toBe('users');
    const schemaView = workspace?.querySelector(':scope > .view-host > .schema-view');
    expect(schemaView?.querySelectorAll(':scope > section')).toHaveLength(5);
    expect(schemaView?.querySelector('.schema-columns > .section-title + table')).not.toBeNull();
    expect(schemaView?.querySelector('.schema-indexes > .section-title + .index-row')).not.toBeNull();
    expect(schemaView?.querySelector('.schema-foreign-keys > .section-title + .index-row')).not.toBeNull();
    expect(schemaView?.querySelector('.schema-triggers > .section-title + .trigger-row')).not.toBeNull();
    expect(schemaView?.querySelector('.schema-definition > .section-title + .code-toolbar + .sql-code')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-bar[role="status"]')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'plugins/sqlite-schema/panel.schema/src/index.css'), 'utf8');
    expect(css).toMatch(/--ink:\s*#0b1116/);
    expect(css).toMatch(/--teal:\s*#57c8b5/);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*58px minmax\(0,\s*1fr\) 26px/s);
    expect(css).toMatch(/\.schema-view\s*\{[^}]*overflow:\s*auto/s);
  });

  it('loads a newer selection and ignores the older response', async () => {
    let resolveUsers!: (value: unknown) => void;
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return { connected: true, path: '/tmp/demo.sqlite', mode: 'readonly', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (method === 'getObjectSchema' && input.name === 'users') return new Promise((resolve) => { resolveUsers = resolve; });
      if (method === 'getObjectSchema') return { name: 'orders', type: 'table', kind: 'table', writable: false, sql: 'CREATE TABLE orders (id INTEGER)', columns: [], primaryKey: [], indexes: [], foreignKeys: [], triggers: [], hasRowid: true };
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request } });
    await vi.waitFor(() => expect(resolveUsers).toBeTypeOf('function'));
    await definition.methods.onSelectionChanged({ connectionRevision: 1, objectName: 'orders' });
    resolveUsers({ name: 'users', sql: 'STALE USERS', columns: [], indexes: [], foreignKeys: [], triggers: [] });
    await mounting;

    expect(document.body.textContent).toContain('CREATE TABLE orders');
    expect(document.body.textContent).not.toContain('STALE USERS');
  });
});
