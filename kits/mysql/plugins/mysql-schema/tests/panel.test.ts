// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connected: true, endpoint: 'db.local:3306', database: 'app', mysqlVersion: '8.4.1', tls: false,
  connectionRevision: 1, schemaRevision: 2, dataRevision: 3,
};

describe('MySQL Schema panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('renders columns, indexes, foreign keys, and DDL as safe text', async () => {
    const schema = {
      name: '<img src=x onerror=alert(1)>', type: 'table', insertable: true, rowEditable: true,
      columns: [{ name: '<script>bad()</script>', type: 'int', nullable: false, defaultValue: null, extra: '', generated: false }],
      primaryKey: ['id'],
      indexes: [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['id'], prefixLengths: [null] }],
      foreignKeys: [{ name: 'users_tenant_fk', column: 'tenant_id', referencedTable: 'tenants', referencedColumn: 'id', onUpdate: 'CASCADE', onDelete: 'RESTRICT' }],
      sql: '<img src=x onerror=alert(2)> CREATE TABLE users',
    };
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (plugin === '@itharbors/mysql-core' && method === 'getObjectSchema') return schema;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.body.textContent).toContain('<script>bad()</script>');
    expect(document.body.textContent).toContain('users_tenant_fk');
    expect(document.body.textContent).toContain('ON DELETE RESTRICT');
    expect(document.querySelector('pre')?.textContent).toBe(schema.sql);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('reloads for a new selection and ignores stale connection events', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (plugin === '@itharbors/mysql-core' && method === 'getObjectSchema') return {
        name: input.name, type: 'table', insertable: true, rowEditable: true,
        columns: [], primaryKey: [], indexes: [], foreignKeys: [], sql: `CREATE TABLE ${input.name}`,
      };
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    await definition.methods.onSelectionChanged({ connectionRevision: 0, objectName: 'stale' });
    await definition.methods.onSelectionChanged({ connectionRevision: 1, objectName: 'orders' });

    expect(document.body.textContent).toContain('orders');
    expect(request).toHaveBeenLastCalledWith('@itharbors/mysql-core', 'getObjectSchema', { name: 'orders' });
  });

  it('restores the historical workspace hierarchy and schema card styling contract', async () => {
    const schema = {
      name: 'users', type: 'table', insertable: true, rowEditable: true,
      columns: [{ name: 'display_name', type: 'varchar(255)', nullable: false, defaultValue: "''", extra: 'VIRTUAL GENERATED', generated: true }],
      primaryKey: ['id'],
      indexes: [{ name: 'users_display_name', unique: false, primary: false, type: 'BTREE', columns: ['display_name'], prefixLengths: [32] }],
      foreignKeys: [{ name: 'users_team_fk', column: 'team_id', referencedTable: 'teams', referencedColumn: 'id', onUpdate: 'CASCADE', onDelete: 'RESTRICT' }],
      sql: 'CREATE TABLE users (display_name varchar(255))',
    };
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (plugin === '@itharbors/mysql-core' && method === 'getObjectSchema') return schema;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.schema/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > .object-kind')?.textContent)
      .toBe('表');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > h1.object-title')?.textContent)
      .toBe('users');
    const schemaView = workspace?.querySelector(':scope > .view-host > .schema-view');
    expect(schemaView?.querySelectorAll(':scope > .schema-card')).toHaveLength(4);
    expect(schemaView?.querySelector(':scope > .schema-columns > h2 + table > thead + tbody')).not.toBeNull();
    expect(schemaView?.querySelector(':scope > .schema-indexes > h2 + .schema-item')).not.toBeNull();
    expect(schemaView?.querySelector(':scope > .schema-foreign-keys > h2 + .schema-item')).not.toBeNull();
    expect(schemaView?.querySelector(':scope > .schema-definition > h2 + pre')).not.toBeNull();
    expect(schemaView?.textContent).toContain("''");
    expect(schemaView?.textContent).toContain('VIRTUAL GENERATED');
    expect(schemaView?.textContent).toContain('BTREE · display_name');
    expect(schemaView?.textContent).toContain('ON UPDATE CASCADE · ON DELETE RESTRICT');
    expect(workspace?.querySelector(':scope > .status-deck > [role="status"] + .error-slot')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'plugins/mysql-schema/panel.schema/src/index.css'), 'utf8');
    expect(css).toMatch(/--ink:\s*#07111d/);
    expect(css).toMatch(/--blue:\s*#4d9bd3/);
    expect(css).toMatch(/--cyan:\s*#76d0ec/);
    expect(css).toMatch(/--amber:\s*#f0ba57/);
    expect(css).toMatch(/h1\.object-title\s*\{[^}]*margin:\s*0/s);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.view-host\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.schema-view\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.schema-card\s*\{[^}]*border:\s*1px solid var\(--line\)[^}]*background:\s*var\(--panel\)/s);
  });
});
