import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_TOPICS } from '@itharbors/mysql-contracts';
import { MysqlService, MysqlWorkbenchError } from '../main/src/mysql-service';
import { FakeMysqlPool } from './fake-driver';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: unknown): void;
    unload?(): Promise<void>;
  };
  methods: Record<string, (...args: any[]) => any>;
};

const profileId = '00112233-4455-4677-8899-aabbccddeeff';
const manualInput = {
  host: 'db.local',
  port: 3306,
  user: 'reader',
  password: 'test-password',
  database: 'app',
  tls: true,
};
const credentialProfile = {
  id: profileId,
  label: '本机开发库',
  metadata: {
    host: 'db.local', port: 3306, user: 'reader', database: 'app', tls: true,
  },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};
const publicProfile = {
  id: profileId,
  label: '本机开发库',
  host: 'db.local',
  port: 3306,
  user: 'reader',
  database: 'app',
  tls: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
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
    vi.spyOn(MysqlService.prototype, 'prepareConnection').mockResolvedValue({ state: connected });
    vi.spyOn(MysqlService.prototype, 'commitPreparedConnection').mockReturnValue(connected);
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
      'connectSaved',
      'deleteConnectionProfile',
      'deleteRow',
      'disconnect',
      'executeSql',
      'getConnectionState',
      'getCredentialCapability',
      'getDatabases',
      'getObjectSchema',
      'getRelationshipGraph',
      'getRows',
      'getSchema',
      'insertRow',
      'listConnectionProfiles',
      'saveCurrentConnection',
      'selectDatabase',
      'updateConnectionProfile',
      'updateRow',
    ]);

    const broadcast = vi.fn();
    definition!.lifecycle?.load?.({ message: { broadcast } });
    expect(definition!.methods.getConnectionState()).toMatchObject({
      connected: false,
      connectionRevision: 0,
      schemaRevision: 0,
      dataRevision: 0,
      profileId: null,
    });

    await expect(definition!.methods.connect({})).resolves.toMatchObject({
      connected: true,
      connectionRevision: 1,
      schemaRevision: 1,
      dataRevision: 1,
      profileId: null,
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

  it('serializes connection mutations and makes unload wait for the queue and service drain', async () => {
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    const connecting = deferred<typeof connected>();
    const disposing = deferred<void>();
    const disconnected = {
      connected: false, endpoint: null, database: null, mysqlVersion: null, tls: false,
    };
    let current = { ...disconnected };
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockImplementation(() => current);
    vi.spyOn(FreshMysqlService.prototype, 'prepareConnection').mockImplementation(() =>
      connecting.promise.then((state) => ({ state })));
    vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection').mockImplementation((prepared) => {
      const state = prepared.state;
        current = state;
        return state;
    });
    const disconnect = vi.spyOn(FreshMysqlService.prototype, 'disconnect').mockImplementation(() => {
      current = { ...disconnected };
      return current;
    });
    const dispose = vi.spyOn(FreshMysqlService.prototype, 'dispose').mockImplementation(() => disposing.promise);
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() } });

    const connectResult = definition.methods.connect(manualInput);
    const disconnectResult = definition.methods.disconnect();
    const unloadResult = definition.lifecycle?.unload?.();
    await Promise.resolve();

    expect(disconnect).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    connecting.resolve(connected);
    await expect(connectResult).resolves.toMatchObject({ connected: true, connectionRevision: 1 });
    await expect(disconnectResult).resolves.toMatchObject({ connected: false, connectionRevision: 2 });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    let unloaded = false;
    void unloadResult?.then(() => { unloaded = true; });
    await Promise.resolve();
    expect(unloaded).toBe(false);
    disposing.resolve();
    await unloadResult;
    expect(unloaded).toBe(true);
  });

  it('drains an entered row mutation before unload and rejects later pool operations', async () => {
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    const pendingInsert = deferred<{ changes: number; insertId: string; warningStatus: number }>();
    const events: string[] = [];
    const insertRow = vi.spyOn(FreshMysqlService.prototype, 'insertRow')
      .mockImplementation(() => pendingInsert.promise);
    const dispose = vi.spyOn(FreshMysqlService.prototype, 'dispose').mockImplementation(async () => {
      events.push('dispose');
    });
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue({
      connected: true,
      endpoint: 'db.local:3306',
      database: 'app',
      mysqlVersion: '8.4.1',
      tls: true,
    });
    const definition = await loadPlugin();
    const broadcast = vi.fn((topic: string) => {
      if (topic === CORE_TOPICS.dataChanged) events.push('broadcast');
    });
    definition.lifecycle?.load?.({ message: { broadcast } });

    const inserting = definition.methods.insertRow({ name: 'users', values: { name: 'Ada' } });
    await vi.waitFor(() => expect(insertRow).toHaveBeenCalledOnce());
    const unloading = definition.lifecycle!.unload!();
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    pendingInsert.resolve({ changes: 1, insertId: '9', warningStatus: 0 });
    await expect(inserting).resolves.toEqual({ changes: 1, insertId: '9', warningStatus: 0 });
    await unloading;
    expect(events).toEqual(['broadcast', 'dispose']);

    await expect(definition.methods.insertRow({ name: 'users', values: {} })).resolves.toEqual({
      $mysqlError: {
        code: 'SERVICE_DISPOSED',
        message: 'MySQL plugin is unloaded',
      },
    });
    expect(definition.methods.getConnectionState()).toEqual({
      $mysqlError: {
        code: 'SERVICE_DISPOSED',
        message: 'MySQL plugin is unloaded',
      },
    });
    await expect(definition.methods.getCredentialCapability()).resolves.toEqual({
      $mysqlError: {
        code: 'SERVICE_DISPOSED',
        message: 'MySQL plugin is unloaded',
      },
    });
    await expect(definition.methods.listConnectionProfiles()).resolves.toEqual({
      $mysqlError: {
        code: 'SERVICE_DISPOSED',
        message: 'MySQL plugin is unloaded',
      },
    });
    expect(insertRow).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('drains an entered SQL revision before unload and rejects later SQL', async () => {
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    const pendingSql = deferred<{
      kind: 'mutation';
      affectedRows: number;
      insertId: string;
      warningStatus: number;
      elapsedMs: number;
    }>();
    const events: string[] = [];
    const executeSql = vi.spyOn(FreshMysqlService.prototype, 'executeSql')
      .mockImplementation(() => pendingSql.promise);
    const dispose = vi.spyOn(FreshMysqlService.prototype, 'dispose').mockImplementation(async () => {
      events.push('dispose');
    });
    const definition = await loadPlugin();
    const broadcast = vi.fn((topic: string) => {
      if (topic === CORE_TOPICS.dataChanged) events.push('broadcast');
    });
    definition.lifecycle?.load?.({ message: { broadcast } });

    const executing = definition.methods.executeSql({ sql: 'UPDATE users SET active = 1' });
    await vi.waitFor(() => expect(executeSql).toHaveBeenCalledOnce());
    const unloading = definition.lifecycle!.unload!();
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    pendingSql.resolve({
      kind: 'mutation',
      affectedRows: 1,
      insertId: '0',
      warningStatus: 0,
      elapsedMs: 1,
    });
    await expect(executing).resolves.toMatchObject({ kind: 'mutation', affectedRows: 1 });
    await unloading;
    expect(events).toEqual(['broadcast', 'dispose']);

    await expect(definition.methods.executeSql({ sql: 'DELETE FROM users' })).resolves.toEqual({
      $mysqlError: {
        code: 'SERVICE_DISPOSED',
        message: 'MySQL plugin is unloaded',
      },
    });
    expect(executeSql).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
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
    vi.spyOn(FreshMysqlService.prototype, 'prepareConnection').mockResolvedValue({ state: serverConnection });
    vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection')
      .mockReturnValueOnce(serverConnection)
      .mockReturnValueOnce(selectedConnection);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(serverConnection);
    vi.spyOn(FreshMysqlService.prototype, 'getDatabases').mockResolvedValue({ databases: ['app', 'mysql'] });
    const selectDatabase = vi.spyOn(FreshMysqlService.prototype, 'prepareDatabaseSelection')
      .mockResolvedValue({ state: selectedConnection });

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
      profileId: null,
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

  it('keeps manual connections working without a vault and never auto-connects', async () => {
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const { prepare: connect } = mockAtomicConnection(FreshMysqlService);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);

    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast } });

    await expect(definition.methods.getCredentialCapability()).resolves.toEqual({
      available: false,
      reason: 'CREDENTIALS_DISABLED',
    });
    expect(connect).not.toHaveBeenCalled();
    await expect(definition.methods.connect(manualInput)).resolves.toMatchObject({
      connected: true,
      profileId: null,
    });
    expect(connect).toHaveBeenCalledWith(manualInput);
    expect(JSON.stringify(definition.methods.getConnectionState())).not.toContain(manualInput.password);
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain(manualInput.password);
  });

  it('reports an unavailable vault without affecting manual mode', async () => {
    const vault = fakeVault();
    vault.available.mockResolvedValue(false);
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    mockAtomicConnection(FreshMysqlService);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() }, credentials: vault });

    await expect(definition.methods.getCredentialCapability()).resolves.toEqual({
      available: false,
      reason: 'CREDENTIALS_UNAVAILABLE',
    });
    expect(vault.list).not.toHaveBeenCalled();
    expect(vault.get).not.toHaveBeenCalled();
    await expect(definition.methods.connect(manualInput)).resolves.toMatchObject({
      connected: true,
      profileId: null,
    });
  });

  it('saves only the last successful manual connection and keeps the secret out of public state', async () => {
    const vault = fakeVault();
    vault.put.mockResolvedValue(credentialProfile);
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    mockAtomicConnection(FreshMysqlService);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    vi.spyOn(FreshMysqlService.prototype, 'getActiveConnectionInput').mockReturnValue({ ...manualInput });
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });

    const manualSnapshot = await definition.methods.connect(manualInput);
    expect(manualSnapshot).toMatchObject({ connectionRevision: 1, profileId: null });
    const savedProfile = await definition.methods.saveCurrentConnection({ label: ' 本机开发库 ' });
    expect(savedProfile).toEqual(publicProfile);
    expect(vault.put).toHaveBeenCalledWith({
      label: '本机开发库',
      metadata: credentialProfile.metadata,
      secret: manualInput.password,
    });
    expect(definition.methods.getConnectionState()).toMatchObject({ profileId });
    expect(broadcast).toHaveBeenLastCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({
        connectionRevision: 2,
        schemaRevision: 1,
        dataRevision: 1,
        profileId,
      }),
    );
    expect(JSON.stringify(definition.methods.getConnectionState())).not.toContain(manualInput.password);
    expect(JSON.stringify(savedProfile)).not.toContain(manualInput.password);
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain(manualInput.password);
  });

  it('does not save before a successful manual connection or after a failed connect', async () => {
    const vault = fakeVault();
    const {
      MysqlService: FreshMysqlService,
      MysqlWorkbenchError: FreshMysqlWorkbenchError,
    } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue({
      connected: false, endpoint: null, database: null, mysqlVersion: null, tls: false,
    });
    vi.spyOn(FreshMysqlService.prototype, 'getActiveConnectionInput').mockReturnValue(null);
    vi.spyOn(FreshMysqlService.prototype, 'prepareConnection').mockRejectedValue(
      new FreshMysqlWorkbenchError('AUTH_FAILED', 'MySQL 身份验证失败'),
    );
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() }, credentials: vault });

    await expect(definition.methods.saveCurrentConnection({ label: '本机开发库' }))
      .resolves.toMatchObject({ $mysqlError: { code: 'NOT_CONNECTED' } });
    await expect(definition.methods.connect(manualInput))
      .resolves.toMatchObject({ $mysqlError: { code: 'AUTH_FAILED' } });
    await expect(definition.methods.saveCurrentConnection({ label: '本机开发库' }))
      .resolves.toMatchObject({ $mysqlError: { code: 'NOT_CONNECTED' } });
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('keeps a successful manual pool connected when saving fails', async () => {
    const vault = fakeVault();
    vault.put.mockRejectedValue(credentialError(
      'CREDENTIAL_OPERATION_FAILED',
      'native write leaked test-password',
    ));
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    mockAtomicConnection(FreshMysqlService);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    vi.spyOn(FreshMysqlService.prototype, 'getActiveConnectionInput').mockReturnValue({ ...manualInput });
    const disconnect = vi.spyOn(FreshMysqlService.prototype, 'disconnect');
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() }, credentials: vault });

    await definition.methods.connect(manualInput);
    const response = await definition.methods.saveCurrentConnection({ label: '本机开发库' });
    expect(response).toMatchObject({ $mysqlError: { code: 'CREDENTIAL_OPERATION_FAILED' } });
    expect(JSON.stringify(response)).not.toContain(manualInput.password);
    expect(disconnect).not.toHaveBeenCalled();
    expect(definition.methods.getConnectionState()).toMatchObject({ connected: true, profileId: null });
  });

  it('lists sanitized profiles and connects saved credentials without egressing the secret', async () => {
    const vault = fakeVault();
    vault.list.mockResolvedValue([credentialProfile]);
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'saved-secret' });
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const { prepare: connect } = mockAtomicConnection(FreshMysqlService);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });

    await expect(definition.methods.listConnectionProfiles()).resolves.toEqual([publicProfile]);
    const response = await definition.methods.connectSaved({ profileId });
    expect(response).toMatchObject({ connected: true, profileId });
    expect(vault.get).toHaveBeenCalledWith(profileId);
    expect(connect).toHaveBeenCalledWith({ ...credentialProfile.metadata, password: 'saved-secret' });
    expect(JSON.stringify(response)).not.toContain('saved-secret');
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('saved-secret');
    expect(JSON.stringify(await definition.methods.listConnectionProfiles())).not.toMatch(
      /saved-secret|password|secret|account|scope|reference/i,
    );
  });

  it('returns stable secret-free errors when a saved secret is missing', async () => {
    const vault = fakeVault();
    vault.get.mockRejectedValue(credentialError(
      'CREDENTIAL_PROFILE_NOT_FOUND',
      'native failure exposed saved-secret and account path',
    ));
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const connect = vi.spyOn(FreshMysqlService.prototype, 'prepareConnection');
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });

    const response = await definition.methods.connectSaved({ profileId });
    expect(response).toMatchObject({ $mysqlError: { code: 'CREDENTIAL_PROFILE_NOT_FOUND' } });
    expect(JSON.stringify(response)).not.toContain('saved-secret');
    expect(JSON.stringify(response)).not.toContain('account path');
    expect(connect).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('validates a full replacement password before updating the versioned profile', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'old-secret' });
    vault.put.mockResolvedValue({
      ...credentialProfile,
      updatedAt: '2026-08-01T01:00:00.000Z',
    });
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const prepared = { state: connected };
    const prepare = vi.spyOn(FreshMysqlService.prototype, 'prepareConnection').mockResolvedValue(prepared);
    vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection').mockReturnValue(connected);
    vi.spyOn(FreshMysqlService.prototype, 'discardPreparedConnection').mockResolvedValue();
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() }, credentials: vault });

    await expect(definition.methods.updateConnectionProfile({
      profileId,
      password: 'replacement-secret',
    })).resolves.toEqual({
      ...publicProfile,
      updatedAt: '2026-08-01T01:00:00.000Z',
    });
    expect(prepare).toHaveBeenCalledWith({
      ...credentialProfile.metadata,
      password: 'replacement-secret',
    });
    expect(vault.put).toHaveBeenCalledWith({
      id: profileId,
      label: credentialProfile.label,
      metadata: credentialProfile.metadata,
      secret: 'replacement-secret',
    });
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(vault.put.mock.invocationCallOrder[0]);
    expect(JSON.stringify(definition.methods.getConnectionState())).not.toMatch(
      /old-secret|replacement-secret/,
    );
  });

  it('keeps a staged replacement invisible until the vault update settles', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'old-secret' });
    const pendingPut = deferred<typeof credentialProfile>();
    vault.put.mockImplementation(() => pendingPut.promise);
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    let current = { ...connected };
    const candidate = { ...connected, mysqlVersion: '9.0.0' };
    const activePrepared = { state: current };
    const prepared = { state: candidate };
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockImplementation(() => current);
    const prepare = vi.spyOn(FreshMysqlService.prototype, 'prepareConnection')
      .mockResolvedValueOnce(activePrepared)
      .mockResolvedValueOnce(prepared);
    const commit = vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection')
      .mockImplementation((connection) => {
        current = connection.state;
        return current;
      });
    const discard = vi.spyOn(FreshMysqlService.prototype, 'discardPreparedConnection').mockResolvedValue();
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connectSaved({ profileId });
    broadcast.mockClear();
    prepare.mockClear();
    commit.mockClear();
    discard.mockClear();

    const update = definition.methods.updateConnectionProfile({
      profileId,
      password: 'replacement-secret',
    });
    await vi.waitFor(() => expect(vault.put).toHaveBeenCalledOnce());

    expect(prepare).toHaveBeenCalledWith({
      ...credentialProfile.metadata,
      password: 'replacement-secret',
    });
    expect(commit).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(definition.methods.getConnectionState()).toMatchObject({
      mysqlVersion: '8.4.1',
      profileId,
    });
    expect(broadcast).not.toHaveBeenCalled();

    pendingPut.resolve({ ...credentialProfile, updatedAt: '2026-08-01T01:00:00.000Z' });
    await expect(update).resolves.toEqual({
      ...publicProfile,
      updatedAt: '2026-08-01T01:00:00.000Z',
    });
    expect(commit).toHaveBeenCalledWith(prepared);
    expect(discard).not.toHaveBeenCalled();
    expect(definition.methods.getConnectionState()).toMatchObject({
      mysqlVersion: '9.0.0',
      profileId,
    });
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('replacement-secret');
  });

  it('publishes the committed profile while the previous pool is still retiring', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'old-secret' });
    vault.put.mockResolvedValue({
      ...credentialProfile,
      updatedAt: '2026-08-01T01:00:00.000Z',
    });
    const { Mysql2Driver } = await import('../main/src/mysql-driver');
    const activePool = new FakeMysqlPool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const candidatePool = new FakeMysqlPool();
    candidatePool.queueRows([['9.0.0', 'app']], fields('version', 'database'));
    vi.spyOn(Mysql2Driver.prototype, 'createPool')
      .mockReturnValueOnce(activePool)
      .mockReturnValueOnce(candidatePool);
    const retirement = deferred<void>();
    const retirementStarted = deferred<void>();
    vi.spyOn(activePool, 'end').mockImplementation(() => {
      retirementStarted.resolve();
      return retirement.promise;
    });
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connectSaved({ profileId });
    broadcast.mockClear();

    const updating = definition.methods.updateConnectionProfile({
      profileId,
      password: 'replacement-secret',
    });
    await retirementStarted.promise;

    expect(definition.methods.getConnectionState()).toMatchObject({
      mysqlVersion: '9.0.0',
      profileId,
      connectionRevision: 2,
    });
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ mysqlVersion: '9.0.0', profileId, connectionRevision: 2 }),
    );
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('replacement-secret');

    retirement.reject(new Error('retirement leaked old-secret and replacement-secret'));
    const response = await updating;
    expect(response).toEqual({
      ...publicProfile,
      updatedAt: '2026-08-01T01:00:00.000Z',
    });
    expect(JSON.stringify(response)).not.toContain('replacement-secret');
  });

  it('publishes a manual reconnect before the previous pool retirement starts', async () => {
    const { Mysql2Driver } = await import('../main/src/mysql-driver');
    const activePool = new FakeMysqlPool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const replacementPool = new FakeMysqlPool();
    replacementPool.queueRows([['9.0.0', 'next']], fields('version', 'database'));
    vi.spyOn(Mysql2Driver.prototype, 'createPool')
      .mockReturnValueOnce(activePool)
      .mockReturnValueOnce(replacementPool);
    const retirement = deferred<void>();
    const retirementStarted = deferred<void>();
    let observed: unknown;
    let definition!: PluginDefinition;
    vi.spyOn(activePool, 'end').mockImplementation(() => {
      observed = definition.methods.getConnectionState();
      retirementStarted.resolve();
      return retirement.promise;
    });
    definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast } });
    await definition.methods.connect(manualInput);
    broadcast.mockClear();

    const reconnecting = definition.methods.connect({
      ...manualInput,
      host: 'next.local',
      database: 'next',
      password: 'next-secret',
    });
    await retirementStarted.promise;

    expect(observed).toMatchObject({
      connected: true,
      endpoint: 'next.local:3306',
      database: 'next',
      mysqlVersion: '9.0.0',
      profileId: null,
      connectionRevision: 2,
    });
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ endpoint: 'next.local:3306', connectionRevision: 2 }),
    );
    retirement.reject(new Error('retirement leaked next-secret'));
    const response = await reconnecting;
    expect(JSON.stringify(response)).not.toMatch(/test-password|next-secret/);
  });

  it('publishes saved identity before the manual pool retirement starts', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'saved-secret' });
    const { Mysql2Driver } = await import('../main/src/mysql-driver');
    const activePool = new FakeMysqlPool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    const savedPool = new FakeMysqlPool();
    savedPool.queueRows([['9.0.0', 'app']], fields('version', 'database'));
    vi.spyOn(Mysql2Driver.prototype, 'createPool')
      .mockReturnValueOnce(activePool)
      .mockReturnValueOnce(savedPool);
    const retirement = deferred<void>();
    const retirementStarted = deferred<void>();
    let observed: unknown;
    let definition!: PluginDefinition;
    vi.spyOn(activePool, 'end').mockImplementation(() => {
      observed = definition.methods.getConnectionState();
      retirementStarted.resolve();
      return retirement.promise;
    });
    definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connect(manualInput);
    broadcast.mockClear();

    const reconnecting = definition.methods.connectSaved({ profileId });
    await retirementStarted.promise;

    expect(observed).toMatchObject({
      connected: true,
      mysqlVersion: '9.0.0',
      profileId,
      connectionRevision: 2,
    });
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ profileId, connectionRevision: 2 }),
    );
    retirement.reject(new Error('retirement leaked saved-secret'));
    const response = await reconnecting;
    expect(JSON.stringify(response)).not.toContain('saved-secret');
  });

  it('publishes a selected database before the server pool retirement starts', async () => {
    const { Mysql2Driver } = await import('../main/src/mysql-driver');
    const serverPool = new FakeMysqlPool();
    serverPool.queueRows([['8.4.1', null]], fields('version', 'database'));
    const databasePool = new FakeMysqlPool();
    databasePool.queueRows([['9.0.0', 'app']], fields('version', 'database'));
    vi.spyOn(Mysql2Driver.prototype, 'createPool')
      .mockReturnValueOnce(serverPool)
      .mockReturnValueOnce(databasePool);
    const retirement = deferred<void>();
    const retirementStarted = deferred<void>();
    let observed: unknown;
    let definition!: PluginDefinition;
    vi.spyOn(serverPool, 'end').mockImplementation(() => {
      observed = definition.methods.getConnectionState();
      retirementStarted.resolve();
      return retirement.promise;
    });
    definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast } });
    await definition.methods.connect({ ...manualInput, database: null });
    broadcast.mockClear();

    const selecting = definition.methods.selectDatabase({ database: 'app' });
    await retirementStarted.promise;

    expect(observed).toMatchObject({
      connected: true,
      database: 'app',
      mysqlVersion: '9.0.0',
      profileId: null,
      connectionRevision: 2,
    });
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ database: 'app', connectionRevision: 2 }),
    );
    retirement.reject(new Error('retirement leaked test-password'));
    const response = await selecting;
    expect(JSON.stringify(response)).not.toContain('test-password');
  });

  it('publishes disconnected identity before the active pool retirement starts', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'saved-secret' });
    const { Mysql2Driver } = await import('../main/src/mysql-driver');
    const activePool = new FakeMysqlPool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    vi.spyOn(Mysql2Driver.prototype, 'createPool').mockReturnValueOnce(activePool);
    const retirement = deferred<void>();
    const retirementStarted = deferred<void>();
    let observed: unknown;
    let definition!: PluginDefinition;
    vi.spyOn(activePool, 'end').mockImplementation(() => {
      observed = definition.methods.getConnectionState();
      retirementStarted.resolve();
      return retirement.promise;
    });
    definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connectSaved({ profileId });
    broadcast.mockClear();

    const disconnecting = definition.methods.disconnect();
    await retirementStarted.promise;

    expect(observed).toMatchObject({
      connected: false,
      profileId: null,
      connectionRevision: 2,
    });
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ connected: false, profileId: null, connectionRevision: 2 }),
    );
    retirement.reject(new Error('retirement leaked saved-secret'));
    const response = await disconnecting;
    expect(response).toMatchObject({ connected: false, profileId: null });
    expect(JSON.stringify(response)).not.toContain('saved-secret');
  });

  it('discards staged replacements on vault failure and preserves saved provenance', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'old-secret' });
    vault.put.mockRejectedValue(credentialError(
      'CREDENTIAL_PROFILE_CONFLICT',
      'replacement-secret leaked by backend',
    ));
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const current = { ...connected };
    const activePrepared = { state: current };
    const prepared = { state: { ...connected, mysqlVersion: '9.0.0' } };
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(current);
    vi.spyOn(FreshMysqlService.prototype, 'getActiveConnectionInput').mockReturnValue({ ...manualInput });
    const prepare = vi.spyOn(FreshMysqlService.prototype, 'prepareConnection')
      .mockResolvedValueOnce(activePrepared)
      .mockResolvedValueOnce(prepared);
    const commit = vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection').mockReturnValue(current);
    const discard = vi.spyOn(FreshMysqlService.prototype, 'discardPreparedConnection').mockResolvedValue();
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connectSaved({ profileId });
    broadcast.mockClear();
    prepare.mockClear();
    commit.mockClear();
    discard.mockClear();

    const response = await definition.methods.updateConnectionProfile({
      profileId,
      password: 'replacement-secret',
    });
    expect(response).toMatchObject({ $mysqlError: { code: 'CREDENTIAL_PROFILE_CONFLICT' } });
    expect(discard).toHaveBeenCalledWith(prepared);
    expect(commit).not.toHaveBeenCalled();
    expect(definition.methods.getConnectionState()).toMatchObject({
      mysqlVersion: '8.4.1',
      profileId,
    });
    await expect(definition.methods.saveCurrentConnection({ label: '不得保存' }))
      .resolves.toMatchObject({ $mysqlError: { code: 'NOT_CONNECTED' } });
    expect(JSON.stringify(response)).not.toContain('replacement-secret');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps the active pool and identity when staged commit fails after vault update', async () => {
    const vault = fakeVault();
    vault.get.mockImplementation(async () => ({ profile: credentialProfile, secret: 'old-secret' }));
    vault.put
      .mockResolvedValueOnce({ ...credentialProfile, updatedAt: '2026-08-01T01:00:00.000Z' })
      .mockResolvedValueOnce(credentialProfile);
    const { MysqlService: FreshMysqlService, MysqlWorkbenchError: FreshError } =
      await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const current = { ...connected };
    const activePrepared = { state: current };
    const prepared = { state: { ...connected, mysqlVersion: '9.0.0' } };
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(current);
    vi.spyOn(FreshMysqlService.prototype, 'prepareConnection')
      .mockResolvedValueOnce(activePrepared)
      .mockResolvedValueOnce(prepared);
    vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection')
      .mockReturnValueOnce(current)
      .mockImplementationOnce(() => {
        throw new FreshError('STALE_CONNECTION', 'MySQL connection changed before commit');
      });
    const discard = vi.spyOn(FreshMysqlService.prototype, 'discardPreparedConnection').mockResolvedValue();
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connectSaved({ profileId });
    broadcast.mockClear();

    const response = await definition.methods.updateConnectionProfile({
      profileId,
      password: 'replacement-secret',
    });
    expect(response).toMatchObject({ $mysqlError: { code: 'STALE_CONNECTION' } });
    expect(discard).toHaveBeenCalledWith(prepared);
    expect(definition.methods.getConnectionState()).toMatchObject({
      mysqlVersion: '8.4.1',
      profileId,
    });
    expect(vault.put).toHaveBeenCalledTimes(2);
    expect(vault.put).toHaveBeenNthCalledWith(2, {
      id: profileId,
      label: credentialProfile.label,
      metadata: credentialProfile.metadata,
      secret: 'old-secret',
    });
    expect(JSON.stringify(response)).not.toContain('replacement-secret');
    expect(JSON.stringify(response)).not.toContain('old-secret');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('returns a fixed secret-free error when commit and credential compensation both fail', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'old-secret' });
    vault.put
      .mockResolvedValueOnce({ ...credentialProfile, updatedAt: '2026-08-01T01:00:00.000Z' })
      .mockRejectedValueOnce(credentialError(
        'CREDENTIAL_OPERATION_FAILED',
        'rollback leaked old-secret and replacement-secret',
      ));
    const { MysqlService: FreshMysqlService, MysqlWorkbenchError: FreshError } =
      await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const prepared = { state: { ...connected, mysqlVersion: '9.0.0' } };
    vi.spyOn(FreshMysqlService.prototype, 'prepareConnection').mockResolvedValue(prepared);
    vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection').mockImplementation(() => {
      throw new FreshError('STALE_CONNECTION', 'commit leaked replacement-secret');
    });
    vi.spyOn(FreshMysqlService.prototype, 'discardPreparedConnection').mockResolvedValue();
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });

    const response = await definition.methods.updateConnectionProfile({
      profileId,
      password: 'replacement-secret',
    });

    expect(response).toEqual({
      $mysqlError: {
        code: 'CREDENTIAL_OPERATION_FAILED',
        message: '无法完成本机凭据操作。',
      },
    });
    expect(vault.put).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response)).not.toMatch(/old-secret|replacement-secret/);
    expect(JSON.stringify(broadcast.mock.calls)).not.toMatch(/old-secret|replacement-secret/);
  });

  it('keeps the old profile when replacement validation or vault update fails', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'old-secret' });
    const {
      MysqlService: FreshMysqlService,
      MysqlWorkbenchError: FreshMysqlWorkbenchError,
    } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    const prepared = { state: connected };
    const prepare = vi.spyOn(FreshMysqlService.prototype, 'prepareConnection')
      .mockRejectedValueOnce(new FreshMysqlWorkbenchError('AUTH_FAILED', 'MySQL 身份验证失败'))
      .mockResolvedValueOnce(prepared);
    const commit = vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection');
    const discard = vi.spyOn(FreshMysqlService.prototype, 'discardPreparedConnection').mockResolvedValue();
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockReturnValue(connected);
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });

    await expect(definition.methods.updateConnectionProfile({
      profileId, password: 'invalid-secret',
    })).resolves.toMatchObject({ $mysqlError: { code: 'AUTH_FAILED' } });
    expect(vault.put).not.toHaveBeenCalled();

    vault.put.mockRejectedValue(credentialError(
      'CREDENTIAL_PROFILE_CONFLICT',
      'failed replacement-secret write',
    ));
    const response = await definition.methods.updateConnectionProfile({
      profileId, password: 'replacement-secret',
    });
    expect(response).toMatchObject({ $mysqlError: { code: 'CREDENTIAL_PROFILE_CONFLICT' } });
    expect(JSON.stringify(response)).not.toContain('replacement-secret');
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('replacement-secret');
    expect(vault.put).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith(prepared);
    expect(commit).not.toHaveBeenCalled();
  });

  it('disconnects an active saved profile before deleting it and surfaces stale IDs safely', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'saved-secret' });
    const { MysqlService: FreshMysqlService } = await import('../main/src/mysql-service');
    vi.spyOn(FreshMysqlService.prototype, 'dispose').mockResolvedValue();
    let current = { ...connected };
    const disconnected = {
      connected: false, endpoint: null, database: null, mysqlVersion: null, tls: false,
    };
    vi.spyOn(FreshMysqlService.prototype, 'prepareConnection').mockResolvedValue({ state: current });
    vi.spyOn(FreshMysqlService.prototype, 'commitPreparedConnection').mockReturnValue(current);
    vi.spyOn(FreshMysqlService.prototype, 'getConnectionState').mockImplementation(() => current);
    const disconnect = vi.spyOn(FreshMysqlService.prototype, 'disconnect').mockImplementation(() => {
      current = disconnected;
      return disconnected;
    });
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() }, credentials: vault });

    await definition.methods.connectSaved({ profileId });
    await expect(definition.methods.deleteConnectionProfile({ profileId })).resolves.toEqual({
      deleted: true,
      profileId,
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vault.delete).toHaveBeenCalledWith(profileId);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(vault.delete.mock.invocationCallOrder[0]);
    expect(definition.methods.getConnectionState()).toMatchObject({ profileId: null });

    vault.delete.mockRejectedValue(credentialError(
      'CREDENTIAL_PROFILE_NOT_FOUND',
      'stale profile leaked account data',
    ));
    const response = await definition.methods.deleteConnectionProfile({ profileId });
    expect(response).toMatchObject({ $mysqlError: { code: 'CREDENTIAL_PROFILE_NOT_FOUND' } });
    expect(JSON.stringify(response)).not.toContain('account data');
  });

  it('keeps detached state successful when pool retirement fails during active profile deletion', async () => {
    const vault = fakeVault();
    vault.get.mockResolvedValue({ profile: credentialProfile, secret: 'saved-secret' });
    const { Mysql2Driver } = await import('../main/src/mysql-driver');
    const activePool = new FakeMysqlPool();
    activePool.queueRows([['8.4.1', 'app']], fields('version', 'database'));
    activePool.endError = new Error('retirement leaked saved-secret');
    vi.spyOn(Mysql2Driver.prototype, 'createPool').mockReturnValueOnce(activePool);
    const definition = await loadPlugin();
    const broadcast = vi.fn();
    definition.lifecycle?.load?.({ message: { broadcast }, credentials: vault });
    await definition.methods.connectSaved({ profileId });
    broadcast.mockClear();

    const response = await definition.methods.deleteConnectionProfile({ profileId });
    expect(response).toEqual({ deleted: true, profileId });
    expect(vault.delete).toHaveBeenCalledWith(profileId);
    expect(definition.methods.getConnectionState()).toMatchObject({ connected: false, profileId: null });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      CORE_TOPICS.connectionChanged,
      expect.objectContaining({ connected: false, profileId: null, connectionRevision: 2 }),
    );
    await Promise.resolve();
    expect(activePool.endCalls).toBe(1);
    expect(JSON.stringify(response)).not.toContain('saved-secret');
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('saved-secret');
  });

  it.each(['toString', 'constructor'])('does not treat prototype error code %s as credential-safe', async (code) => {
    const vault = fakeVault();
    vault.get.mockRejectedValue(credentialError(code, 'prototype error leaked saved-secret'));
    const definition = await loadPlugin();
    definition.lifecycle?.load?.({ message: { broadcast: vi.fn() }, credentials: vault });

    await expect(definition.methods.connectSaved({ profileId })).resolves.toEqual({
      $mysqlError: {
        code: 'MYSQL_ERROR',
        message: 'MySQL operation failed',
      },
    });
  });
});

async function loadPlugin(): Promise<PluginDefinition> {
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: PluginDefinition) { definition = value; } },
  };
  await import('../main/src/index');
  return definition!;
}

function fakeVault() {
  return {
    available: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    list: vi.fn<() => Promise<Array<typeof credentialProfile>>>().mockResolvedValue([]),
    get: vi.fn<(id: string) => Promise<{ profile: typeof credentialProfile; secret: string }>>(),
    put: vi.fn<(input: unknown) => Promise<typeof credentialProfile>>(),
    delete: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(),
  };
}

function credentialError(code: string, message: string): Error & { code: string } {
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

function fields(...names: string[]) {
  return names.map((name) => ({ name, mysqlType: 'VAR_STRING' }));
}

function mockAtomicConnection(
  serviceClass: typeof MysqlService,
  state = connected,
) {
  const prepared = { state };
  const prepare = vi.spyOn(serviceClass.prototype, 'prepareConnection').mockResolvedValue(prepared);
  const commit = vi.spyOn(serviceClass.prototype, 'commitPreparedConnection').mockReturnValue(state);
  return { prepared, prepare, commit };
}
