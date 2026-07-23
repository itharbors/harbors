import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OBJECTS_CHANGED_TOPIC,
  SELECTION_CHANGED_TOPIC,
} from '@itharbors/mysql-contracts';

type PluginDefinition = {
  lifecycle?: { load?(runtime: unknown): void; unload?(): void };
  methods: Record<string, (...args: any[]) => any>;
};

async function loadDefinition(): Promise<PluginDefinition> {
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: PluginDefinition) { definition = value; } },
  };
  await import('../main/src/index');
  return definition!;
}

describe('MySQL Explorer object snapshot owner', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('refreshes objects, selects the first table, and broadcasts the authoritative snapshot', async () => {
    const definition = await loadDefinition();
    const broadcast = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getDatabases') return databaseList(2, 4);
      if (method === 'getSchema') {
        return {
          connectionRevision: 2,
          schemaRevision: 4,
          dataRevision: 7,
          objects: [
            { name: 'orders', type: 'view', insertable: false },
            { name: 'users', type: 'table', insertable: true },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    definition.lifecycle?.load?.({ message: { request, broadcast } });

    await definition.methods.onConnectionChanged({
      connected: true,
      endpoint: 'db.local:3306',
      database: 'app',
      mysqlVersion: '8.4.1',
      tls: true,
      connectionRevision: 2,
      schemaRevision: 4,
      dataRevision: 7,
    });

    const expectedSnapshot = {
      connected: true,
      database: 'app',
      databases: ['app'],
      connectionRevision: 2,
      schemaRevision: 4,
      objects: [
        { name: 'orders', type: 'view', insertable: false },
        { name: 'users', type: 'table', insertable: true },
      ],
      selection: { connectionRevision: 2, objectName: 'users' },
    };
    expect(definition.methods.getObjectsSnapshot()).toEqual(expectedSnapshot);
    expect(broadcast).toHaveBeenCalledWith(OBJECTS_CHANGED_TOPIC, expectedSnapshot);
    expect(broadcast).toHaveBeenCalledWith(SELECTION_CHANGED_TOPIC, expectedSnapshot.selection);

    broadcast.mockClear();
    await expect(definition.methods.selectObject({
      connectionRevision: 1,
      objectName: 'users',
    })).rejects.toThrow(/连接已变化/);
    await expect(definition.methods.selectObject({
      connectionRevision: 2,
      objectName: 'missing',
    })).rejects.toThrow(/对象不存在/);
    await expect(definition.methods.selectObject({
      connectionRevision: 2,
      objectName: 'orders',
    })).resolves.toEqual({ connectionRevision: 2, objectName: 'orders' });

    expect(broadcast).toHaveBeenCalledWith(SELECTION_CHANGED_TOPIC, {
      connectionRevision: 2,
      objectName: 'orders',
    });
    expect(broadcast).toHaveBeenCalledWith(OBJECTS_CHANGED_TOPIC, {
      ...expectedSnapshot,
      selection: { connectionRevision: 2, objectName: 'orders' },
    });
  });

  it('publishes accessible databases without requesting schema for a server-level connection', async () => {
    const definition = await loadDefinition();
    const broadcast = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getDatabases') {
        return {
          connectionRevision: 3,
          schemaRevision: 3,
          dataRevision: 3,
          databases: ['app', 'mysql'],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    definition.lifecycle?.load?.({ message: { request, broadcast } });

    await expect(definition.methods.onConnectionChanged({
      connected: true,
      endpoint: 'db.local:3306',
      database: null,
      mysqlVersion: '8.4.1',
      tls: false,
      connectionRevision: 3,
      schemaRevision: 3,
      dataRevision: 3,
    })).resolves.toEqual({
      connected: true,
      database: null,
      databases: ['app', 'mysql'],
      connectionRevision: 3,
      schemaRevision: 3,
      objects: [],
      selection: { connectionRevision: 3, objectName: null },
    });

    expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'getDatabases');
    expect(request).not.toHaveBeenCalledWith('@itharbors/mysql-core', 'getSchema');
    expect(broadcast).toHaveBeenCalledWith(OBJECTS_CHANGED_TOPIC, expect.objectContaining({
      database: null,
      databases: ['app', 'mysql'],
    }));
  });

  it('selects a database through Core and returns the refreshed object snapshot', async () => {
    const definition = await loadDefinition();
    let revision = 1;
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      expect(plugin).toBe('@itharbors/mysql-core');
      if (method === 'getDatabases') return databaseList(revision, revision);
      if (method === 'getSchema') {
        return {
          connectionRevision: revision,
          schemaRevision: revision,
          dataRevision: revision,
          objects: [{ name: 'users', type: 'table', insertable: true }],
        };
      }
      if (method === 'selectDatabase') {
        expect(input).toEqual({ database: 'app' });
        revision = 2;
        return {
          connected: true,
          endpoint: 'db.local:3306',
          database: 'app',
          mysqlVersion: '8.4.1',
          tls: false,
          connectionRevision: revision,
          schemaRevision: revision,
          dataRevision: revision,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: null,
      connectionRevision: 1,
      schemaRevision: 1,
    });

    await expect(definition.methods.selectDatabase({ database: ' app ' })).resolves.toMatchObject({
      database: 'app',
      databases: ['app'],
      connectionRevision: 2,
      objects: [{ name: 'users', type: 'table', insertable: true }],
      selection: { connectionRevision: 2, objectName: 'users' },
    });
  });

  it('preserves valid selection, repairs invalid selection, and ignores stale connection or refresh state', async () => {
    const definition = await loadDefinition();
    const broadcast = vi.fn();
    let resolveSchema: ((value: unknown) => void) | undefined;
    let schema = {
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 1,
      objects: [
        { name: 'users', type: 'table', insertable: true },
        { name: 'audit', type: 'view', insertable: false },
      ],
    };
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases'
        ? databaseList(schema.connectionRevision, schema.schemaRevision)
        : schema
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 1,
      schemaRevision: 1,
    });
    await definition.methods.selectObject({ connectionRevision: 1, objectName: 'audit' });
    broadcast.mockClear();

    schema = { ...schema, schemaRevision: 2 };
    await definition.methods.refreshObjects();
    expect(definition.methods.getSelection()).toEqual({
      connectionRevision: 1,
      objectName: 'audit',
    });

    schema = {
      ...schema,
      schemaRevision: 3,
      objects: [{ name: 'users', type: 'table', insertable: true }],
    };
    await definition.methods.onSchemaChanged({ connectionRevision: 1, schemaRevision: 3 });
    expect(definition.methods.getSelection()).toEqual({
      connectionRevision: 1,
      objectName: 'users',
    });

    const stale = new Promise<unknown>((resolve) => { resolveSchema = resolve; });
    request.mockImplementationOnce(async () => stale);
    const pendingRefresh = definition.methods.refreshObjects();
    await definition.methods.onConnectionChanged({
      connected: false,
      database: null,
      connectionRevision: 2,
      schemaRevision: 4,
    });
    resolveSchema?.(databaseList(1, 99));
    await pendingRefresh;

    const disconnectedSnapshot = {
      connected: false,
      database: null,
      databases: [],
      connectionRevision: 2,
      schemaRevision: 4,
      objects: [],
      selection: { connectionRevision: 2, objectName: null },
    };
    expect(definition.methods.getObjectsSnapshot()).toEqual(disconnectedSnapshot);
    expect(broadcast).toHaveBeenCalledWith(OBJECTS_CHANGED_TOPIC, disconnectedSnapshot);

    await definition.methods.onConnectionChanged({
      connected: false,
      database: null,
      connectionRevision: 1,
      schemaRevision: 99,
    });
    expect(definition.methods.getObjectsSnapshot()).toEqual(disconnectedSnapshot);
  });

  it('waits for an in-flight connection refresh before validating a selection', async () => {
    const definition = await loadDefinition();
    let resolveSchema: ((value: unknown) => void) | undefined;
    const schema = new Promise<unknown>((resolve) => { resolveSchema = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases' ? databaseList(3, 5) : schema
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });

    const refresh = definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 3,
      schemaRevision: 5,
    });
    const selecting = definition.methods.selectObject({
      connectionRevision: 3,
      objectName: 'smoke_items',
    });
    resolveSchema?.({
      connectionRevision: 3,
      schemaRevision: 5,
      dataRevision: 5,
      objects: [{ name: 'smoke_items', type: 'table', insertable: true }],
    });

    await expect(refresh).resolves.toMatchObject({ connected: true });
    await expect(selecting).resolves.toEqual({
      connectionRevision: 3,
      objectName: 'smoke_items',
    });
  });

  it('publishes a consistent empty snapshot when a connection refresh fails', async () => {
    const definition = await loadDefinition();
    const broadcast = vi.fn();
    const request = vi.fn(async () => { throw new Error('schema unavailable'); });
    definition.lifecycle?.load?.({ message: { request, broadcast } });

    const expected = {
      connected: true,
      database: 'app',
      databases: [],
      connectionRevision: 4,
      schemaRevision: 6,
      objects: [],
      selection: { connectionRevision: 4, objectName: null },
      error: { message: 'schema unavailable' },
    };
    await expect(definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 4,
      schemaRevision: 6,
    })).resolves.toEqual(expected);

    expect(definition.methods.getObjectsSnapshot()).toEqual(expected);
    expect(broadcast).toHaveBeenCalledWith(SELECTION_CHANGED_TOPIC, expected.selection);
    expect(broadcast).toHaveBeenCalledWith(OBJECTS_CHANGED_TOPIC, expected);
  });

  it('keeps the last consistent snapshot when a schema-change refresh fails', async () => {
    const definition = await loadDefinition();
    let fail = false;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (fail) throw new Error('schema unavailable');
      if (method === 'getDatabases') return databaseList(5, 7);
      return {
        connectionRevision: 5,
        schemaRevision: 7,
        dataRevision: 7,
        objects: [{ name: 'users', type: 'table', insertable: true }],
      };
    });
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 5,
      schemaRevision: 7,
    });
    const beforeFailure = definition.methods.getObjectsSnapshot() as Record<string, unknown>;

    fail = true;
    await expect(definition.methods.onSchemaChanged({
      connectionRevision: 5,
      schemaRevision: 8,
    })).resolves.toEqual({ ...beforeFailure, error: { message: 'schema unavailable' } });
    expect(definition.methods.getObjectsSnapshot()).toEqual({
      ...beforeFailure,
      error: { message: 'schema unavailable' },
    });
  });

  it('waits for the newest refresh when an in-flight refresh is superseded', async () => {
    const definition = await loadDefinition();
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    const firstSchema = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
    const secondSchema = new Promise<unknown>((resolve) => { resolveSecond = resolve; });
    const schemas = [firstSchema, secondSchema];
    let schemaRequest = 0;
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases' ? databaseList(6, 9) : schemas[schemaRequest++]
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });

    const firstRefresh = definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 6,
      schemaRevision: 9,
    });
    let outcome = 'pending';
    const selecting = definition.methods.selectObject({
      connectionRevision: 6,
      objectName: 'latest',
    }).then(
      (value: unknown) => { outcome = 'resolved'; return value; },
      (caught: unknown) => { outcome = 'rejected'; throw caught; },
    );
    const secondRefresh = definition.methods.refreshObjects();

    resolveFirst?.({
      connectionRevision: 6,
      schemaRevision: 9,
      dataRevision: 9,
      objects: [{ name: 'stale', type: 'table', insertable: true }],
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(outcome).toBe('pending');

    resolveSecond?.({
      connectionRevision: 6,
      schemaRevision: 10,
      dataRevision: 10,
      objects: [{ name: 'latest', type: 'table', insertable: true }],
    });
    await expect(firstRefresh).resolves.toBeDefined();
    await expect(secondRefresh).resolves.toMatchObject({ schemaRevision: 10 });
    await expect(selecting).resolves.toEqual({ connectionRevision: 6, objectName: 'latest' });
  });

  it('converges superseded callers when the newest refresh succeeds before the old one fails', async () => {
    const definition = await loadDefinition();
    let rejectOld: ((reason?: unknown) => void) | undefined;
    let resolveNewest: ((value: unknown) => void) | undefined;
    const oldSchema = new Promise<unknown>((_resolve, reject) => { rejectOld = reject; });
    const newestSchema = new Promise<unknown>((resolve) => { resolveNewest = resolve; });
    const schemaResponses = [{
        connectionRevision: 9,
        schemaRevision: 1,
        dataRevision: 1,
        objects: [{ name: 'initial', type: 'table', insertable: true }],
      }, oldSchema, newestSchema];
    let schemaRequest = 0;
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases' ? databaseList(9, 1) : schemaResponses[schemaRequest++]
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 9,
      schemaRevision: 1,
    });

    const oldRefresh = definition.methods.refreshObjects();
    const selecting = definition.methods.selectObject({
      connectionRevision: 9,
      objectName: 'latest',
    });
    const newestRefresh = definition.methods.refreshObjects();
    const expected = {
      connected: true,
      database: 'app',
      databases: ['app'],
      connectionRevision: 9,
      schemaRevision: 3,
      objects: [{ name: 'latest', type: 'table', insertable: true }],
      selection: { connectionRevision: 9, objectName: 'latest' },
    };

    resolveNewest?.({
      connectionRevision: 9,
      schemaRevision: 3,
      dataRevision: 3,
      objects: [{ name: 'latest', type: 'table', insertable: true }],
    });
    await expect(newestRefresh).resolves.toEqual(expected);
    rejectOld?.(new Error('superseded schema failed late'));

    await expect(oldRefresh).resolves.toEqual(expected);
    await expect(selecting).resolves.toEqual(expected.selection);
    expect(definition.methods.getObjectsSnapshot()).toEqual(expected);
  });

  it('keeps superseded callers pending when the old refresh fails before the newest succeeds', async () => {
    const definition = await loadDefinition();
    let rejectOld: ((reason?: unknown) => void) | undefined;
    let resolveNewest: ((value: unknown) => void) | undefined;
    const oldSchema = new Promise<unknown>((_resolve, reject) => { rejectOld = reject; });
    const newestSchema = new Promise<unknown>((resolve) => { resolveNewest = resolve; });
    const schemaResponses = [{
        connectionRevision: 10,
        schemaRevision: 1,
        dataRevision: 1,
        objects: [{ name: 'initial', type: 'table', insertable: true }],
      }, oldSchema, newestSchema];
    let schemaRequest = 0;
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases' ? databaseList(10, 1) : schemaResponses[schemaRequest++]
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 10,
      schemaRevision: 1,
    });

    let oldOutcome = 'pending';
    let selectionOutcome = 'pending';
    const oldRefresh = definition.methods.refreshObjects().then(
      (value: unknown) => { oldOutcome = 'resolved'; return value; },
      (caught: unknown) => { oldOutcome = 'rejected'; throw caught; },
    );
    const selecting = definition.methods.selectObject({
      connectionRevision: 10,
      objectName: 'latest',
    }).then(
      (value: unknown) => { selectionOutcome = 'resolved'; return value; },
      (caught: unknown) => { selectionOutcome = 'rejected'; throw caught; },
    );
    const newestRefresh = definition.methods.refreshObjects();

    rejectOld?.(new Error('superseded schema failed early'));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(oldOutcome).toBe('pending');
    expect(selectionOutcome).toBe('pending');

    const expected = {
      connected: true,
      database: 'app',
      databases: ['app'],
      connectionRevision: 10,
      schemaRevision: 4,
      objects: [{ name: 'latest', type: 'table', insertable: true }],
      selection: { connectionRevision: 10, objectName: 'latest' },
    };
    resolveNewest?.({
      connectionRevision: 10,
      schemaRevision: 4,
      dataRevision: 4,
      objects: [{ name: 'latest', type: 'table', insertable: true }],
    });

    await expect(newestRefresh).resolves.toEqual(expected);
    await expect(oldRefresh).resolves.toEqual(expected);
    await expect(selecting).resolves.toEqual(expected.selection);
    expect(definition.methods.getObjectsSnapshot()).toEqual(expected);
  });

  it('rejects explicit callers only when the active refresh fails', async () => {
    const definition = await loadDefinition();
    let rejectSchema: ((reason?: unknown) => void) | undefined;
    const failingSchema = new Promise<unknown>((_resolve, reject) => { rejectSchema = reject; });
    const schemaResponses = [{
        connectionRevision: 11,
        schemaRevision: 1,
        dataRevision: 1,
        objects: [{ name: 'users', type: 'table', insertable: true }],
      }, failingSchema];
    let schemaRequest = 0;
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases' ? databaseList(11, 1) : schemaResponses[schemaRequest++]
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 11,
      schemaRevision: 1,
    });

    const refresh = definition.methods.refreshObjects();
    const selecting = definition.methods.selectObject({
      connectionRevision: 11,
      objectName: 'users',
    });
    const refreshExpectation = expect(refresh).rejects.toThrow('active schema failed');
    const selectionExpectation = expect(selecting).rejects.toThrow('active schema failed');
    rejectSchema?.(new Error('active schema failed'));

    await refreshExpectation;
    await selectionExpectation;
    expect(definition.methods.getObjectsSnapshot()).toMatchObject({
      connectionRevision: 11,
      schemaRevision: 1,
      selection: { connectionRevision: 11, objectName: 'users' },
    });
  });

  it('does not carry a same-named selection across connection revisions', async () => {
    const definition = await loadDefinition();
    let schema = {
      connectionRevision: 7,
      schemaRevision: 1,
      dataRevision: 1,
      objects: [{ name: 'shared', type: 'table', insertable: true }],
    };
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getDatabases'
        ? databaseList(schema.connectionRevision, schema.schemaRevision)
        : schema
    ));
    definition.lifecycle?.load?.({ message: { request, broadcast: vi.fn() } });
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 7,
      schemaRevision: 1,
    });

    schema = {
      connectionRevision: 8,
      schemaRevision: 2,
      dataRevision: 2,
      objects: [
        { name: 'first_table', type: 'table', insertable: true },
        { name: 'shared', type: 'view', insertable: false },
      ],
    };
    await definition.methods.onConnectionChanged({
      connected: true,
      database: 'app',
      connectionRevision: 8,
      schemaRevision: 2,
    });

    expect(definition.methods.getSelection()).toEqual({
      connectionRevision: 8,
      objectName: 'first_table',
    });
  });
});

function databaseList(connectionRevision: number, schemaRevision: number) {
  return {
    connectionRevision,
    schemaRevision,
    dataRevision: schemaRevision,
    databases: ['app'],
  };
}
