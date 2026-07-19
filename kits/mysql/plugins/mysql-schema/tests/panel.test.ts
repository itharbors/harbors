// @vitest-environment jsdom
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
});
