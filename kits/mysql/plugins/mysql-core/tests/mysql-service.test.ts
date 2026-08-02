import { describe, expect, it, vi } from 'vitest';
import { MysqlService, type PreparedConnection } from '../main/src/mysql-service';
import type { DriverResult } from '../main/src/mysql-driver';
import { FakeMysqlDriver, FakeMysqlPool } from './fake-driver';

const connectionInput = {
  host: 'db.local',
  port: 3306,
  user: 'reader',
  password: 'secret',
  database: 'app',
  tls: true,
};

describe('MysqlService connection and schema', () => {
  it('stages a probed pool until commit and discards candidates without changing active state', async () => {
    type Prepared = { readonly state: { endpoint: string | null } };
    const driver = new FakeMysqlDriver();
    const activePool = driver.queuePool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const discardedPool = driver.queuePool();
    discardedPool.queueRows([['8.4.2', 'next']], fields('version', 'database'));
    const committedPool = driver.queuePool();
    committedPool.queueRows([['8.4.3', 'next']], fields('version', 'database'));
    const service = new MysqlService(driver) as MysqlService & {
      prepareConnection?: (input: unknown) => Promise<Prepared>;
      commitPreparedConnection?: (prepared: Prepared) => ReturnType<MysqlService['getConnectionState']>;
      discardPreparedConnection?: (prepared: Prepared) => Promise<void>;
    };
    expect(service.prepareConnection).toBeTypeOf('function');
    expect(service.commitPreparedConnection).toBeTypeOf('function');
    expect(service.discardPreparedConnection).toBeTypeOf('function');

    await service.connect(connectionInput);
    const replacement = { ...connectionInput, host: 'next.local', database: 'next', password: 'next-secret' };
    const discarded = await service.prepareConnection!(replacement);
    expect(discarded.state).toMatchObject({ endpoint: 'next.local:3306' });
    expect(service.getConnectionState()).toMatchObject({ endpoint: 'db.local:3306', database: 'app' });
    expect(activePool.endCalls).toBe(0);
    expect(discardedPool.endCalls).toBe(0);
    await service.discardPreparedConnection!(discarded);
    expect(discardedPool.endCalls).toBe(1);
    expect(service.getConnectionState()).toMatchObject({ endpoint: 'db.local:3306', database: 'app' });

    const committed = await service.prepareConnection!(replacement);
    expect(service.commitPreparedConnection!(committed)).toMatchObject({
      endpoint: 'next.local:3306',
      database: 'next',
    });
    await Promise.resolve();
    expect(activePool.endCalls).toBe(1);
    expect(committedPool.endCalls).toBe(0);
    expect(service.getActiveConnectionInput()).toEqual(replacement);
  });

  it('rejects a prepared pool when active connection state changed before commit', async () => {
    type Prepared = { readonly state: { endpoint: string | null } };
    const driver = new FakeMysqlDriver();
    const activePool = driver.queuePool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const candidatePool = driver.queuePool();
    candidatePool.queueRows([['8.4.2', 'next']], fields('version', 'database'));
    const service = new MysqlService(driver) as MysqlService & {
      prepareConnection?: (input: unknown) => Promise<Prepared>;
      commitPreparedConnection?: (prepared: Prepared) => ReturnType<MysqlService['getConnectionState']>;
    };

    await service.connect(connectionInput);
    const prepared = await service.prepareConnection!({
      ...connectionInput,
      host: 'next.local',
      database: 'next',
    });
    await service.disconnect();
    expect(() => service.commitPreparedConnection!(prepared)).toThrowError(expect.objectContaining({
      code: 'STALE_CONNECTION',
    }));
    await Promise.resolve();
    expect(activePool.endCalls).toBe(1);
    expect(candidatePool.endCalls).toBe(1);
    expect(service.getConnectionState()).toMatchObject({ connected: false, endpoint: null });
  });

  it('samples connection generation before a pending probe can be overtaken', async () => {
    const driver = new FakeMysqlDriver();
    const activePool = driver.queuePool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const candidatePool = driver.queuePool();
    const pendingProbe = deferred<DriverResult>();
    vi.spyOn(candidatePool, 'query').mockImplementation(() => pendingProbe.promise);
    const service = new MysqlService(driver);

    await service.connect(connectionInput);
    const preparing = service.prepareConnection({
      ...connectionInput,
      host: 'next.local',
      database: 'next',
    });
    await service.disconnect();
    pendingProbe.resolve({
      kind: 'rows',
      rows: [['8.4.2', 'next']],
      fields: fields('version', 'database'),
    });

    await expect(preparing).rejects.toMatchObject({ code: 'STALE_CONNECTION' });
    expect(candidatePool.endCalls).toBe(1);
    expect(service.getConnectionState()).toEqual({
      connected: false,
      endpoint: null,
      database: null,
      mysqlVersion: null,
      tls: false,
    });
  });

  it('commits state synchronously and retires the previous pool in the background', async () => {
    const driver = new FakeMysqlDriver();
    const activePool = driver.queuePool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const candidatePool = driver.queuePool();
    candidatePool.queueRows([['9.0.0', 'next']], fields('version', 'database'));
    const service = new MysqlService(driver);
    await service.connect(connectionInput);
    const retirement = deferred<void>();
    let retirementStarted = false;
    vi.spyOn(activePool, 'end').mockImplementation(() => {
      retirementStarted = true;
      return retirement.promise;
    });
    const prepared = await service.prepareConnection({
      ...connectionInput,
      host: 'next.local',
      database: 'next',
    });

    const committed = service.commitPreparedConnection(prepared);

    expect(committed).toEqual({
      connected: true,
      endpoint: 'next.local:3306',
      database: 'next',
      mysqlVersion: '9.0.0',
      tls: true,
    });
    expect(service.getConnectionState()).toEqual(committed);
    expect(retirementStarted).toBe(false);
    await Promise.resolve();
    expect(retirementStarted).toBe(true);

    const disposing = service.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    retirement.resolve();
    await disposing;
    expect(candidatePool.endCalls).toBe(1);
  });

  it('drains a pending probe during dispose and rejects every later commit', async () => {
    const driver = new FakeMysqlDriver();
    const candidatePool = driver.queuePool();
    const pendingProbe = deferred<DriverResult>();
    const query = vi.spyOn(candidatePool, 'query').mockImplementation(() => pendingProbe.promise);
    const service = new MysqlService(driver);

    const preparing = service.prepareConnection(connectionInput);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const disposing = service.dispose();
    pendingProbe.resolve({
      kind: 'rows',
      rows: [['8.4.1', 'app']],
      fields: fields('version', 'database'),
    });

    await expect(preparing).rejects.toMatchObject({ code: 'STALE_CONNECTION' });
    await disposing;
    expect(candidatePool.endCalls).toBe(1);
    expect(() => service.prepareConnection(connectionInput)).toThrowError(expect.objectContaining({
      code: 'SERVICE_DISPOSED',
    }));
    expect(() => service.commitPreparedConnection({
      state: {
        connected: true,
        endpoint: 'db.local:3306',
        database: 'app',
        mysqlVersion: '8.4.1',
        tls: true,
      },
    } satisfies PreparedConnection)).toThrowError(expect.objectContaining({
      code: 'SERVICE_DISPOSED',
    }));
  });

  it('disposes active and staged pools together', async () => {
    type Prepared = { readonly state: { endpoint: string | null } };
    const driver = new FakeMysqlDriver();
    const activePool = driver.queuePool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const candidatePool = driver.queuePool();
    candidatePool.queueRows([['8.4.2', 'next']], fields('version', 'database'));
    const service = new MysqlService(driver) as MysqlService & {
      prepareConnection?: (input: unknown) => Promise<Prepared>;
    };

    await service.connect(connectionInput);
    await service.prepareConnection!({ ...connectionInput, host: 'next.local', database: 'next' });
    await service.dispose();

    expect(activePool.endCalls).toBe(1);
    expect(candidatePool.endCalls).toBe(1);
    expect(service.getConnectionState()).toMatchObject({ connected: false });
  });

  it('connects without exposing secrets and disconnects idempotently', async () => {
    const driver = new FakeMysqlDriver();
    const pool = driver.queuePool();
    pool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const service = new MysqlService(driver);

    await expect(service.connect(connectionInput)).resolves.toEqual({
      connected: true,
      endpoint: 'db.local:3306',
      database: 'app',
      mysqlVersion: '8.4.1',
      tls: true,
    });
    expect(service.getConnectionState()).not.toHaveProperty('password');
    expect(JSON.stringify(service.getConnectionState())).not.toContain('secret');
    const activeInput = service.getActiveConnectionInput();
    expect(activeInput).toEqual(connectionInput);
    activeInput!.password = 'mutated-copy';
    expect(service.getActiveConnectionInput()).toEqual(connectionInput);
    expect(pool.queries[0]?.sql).toBe(
      'SELECT VERSION() AS version, DATABASE() AS database_name',
    );

    await service.disconnect();
    expect(service.getActiveConnectionInput()).toBeNull();
    await service.disconnect();

    expect(pool.endCalls).toBe(1);
    expect(service.getConnectionState()).toEqual({
      connected: false,
      endpoint: null,
      database: null,
      mysqlVersion: null,
      tls: false,
    });
  });

  it('keeps the previous connection when a candidate probe fails', async () => {
    const driver = new FakeMysqlDriver();
    const firstPool = driver.queuePool();
    firstPool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const rejectedPool = driver.queuePool();
    rejectedPool.queueError(mysqlError('ER_ACCESS_DENIED_ERROR', 'Access denied'));
    const service = new MysqlService(driver);

    await service.connect(connectionInput);
    await expect(service.connect({
      ...connectionInput,
      host: 'other.local',
      database: 'other',
      password: 'wrong-secret',
    })).rejects.toMatchObject({ code: 'AUTH_FAILED' });

    expect(rejectedPool.endCalls).toBe(1);
    expect(firstPool.endCalls).toBe(0);
    expect(service.getConnectionState()).toMatchObject({
      connected: true,
      endpoint: 'db.local:3306',
      database: 'app',
    });
    expect(JSON.stringify(service.getConnectionState())).not.toContain('wrong-secret');
  });

  it('connects at server level, lists accessible databases, and selects one atomically', async () => {
    const driver = new FakeMysqlDriver();
    const serverPool = driver.queuePool();
    serverPool
      .queueRows([['8.4.1', null]], fields('version', 'database'))
      .queueRows([['app'], ['mysql']], fields('SCHEMA_NAME'));
    const databasePool = driver.queuePool();
    databasePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const service = new MysqlService(driver);

    await expect(service.connect({ ...connectionInput, database: null })).resolves.toMatchObject({
      connected: true,
      database: null,
    });
    await expect(service.getDatabases()).resolves.toEqual({ databases: ['app', 'mysql'] });
    expect(serverPool.queries.at(-1)?.sql).toContain('information_schema.SCHEMATA');

    await expect(service.selectDatabase({ database: 'app' })).resolves.toMatchObject({
      connected: true,
      database: 'app',
    });
    expect(driver.inputs).toEqual([
      { ...connectionInput, database: null },
      connectionInput,
    ]);
    expect(serverPool.endCalls).toBe(1);
    expect(databasePool.endCalls).toBe(0);
    expect(JSON.stringify(service.getConnectionState())).not.toContain(connectionInput.password);

    await service.selectDatabase({ database: 'app' });
    expect(driver.pools).toHaveLength(2);
  });

  it('keeps the server connection when selecting a database fails', async () => {
    const driver = new FakeMysqlDriver();
    const serverPool = driver.queuePool();
    serverPool.queueRows([['8.4.1', null]], fields('version', 'database'));
    const rejectedPool = driver.queuePool();
    rejectedPool.queueError(mysqlError('ER_BAD_DB_ERROR', 'Unknown database'));
    const service = new MysqlService(driver);

    await service.connect({ ...connectionInput, database: null });
    await expect(service.selectDatabase({ database: 'missing' })).rejects.toMatchObject({
      code: 'DATABASE_NOT_FOUND',
    });

    expect(service.getConnectionState()).toMatchObject({ connected: true, database: null });
    expect(serverPool.endCalls).toBe(0);
    expect(rejectedPool.endCalls).toBe(1);
  });

  it('returns tables and views scoped to the connected database', async () => {
    const { service, pool } = await connectedService();
    pool.queueRows([
      ['active_users', 'VIEW'],
      ['users', 'BASE TABLE'],
    ], fields('TABLE_NAME', 'TABLE_TYPE'));

    await expect(service.getSchema()).resolves.toEqual({
      objects: [
        { name: 'active_users', type: 'view', insertable: false },
        { name: 'users', type: 'table', insertable: true },
      ],
    });
    expect(pool.queries.at(-1)).toMatchObject({ values: ['app'] });
    expect(pool.queries.at(-1)?.sql).toContain('TABLE_SCHEMA = ?');
  });

  it('normalizes columns, composite keys, indexes, foreign keys, and DDL', async () => {
    const { service, pool } = await connectedService();
    queueUsersSchema(pool);

    await expect(service.getObjectSchema({ name: 'users' })).resolves.toEqual({
      name: 'users',
      type: 'table',
      insertable: true,
      rowEditable: true,
      columns: [
        {
          name: 'tenant_id',
          type: 'int',
          nullable: false,
          defaultValue: null,
          extra: '',
          generatedExpression: '',
          generated: false,
          autoIncrement: false,
          binary: false,
        },
        {
          name: 'id',
          type: 'bigint unsigned',
          nullable: false,
          defaultValue: null,
          extra: 'auto_increment',
          generatedExpression: '',
          generated: false,
          autoIncrement: true,
          binary: false,
        },
        {
          name: 'email',
          type: 'varchar(255)',
          nullable: false,
          defaultValue: null,
          extra: '',
          generatedExpression: '',
          generated: false,
          autoIncrement: false,
          binary: false,
        },
      ],
      primaryKey: ['tenant_id', 'id'],
      indexes: [
        {
          name: 'PRIMARY',
          unique: true,
          primary: true,
          type: 'BTREE',
          columns: ['tenant_id', 'id'],
          prefixLengths: [null, null],
        },
        {
          name: 'users_email',
          unique: true,
          primary: false,
          type: 'BTREE',
          columns: ['email'],
          prefixLengths: [32],
        },
      ],
      foreignKeys: [
        {
          name: 'users_tenant_fk',
          column: 'tenant_id',
          referencedTable: 'tenants',
          referencedColumn: 'id',
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
      ],
      sql: 'CREATE TABLE `users` (...)',
    });

    const metadataQueries = pool.queries.filter((query) => query.sql.includes('information_schema'));
    expect(metadataQueries).toHaveLength(4);
    for (const query of metadataQueries) {
      expect(query.sql).toContain('TABLE_SCHEMA = ?');
      expect(query.values[0]).toBe('app');
    }
  });

  it('keeps views read-only and rejects unknown objects', async () => {
    const { service, pool } = await connectedService();
    pool
      .queueRows([['active_users', 'VIEW']], fields('TABLE_NAME', 'TABLE_TYPE'))
      .queueRows([
        ['email', 'varchar(255)', 'NO', null, '', '', 1, 'varchar', 'utf8mb4'],
      ], fields('COLUMN_NAME'))
      .queueRows([], fields('INDEX_NAME'))
      .queueRows([], fields('CONSTRAINT_NAME'))
      .queueRows([['active_users', 'CREATE VIEW `active_users` AS select 1']], fields('View', 'Create View'));

    await expect(service.getObjectSchema({ name: 'active_users' })).resolves.toMatchObject({
      type: 'view',
      insertable: false,
      rowEditable: false,
      primaryKey: [],
    });

    pool.queueRows([], fields('TABLE_NAME', 'TABLE_TYPE'));
    await expect(service.getObjectSchema({ name: 'missing' })).rejects.toMatchObject({
      code: 'INVALID_OBJECT',
    });
  });

  it('builds a deterministic whole-database graph from declared foreign keys', async () => {
    const { service, pool } = await connectedService();
    pool
      .queueRows([
        ['active_children', 'VIEW'],
        ['children', 'BASE TABLE'],
        ['parents', 'BASE TABLE'],
      ], fields('TABLE_NAME', 'TABLE_TYPE'))
      .queueRows([
        ['children', 'child_id', 'int', 1],
        ['children', 'parent_tenant_id', 'int', 2],
        ['children', 'parent_id', 'bigint', 3],
        ['parents', 'tenant_id', 'int', 1],
        ['parents', 'id', 'bigint', 2],
      ], fields('TABLE_NAME', 'COLUMN_NAME', 'COLUMN_TYPE', 'ORDINAL_POSITION'))
      .queueRows([
        ['children', 'child_id', 1],
        ['parents', 'tenant_id', 1],
        ['parents', 'id', 2],
      ], fields('TABLE_NAME', 'COLUMN_NAME', 'SEQ_IN_INDEX'))
      .queueRows([
        ['children', 'children_parent_fk', 'parent_tenant_id', 'parents', 'tenant_id', 1, 'CASCADE', 'RESTRICT'],
        ['children', 'children_parent_fk', 'parent_id', 'parents', 'id', 2, 'CASCADE', 'RESTRICT'],
      ], fields(
        'TABLE_NAME',
        'CONSTRAINT_NAME',
        'COLUMN_NAME',
        'REFERENCED_TABLE_NAME',
        'REFERENCED_COLUMN_NAME',
        'ORDINAL_POSITION',
        'UPDATE_RULE',
        'DELETE_RULE',
      ));

    await expect(service.getRelationshipGraph()).resolves.toEqual({
      tables: [
        {
          name: 'children',
          kind: 'table',
          columns: [
            { name: 'child_id', type: 'int', primaryKeyOrder: 1, foreignKey: false },
            { name: 'parent_tenant_id', type: 'int', primaryKeyOrder: 0, foreignKey: true },
            { name: 'parent_id', type: 'bigint', primaryKeyOrder: 0, foreignKey: true },
          ],
        },
        {
          name: 'parents',
          kind: 'table',
          columns: [
            { name: 'tenant_id', type: 'int', primaryKeyOrder: 1, foreignKey: false },
            { name: 'id', type: 'bigint', primaryKeyOrder: 2, foreignKey: false },
          ],
        },
      ],
      relationships: [{
        id: 'children:children_parent_fk',
        fromTable: 'children',
        toTable: 'parents',
        columns: [
          { from: 'parent_tenant_id', to: 'tenant_id' },
          { from: 'parent_id', to: 'id' },
        ],
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      }],
    });

    expect(pool.queries.slice(-4).every((query) => query.values[0] === 'app')).toBe(true);
    expect(pool.queries.at(-1)?.sql).toContain('REFERENTIAL_CONSTRAINTS');
  });
});

describe('MysqlService rows and CRUD', () => {
  it('paginates rows in primary-key order and preserves composite identities', async () => {
    const { service, pool } = await connectedService();
    queueUsersSchema(pool);
    pool
      .queueRows([['26']], fields('total'))
      .queueRows([
        [1, '9007199254740993', 'a@example.com'],
      ], [
        { name: 'tenant_id', mysqlType: 'LONG' },
        { name: 'id', mysqlType: 'LONGLONG' },
        { name: 'email', mysqlType: 'VAR_STRING' },
      ]);

    await expect(service.getRows({ name: 'users', page: 2, pageSize: 25 })).resolves.toEqual({
      name: 'users',
      page: 2,
      pageSize: 25,
      total: 26,
      insertable: true,
      rowEditable: true,
      columns: ['tenant_id', 'id', 'email'],
      rows: [
        {
          values: [
            1,
            { type: 'integer', mysqlType: 'BIGINT', value: '9007199254740993' },
            'a@example.com',
          ],
          identity: {
            kind: 'primary-key',
            values: {
              tenant_id: 1,
              id: { type: 'integer', mysqlType: 'BIGINT', value: '9007199254740993' },
            },
          },
        },
      ],
    });

    const dataQuery = pool.queries.at(-1)!;
    expect(dataQuery.sql).toContain('ORDER BY `tenant_id`, `id`');
    expect(dataQuery.sql).toContain('LIMIT ? OFFSET ?');
    expect(dataQuery.values).toEqual([25, 25]);
  });

  it('previews and inserts into no-key tables but disables update and delete', async () => {
    const { service, pool } = await connectedService();
    queueNoKeySchema(pool);
    pool
      .queueRows([[0]], fields('total'))
      .queueRows([], [
        { name: 'message', mysqlType: 'VAR_STRING' },
      ]);

    await expect(service.getRows({ name: 'logs', page: 1, pageSize: 100 })).resolves.toMatchObject({
      insertable: true,
      rowEditable: false,
      rows: [],
    });

    queueNoKeySchema(pool);
    const insertConnection = pool.queueConnection();
    insertConnection.queueMutation(1, '0');
    await expect(service.insertRow({
      name: 'logs',
      values: { message: { type: 'text', value: 'hello' } },
    })).resolves.toEqual({ changes: 1, insertId: '0', warningStatus: 0 });
    expect(insertConnection.queries[0]).toEqual({
      sql: 'INSERT INTO `logs` (`message`) VALUES (?)',
      values: ['hello'],
    });

    queueNoKeySchema(pool);
    await expect(service.updateRow({
      name: 'logs',
      identity: { kind: 'primary-key', values: {} },
      values: { message: { type: 'text', value: 'changed' } },
    })).rejects.toMatchObject({ code: 'READ_ONLY_OBJECT' });

    queueNoKeySchema(pool);
    await expect(service.deleteRow({
      name: 'logs',
      identity: { kind: 'primary-key', values: {} },
    })).rejects.toMatchObject({ code: 'READ_ONLY_OBJECT' });
  });

  it('inserts, updates, and deletes with bound values and transactions', async () => {
    const { service, pool } = await connectedService();

    queueUsersSchema(pool);
    const insertConnection = pool.queueConnection();
    insertConnection.queueMutation(1, '9');
    await expect(service.insertRow({
      name: 'users',
      values: {
        email: { type: 'text', value: 'new@example.com' },
      },
    })).resolves.toEqual({ changes: 1, insertId: '9', warningStatus: 0 });
    expect(insertConnection.queries[0]).toEqual({
      sql: 'INSERT INTO `users` (`email`) VALUES (?)',
      values: ['new@example.com'],
    });
    expect(insertConnection.transactionEvents).toEqual(['begin', 'query', 'commit', 'release']);

    queueUsersSchema(pool);
    const updateConnection = pool.queueConnection();
    updateConnection.queueMutation(1);
    await expect(service.updateRow({
      name: 'users',
      identity: {
        kind: 'primary-key',
        values: {
          tenant_id: 1,
          id: { type: 'integer', mysqlType: 'BIGINT', value: '7' },
        },
      },
      values: { email: { type: 'text', value: 'changed@example.com' } },
    })).resolves.toEqual({ changes: 1, warningStatus: 0 });
    expect(updateConnection.queries[0]).toEqual({
      sql: 'UPDATE `users` SET `email` = ? WHERE `tenant_id` = ? AND `id` = ?',
      values: ['changed@example.com', 1, '7'],
    });
    expect(updateConnection.transactionEvents).toEqual(['begin', 'query', 'commit', 'release']);

    queueUsersSchema(pool);
    const deleteConnection = pool.queueConnection();
    deleteConnection.queueMutation(1);
    await expect(service.deleteRow({
      name: 'users',
      identity: {
        kind: 'primary-key',
        values: {
          tenant_id: 1,
          id: { type: 'integer', mysqlType: 'BIGINT', value: '7' },
        },
      },
    })).resolves.toEqual({ changes: 1, warningStatus: 0 });
    expect(deleteConnection.queries[0]).toEqual({
      sql: 'DELETE FROM `users` WHERE `tenant_id` = ? AND `id` = ?',
      values: [1, '7'],
    });
    expect(deleteConnection.transactionEvents).toEqual(['begin', 'query', 'commit', 'release']);
  });

  it('rolls back constraint failures and stale row changes', async () => {
    const { service, pool } = await connectedService();
    queueUsersSchema(pool);
    const constraintConnection = pool.queueConnection();
    constraintConnection.queueError(mysqlError('ER_DUP_ENTRY', 'Duplicate entry'));

    await expect(service.insertRow({
      name: 'users',
      values: { email: { type: 'text', value: 'duplicate@example.com' } },
    })).rejects.toMatchObject({ code: 'CONSTRAINT_FAILED' });
    expect(constraintConnection.transactionEvents).toEqual(['begin', 'query', 'rollback', 'release']);

    queueUsersSchema(pool);
    const staleConnection = pool.queueConnection();
    staleConnection.queueMutation(0);
    await expect(service.deleteRow({
      name: 'users',
      identity: {
        kind: 'primary-key',
        values: {
          tenant_id: 1,
          id: { type: 'integer', mysqlType: 'BIGINT', value: '7' },
        },
      },
    })).rejects.toMatchObject({ code: 'STALE_ROW' });
    expect(staleConnection.transactionEvents).toEqual(['begin', 'query', 'rollback', 'release']);
  });

  it('rejects generated/binary columns and views before acquiring a transaction', async () => {
    const { service, pool } = await connectedService();
    queueUsersSchema(pool, true);
    await expect(service.insertRow({
      name: 'users',
      values: { payload: { type: 'text', value: 'not-binary' } },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    queueViewSchema(pool);
    await expect(service.insertRow({
      name: 'active_users',
      values: { email: { type: 'text', value: 'a@example.com' } },
    })).rejects.toMatchObject({ code: 'READ_ONLY_OBJECT' });
  });
});

describe('MysqlService SQL and errors', () => {
  it('executes row and mutation SQL with a 500-row preview bound', async () => {
    const { service, pool } = await connectedService();
    const manyRows = Array.from({ length: 501 }, (_, index) => [index + 1]);
    pool.queueRows(manyRows, [{ name: 'id', mysqlType: 'LONG' }]);

    await expect(service.executeSql({ sql: 'SELECT id FROM users' })).resolves.toEqual({
      kind: 'rows',
      columns: ['id'],
      rows: manyRows.slice(0, 500),
      truncated: true,
      elapsedMs: expect.any(Number),
    });

    pool.queueMutation(3, '0', 1);
    await expect(service.executeSql({
      sql: 'UPDATE users SET active = 1',
    })).resolves.toEqual({
      kind: 'mutation',
      affectedRows: 3,
      insertId: '0',
      warningStatus: 1,
      elapsedMs: expect.any(Number),
    });
    await expect(service.executeSql({ sql: '   ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it.each([
    ['ECONNREFUSED', 'HOST_UNREACHABLE'],
    ['ENOTFOUND', 'HOST_UNREACHABLE'],
    ['ETIMEDOUT', 'CONNECTION_TIMEOUT'],
    ['CERT_HAS_EXPIRED', 'TLS_FAILED'],
    ['ER_BAD_DB_ERROR', 'DATABASE_NOT_FOUND'],
    ['ER_DBACCESS_DENIED_ERROR', 'PERMISSION_DENIED'],
  ])('maps connection error %s to %s without leaking the password', async (driverCode, expectedCode) => {
    const driver = new FakeMysqlDriver();
    const pool = driver.queuePool();
    pool.queueError(mysqlError(driverCode, `failure includes ${connectionInput.password}`));
    const service = new MysqlService(driver);

    const error = await service.connect(connectionInput).catch((caught) => caught) as Error & { code: string };
    expect(error.code).toBe(expectedCode);
    expect(error.message).not.toContain(connectionInput.password);
    expect(pool.endCalls).toBe(1);
  });

  it.each([
    ['ER_TABLEACCESS_DENIED_ERROR', 'PERMISSION_DENIED'],
    ['ER_PARSE_ERROR', 'SQL_SYNTAX_ERROR'],
    ['ER_LOCK_DEADLOCK', 'DEADLOCK'],
    ['ER_LOCK_WAIT_TIMEOUT', 'LOCK_TIMEOUT'],
    ['SOMETHING_NEW', 'MYSQL_ERROR'],
  ])('maps query error %s to %s', async (driverCode, expectedCode) => {
    const { service, pool } = await connectedService();
    pool.queueError(mysqlError(driverCode, 'unsafe driver detail'));

    await expect(service.executeSql({ sql: 'SELECT broken' })).rejects.toMatchObject({
      code: expectedCode,
    });
  });
});

async function connectedService(): Promise<{ service: MysqlService; pool: FakeMysqlPool }> {
  const driver = new FakeMysqlDriver();
  const pool = driver.queuePool();
  pool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
  const service = new MysqlService(driver);
  await service.connect(connectionInput);
  return { service, pool };
}

function queueUsersSchema(pool: FakeMysqlPool, includeBinary = false): void {
  const columnRows: unknown[][] = [
    ['tenant_id', 'int', 'NO', null, '', '', 1, 'int', null],
    ['id', 'bigint unsigned', 'NO', null, 'auto_increment', '', 2, 'bigint', null],
    ['email', 'varchar(255)', 'NO', null, '', '', 3, 'varchar', 'utf8mb4'],
  ];
  if (includeBinary) {
    columnRows.push(['payload', 'blob', 'YES', null, '', '', 4, 'blob', 'binary']);
  }
  pool
    .queueRows([['users', 'BASE TABLE']], fields('TABLE_NAME', 'TABLE_TYPE'))
    .queueRows(columnRows, fields('COLUMN_NAME'))
    .queueRows([
      ['PRIMARY', 0, 1, 'tenant_id', null, 'BTREE'],
      ['PRIMARY', 0, 2, 'id', null, 'BTREE'],
      ['users_email', 0, 1, 'email', 32, 'BTREE'],
    ], fields('INDEX_NAME'))
    .queueRows([
      ['users_tenant_fk', 'tenant_id', 'tenants', 'id', 1, 'CASCADE', 'RESTRICT'],
    ], fields('CONSTRAINT_NAME'))
    .queueRows([['users', 'CREATE TABLE `users` (...)']], fields('Table', 'Create Table'));
}

function queueNoKeySchema(pool: FakeMysqlPool): void {
  pool
    .queueRows([['logs', 'BASE TABLE']], fields('TABLE_NAME', 'TABLE_TYPE'))
    .queueRows([
      ['message', 'text', 'NO', null, '', '', 1, 'text', 'utf8mb4'],
    ], fields('COLUMN_NAME'))
    .queueRows([], fields('INDEX_NAME'))
    .queueRows([], fields('CONSTRAINT_NAME'))
    .queueRows([['logs', 'CREATE TABLE `logs` (...)']], fields('Table', 'Create Table'));
}

function queueViewSchema(pool: FakeMysqlPool): void {
  pool
    .queueRows([['active_users', 'VIEW']], fields('TABLE_NAME', 'TABLE_TYPE'))
    .queueRows([
      ['email', 'varchar(255)', 'NO', null, '', '', 1, 'varchar', 'utf8mb4'],
    ], fields('COLUMN_NAME'))
    .queueRows([], fields('INDEX_NAME'))
    .queueRows([], fields('CONSTRAINT_NAME'))
    .queueRows([['active_users', 'CREATE VIEW `active_users` AS select 1']], fields('View', 'Create View'));
}

function fields(...names: string[]) {
  return names.map((name) => ({ name, mysqlType: 'VAR_STRING' }));
}

function mysqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
