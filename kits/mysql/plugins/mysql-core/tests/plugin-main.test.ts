import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_TOPICS } from '@itharbors/mysql-contracts';
import { MysqlService, MysqlWorkbenchError } from '../main/src/mysql-service';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: unknown): void;
    unload?(): Promise<void>;
  };
  methods: Record<string, (...args: any[]) => any>;
};

const connected = {
  connected: true,
  endpoint: 'db.local:3306',
  database: 'app',
  mysqlVersion: '8.4.1',
  tls: true,
};

describe('MySQL core plugin main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('exposes revisioned snapshots and broadcasts only successful changes', async () => {
    const dispose = vi.spyOn(MysqlService.prototype, 'dispose').mockResolvedValue();
    vi.spyOn(MysqlService.prototype, 'connect').mockResolvedValue(connected);
    vi.spyOn(MysqlService.prototype, 'getConnectionState').mockReturnValue({
      connected: false,
      endpoint: null,
      database: null,
      mysqlVersion: null,
      tls: false,
    });
    vi.spyOn(MysqlService.prototype, 'insertRow').mockResolvedValue({
      changes: 1,
      insertId: '9',
      warningStatus: 0,
    });
    vi.spyOn(MysqlService.prototype, 'deleteRow').mockRejectedValue(
      new MysqlWorkbenchError('STALE_ROW', 'The row changed before deletion'),
    );
    vi.spyOn(MysqlService.prototype, 'executeSql')
      .mockResolvedValueOnce({
        kind: 'mutation',
        affectedRows: 0,
        insertId: '0',
        warningStatus: 0,
        elapsedMs: 1,
      })
      .mockResolvedValueOnce({
        kind: 'mutation',
        affectedRows: 2,
        insertId: '0',
        warningStatus: 0,
        elapsedMs: 1,
      });

    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: {
        define(value: PluginDefinition) {
          definition = value;
        },
      },
    };
    await import('../main/src/index');

    expect(Object.keys(definition!.methods).sort()).toEqual([
      'connect',
      'deleteRow',
      'disconnect',
      'executeSql',
      'getConnectionState',
      'getDatabases',
      'getObjectSchema',
      'getRelationshipGraph',
      'getRows',
      'getSchema',
      'insertRow',
      'selectDatabase',
      'updateRow',
    ]);

    const broadcast = vi.fn();
    definition!.lifecycle?.load?.({ message: { broadcast } });
    expect(definition!.methods.getConnectionState()).toMatchObject({
      connected: false,
      connectionRevision: 0,
      schemaRevision: 0,
      dataRevision: 0,
    });

    await expect(definition!.methods.connect({})).resolves.toMatchObject({
      connected: true,
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 1,
    });
    expect(broadcast).toHaveBeenLastCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ connectionRevision: 1 }),
    );

    await definition!.methods.insertRow({ name: 'users', values: {} });
    expect(broadcast).toHaveBeenLastCalledWith(CORE_TOPICS.dataChanged, {
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 2,
      objectName: 'users',
    });

    await expect(definition!.methods.deleteRow({ name: 'users' })).resolves.toEqual({
      $mysqlError: {
        code: 'STALE_ROW',
        message: 'The row changed before deletion',
      },
    });
    expect(broadcast).toHaveBeenCalledTimes(2);

    await definition!.methods.executeSql({ sql: '/* migrate */ CREATE TABLE logs (id INT)' });
    expect(broadcast).toHaveBeenLastCalledWith(CORE_TOPICS.schemaChanged, {
      connectionRevision: 1,
      schemaRevision: 2,
      dataRevision: 3,
    });

    await definition!.methods.executeSql({ sql: 'UPDATE users SET active = 1' });
    expect(broadcast).toHaveBeenLastCalledWith(CORE_TOPICS.dataChanged, {
      connectionRevision: 1,
      schemaRevision: 2,
      dataRevision: 4,
      objectName: null,
    });

    await definition!.lifecycle?.unload?.();
    await definition!.lifecycle?.unload?.();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('revision-wraps database lists and broadcasts successful database switches', async () => {
    const serverConnection = {
      connected: true,
      endpoint: 'db.local:3306',
      database: null,
      mysqlVersion: '8.4.1',
      tls: true,
    };
    const selectedConnection = { ...serverConnection, database: 'app' };
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    vi.spyOn(FreshMysqlService.prototype, 'connect').mockResolvedValue(serverConnection);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(serverConnection);
    vi.spyOn(FreshMysqlService.prototype, 'getDatabases').mockResolvedValue({ databases: ['app', 'mysql'] });
    const selectDatabase = vi.spyOn(FreshMysqlService.prototype, 'selectDatabase')
      .mockResolvedValue(selectedConnection);

    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: { define(value: PluginDefinition) { definition = value; } },
    };
    await import('../main/src/index');
    const broadcast = vi.fn();
    definition!.lifecycle?.load?.({ message: { broadcast } });

    await definition!.methods.connect({});
    await expect(definition!.methods.getDatabases()).resolves.toEqual({
      databases: ['app', 'mysql'],
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 1,
    });
    await expect(definition!.methods.selectDatabase({ database: 'app' })).resolves.toMatchObject({
      database: 'app',
      connectionRevision: 2,
      schemaRevision: 2,
      dataRevision: 2,
    });
    expect(selectDatabase).toHaveBeenCalledWith({ database: 'app' });
    expect(broadcast).toHaveBeenLastCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ database: 'app', connectionRevision: 2 }),
    );
  });
});
