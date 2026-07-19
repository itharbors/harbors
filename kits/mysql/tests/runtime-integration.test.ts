import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultAssemblyConfig } from '../../../packages/server/src/assembly/config';
import { createEditor } from '../../../packages/server/src/editor/index';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const connectionUrl = process.env.MYSQL_TEST_URL;

describe.skipIf(!connectionUrl)('MySQL kit runtime integration', () => {
  it('loads through the real editor and completes schema and CRUD workflows', async () => {
    const url = new URL(connectionUrl!);
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const parentName = `harbors_parent_${suffix}`;
    const childName = `harbors_child_${suffix}`;
    const viewName = `harbors_view_${suffix}`;
    const editor = createEditor(`mysql-kit-${suffix}`, {
      assembly: createDefaultAssemblyConfig(projectRoot),
    });
    const call = <T>(method: string, input?: unknown): Promise<T> => Promise.resolve(
      input === undefined
        ? editor.plugin.callPlugin('@itharbors/mysql-workbench', method)
        : editor.plugin.callPlugin('@itharbors/mysql-workbench', method, input),
    ) as Promise<T>;
    let connected = false;

    try {
      await editor.kit.load(path.join(projectRoot, 'kits/mysql'));
      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-mysql');
      expect(editor.plugin.listLoaded()).toContain('@itharbors/mysql-workbench');

      const connection = await call<{
        connected: boolean;
        database: string;
        endpoint: string;
      }>('connect', {
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        tls: false,
      });
      connected = true;
      expect(connection).toMatchObject({
        connected: true,
        database: decodeURIComponent(url.pathname.slice(1)),
        endpoint: `${url.hostname}:${Number(url.port || 3306)}`,
      });

      await call('executeSql', {
        sql: `CREATE TABLE ${quote(parentName)} (
          tenant_id INT NOT NULL,
          id BIGINT NOT NULL,
          label VARCHAR(100) NOT NULL,
          PRIMARY KEY (tenant_id, id)
        )`,
      });
      await call('executeSql', {
        sql: `CREATE TABLE ${quote(childName)} (
          child_id INT NOT NULL PRIMARY KEY,
          parent_tenant_id INT NOT NULL,
          parent_id BIGINT NOT NULL,
          CONSTRAINT ${quote(`fk_${suffix}`)} FOREIGN KEY (parent_tenant_id, parent_id)
            REFERENCES ${quote(parentName)} (tenant_id, id)
            ON UPDATE CASCADE ON DELETE RESTRICT
        )`,
      });
      await call('executeSql', {
        sql: `CREATE VIEW ${quote(viewName)} AS SELECT tenant_id, id, label FROM ${quote(parentName)}`,
      });

      const schema = await call<{ objects: Array<{ name: string; type: string }> }>('getSchema');
      expect(schema.objects).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: parentName, type: 'table' }),
        expect.objectContaining({ name: childName, type: 'table' }),
        expect.objectContaining({ name: viewName, type: 'view' }),
      ]));

      const parentSchema = await call<{
        primaryKey: string[];
        rowEditable: boolean;
      }>('getObjectSchema', { name: parentName });
      expect(parentSchema.primaryKey).toEqual(['tenant_id', 'id']);
      expect(parentSchema.rowEditable).toBe(true);

      const childSchema = await call<{
        foreignKeys: Array<{
          name: string;
          column: string;
          referencedTable: string;
          onDelete: string;
        }>;
      }>('getObjectSchema', { name: childName });
      expect(childSchema.foreignKeys).toEqual([
        expect.objectContaining({
          name: `fk_${suffix}`,
          column: 'parent_tenant_id',
          referencedTable: parentName,
          onDelete: 'RESTRICT',
        }),
        expect.objectContaining({
          name: `fk_${suffix}`,
          column: 'parent_id',
          referencedTable: parentName,
          onDelete: 'RESTRICT',
        }),
      ]);

      const viewSchema = await call<{ type: string; insertable: boolean; rowEditable: boolean }>(
        'getObjectSchema',
        { name: viewName },
      );
      expect(viewSchema).toMatchObject({ type: 'view', insertable: false, rowEditable: false });

      await call('insertRow', {
        name: parentName,
        values: {
          tenant_id: { type: 'integer', value: '1' },
          id: { type: 'integer', value: '9007199254740993' },
          label: { type: 'text', value: 'first' },
        },
      });
      const inserted = await call<{
        total: number;
        rows: Array<{ identity: unknown; values: unknown[] }>;
      }>('getRows', { name: parentName, page: 1, pageSize: 25 });
      expect(inserted.total).toBe(1);
      expect(inserted.rows[0].identity).toEqual({
        kind: 'primary-key',
        values: {
          tenant_id: 1,
          id: { type: 'integer', mysqlType: 'BIGINT', value: '9007199254740993' },
        },
      });

      await expect(call('insertRow', {
        name: childName,
        values: {
          child_id: { type: 'integer', value: '1' },
          parent_tenant_id: { type: 'integer', value: '999' },
          parent_id: { type: 'integer', value: '9007199254740993' },
        },
      })).rejects.toMatchObject({ code: 'CONSTRAINT_FAILED' });

      await expect(call('updateRow', {
        name: parentName,
        identity: inserted.rows[0].identity,
        values: { label: { type: 'text', value: 'changed' } },
      })).resolves.toMatchObject({ changes: 1 });
      const changed = await call<{ rows: Array<{ values: unknown[] }> }>(
        'getRows',
        { name: parentName, page: 1, pageSize: 25 },
      );
      expect(changed.rows[0].values).toContain('changed');

      await expect(call('deleteRow', {
        name: parentName,
        identity: inserted.rows[0].identity,
      })).resolves.toMatchObject({ changes: 1 });
      expect((await call<{ total: number }>('getRows', {
        name: parentName,
        page: 1,
        pageSize: 25,
      })).total).toBe(0);
    } finally {
      if (connected) {
        await call('executeSql', { sql: `DROP VIEW IF EXISTS ${quote(viewName)}` }).catch(() => undefined);
        await call('executeSql', { sql: `DROP TABLE IF EXISTS ${quote(childName)}` }).catch(() => undefined);
        await call('executeSql', { sql: `DROP TABLE IF EXISTS ${quote(parentName)}` }).catch(() => undefined);
        await call('disconnect').catch(() => undefined);
      }
      await editor.dispose();
    }
  });
});

function quote(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}
