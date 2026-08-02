import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAssemblyConfig } from '../../src/assembly/config';
import { credentialScopeDigest } from '../../src/credentials/scope';
import { CredentialStore } from '../../src/credentials/store';
import {
  CREDENTIAL_HEALTH_ACCOUNT,
  createNativeKeyringAdapter,
  type KeyringAdapter,
  type KeyringModule,
} from '../../src/credentials/keyring';
import { CredentialVault } from '../../src/credentials/vault';
import { createServer } from '../../src/server';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const mysqlKitPath = path.join(projectRoot, 'kits/mysql');
const secret = 'mysql-regression-secret-7d91';
const replacementSecret = `${secret}-updated`;
const sessionId = 'mysql-credential-leak-regression';
const mysqlCore = '@itharbors/mysql-core';

type CredentialScenarioSurfaces = {
  applicationBootstrap: unknown[];
  sessionBootstrap: unknown[];
  broadcasts: unknown[];
  panelResponses: unknown[];
  sqliteRows: SqliteSurface[];
  capturedLogs: unknown[];
};

type SqliteSurface = {
  stage: string;
  journalMode: string;
  tables: unknown[];
  files: Array<{ name: string; bytes: string }>;
};

type ConnectionInput = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  tls: boolean;
};

type DriverPool = {
  query(sql: string): Promise<{
    kind: 'rows';
    rows: unknown[][];
    fields: Array<{ name: string; mysqlType: string }>;
  }>;
  getConnection(): Promise<never>;
  end(): Promise<void>;
};

class InMemoryKeyring implements KeyringAdapter {
  readonly secrets = new Map<string, string>();
  readonly operations: Array<{ operation: 'get' | 'set' | 'delete'; account: string }> = [];

  async get(account: string): Promise<string | null> {
    this.operations.push({ operation: 'get', account });
    return this.secrets.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    this.operations.push({ operation: 'set', account });
    this.secrets.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.operations.push({ operation: 'delete', account });
    this.secrets.delete(account);
  }
}

type NativeEntryOperation = 'get' | 'set' | 'delete';

class NativeEntryHarness {
  readonly secrets = new Map<string, string>();
  readonly constructions: Array<{ service: string; account: string }> = [];
  readonly operations: Array<{
    operation: NativeEntryOperation;
    service: string;
    account: string;
  }> = [];
  private readonly failures = new Map<NativeEntryOperation, unknown[]>();

  createModule(): KeyringModule {
    const harness = this;
    return {
      getPassword(service, account) {
        harness.constructions.push({ service, account });
        harness.record('get', service, account);
        return harness.secrets.get(harness.key(service, account)) ?? null;
      },
      setPassword(service, account, secretValue) {
        harness.constructions.push({ service, account });
        harness.record('set', service, account);
        harness.secrets.set(harness.key(service, account), secretValue);
      },
      deletePassword(service, account) {
        harness.constructions.push({ service, account });
        harness.record('delete', service, account);
        return harness.secrets.delete(harness.key(service, account));
      },
    };
  }

  failNext(operation: NativeEntryOperation, error: unknown): void {
    const queued = this.failures.get(operation) ?? [];
    queued.push(error);
    this.failures.set(operation, queued);
  }

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }

  private record(operation: NativeEntryOperation, service: string, account: string): void {
    this.operations.push({ operation, service, account });
    const queued = this.failures.get(operation);
    if (!queued || queued.length === 0) return;
    const error = queued.shift();
    if (queued.length === 0) this.failures.delete(operation);
    throw error;
  }
}

class FakeMysqlDriver {
  readonly inputs: ConnectionInput[] = [];
  readonly pools: Array<DriverPool & { endCalls: number }> = [];

  createPool(input: ConnectionInput): DriverPool {
    this.inputs.push({ ...input });
    const pool: DriverPool & { endCalls: number } = {
      endCalls: 0,
      async query(sql) {
        if (sql !== 'SELECT VERSION() AS version, DATABASE() AS database_name') {
          throw new Error('Unexpected fake MySQL query');
        }
        return {
          kind: 'rows',
          rows: [['8.4.1', input.database]],
          fields: [
            { name: 'version', mysqlType: 'VAR_STRING' },
            { name: 'database_name', mysqlType: 'VAR_STRING' },
          ],
        };
      },
      async getConnection() {
        throw new Error('Unexpected fake MySQL transaction');
      },
      async end() {
        pool.endCalls += 1;
      },
    };
    this.pools.push(pool);
    return pool;
  }
}

describe('credential leak regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a saved MySQL secret out of every serializable host and browser surface', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-leak-regression-'));
    const databasePath = path.join(directory, 'harbors.sqlite');
    const nativeEntries = new NativeEntryHarness();
    const keyring = await createNativeKeyringAdapter({
      mode: 'local',
      load: async () => nativeEntries.createModule(),
    });
    const driver = new FakeMysqlDriver();

    try {
      const surfaces = await runCredentialScenario({ secret, databasePath, keyring, driver });

      expect(JSON.stringify(surfaces)).not.toContain(secret);
      for (const stage of ['saved', 'updated']) {
        const sqliteSurface = surfaces.sqliteRows.find((surface) => surface.stage === stage);
        expect(sqliteSurface?.journalMode).toBe('wal');
        expect(sqliteSurface?.files.map(({ name }) => name)).toEqual([
          'harbors.sqlite',
          'harbors.sqlite-wal',
          'harbors.sqlite-shm',
        ]);
      }
      expect(surfaces.capturedLogs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          args: [expect.objectContaining({
            name: 'Error',
            message: 'credential leak log instrumentation probe',
            cause: expect.objectContaining({ message: 'controlled secret-free cause' }),
          })],
        }),
      ]));
      expect(nativeEntries.secrets.size).toBe(0);
      expect(driver.inputs.map((input) => input.password)).toEqual([
        secret,
        secret,
        replacementSecret,
      ]);
      expect(driver.pools.every((pool) => pool.endCalls === 1)).toBe(true);

      expect(new Set(nativeEntries.operations.map(({ operation }) => operation))).toEqual(
        new Set<NativeEntryOperation>(['get', 'set', 'delete']),
      );
      expect(nativeEntries.constructions).toEqual(
        nativeEntries.operations.map(({ service, account }) => ({ service, account })),
      );
      const healthOperations = nativeEntries.operations.filter(
        ({ account }) => account === CREDENTIAL_HEALTH_ACCOUNT,
      );
      expect(healthOperations.length).toBeGreaterThan(0);
      expect(healthOperations.every(({ operation }) => operation === 'get')).toBe(true);
      for (const { service, account } of nativeEntries.operations) {
        expect(service).toBe('com.itharbors.credentials.v1');
        if (account === CREDENTIAL_HEALTH_ACCOUNT) continue;
        expect(account).toMatch(new RegExp(
          '^c9ae63325590735060748c1ce66911e4c0b1aaa7acbf610362d7d3e56d26c209:'
            + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
            + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          'u',
        ));
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps manual MySQL connections available when the local keyring backend is unavailable', async () => {
    const driver = new FakeMysqlDriver();
    const restoreDriver = await installFakeDriver(driver);
    const vault = new CredentialVault({
      mode: 'local',
      unavailableReason: 'CREDENTIALS_UNAVAILABLE',
    });
    const server = createServer({
      pluginPathRoots: createTestPluginPathRoots(),
      applicationHostMode: 'web',
      credentialMode: 'local',
      host: '127.0.0.1',
      assembly: mysqlAssembly(),
      credentialVault: vault,
    });
    let started = false;

    try {
      const port = await server.start(0);
      started = true;
      const baseUrl = `http://127.0.0.1:${port}`;
      await createMysqlSession(baseUrl);

      const capability = await requestMysql(baseUrl, 'getCredentialCapability');
      const connection = await requestMysql(baseUrl, 'connect', connectionInput(secret));
      const save = await requestMysql(baseUrl, 'saveCurrentConnection', { label: '不可用后端' });

      expect(capability).toEqual({
        mode: 'local',
        status: 'unavailable',
        available: false,
        reason: 'CREDENTIALS_UNAVAILABLE',
      });
      expect(connection).toMatchObject({ connected: true, profileId: null });
      expect(save).toEqual({
        $mysqlError: {
          code: 'CREDENTIALS_UNAVAILABLE',
          message: '本机凭据库当前不可用。',
        },
      });
      expect(JSON.stringify({ capability, connection, save })).not.toContain(secret);
      expect(driver.inputs.map((input) => input.password)).toEqual([secret]);
    } finally {
      if (started) await server.stop();
      else await server.stop().catch(() => undefined);
      restoreDriver();
    }
  });

  it('denies a credential profile to a capable plugin owned by another Kit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-cross-kit-'));
    const databasePath = path.join(directory, 'harbors.sqlite');
    const keyring = new InMemoryKeyring();
    const store = new CredentialStore(databasePath);
    const vault = new CredentialVault({ mode: 'local', store, keyring });
    const owner = vault.bind('@itharbors/kit-mysql', mysqlCore);
    const attackerKit = createCredentialProbeKit(directory);
    let profileId: string | undefined;
    let server: ReturnType<typeof createServer> | undefined;

    try {
      const profile = await owner.put({
        label: 'Owner only',
        metadata: { host: 'db.local' },
        secret,
      });
      profileId = profile.id;
      server = createServer({
        pluginPathRoots: createTestPluginPathRoots(),
        applicationHostMode: 'web',
        credentialMode: 'local',
        host: '127.0.0.1',
        dbPath: databasePath,
        assembly: createDefaultAssemblyConfig(projectRoot, {
          defaultKit: attackerKit,
          kitSources: [
            { directory: path.join(projectRoot, 'kits/default'), source: 'builtin' },
            { directory: attackerKit, source: 'explicit' },
          ],
        }),
        credentialVault: vault,
      });
      const port = await server.start(0);
      const baseUrl = `http://127.0.0.1:${port}`;
      const createResponse = await postJson(baseUrl, '/api/session', {
        sessionId,
        kit: '@example/kit-credential-probe',
      });
      expect(createResponse.status).toBe(201);

      const probe = await postJson(
        baseUrl,
        `/api/message/request?sessionId=${encodeURIComponent(sessionId)}`,
        {
          plugin: '@example/credential-probe',
          name: 'probeProfile',
          args: [profile.id],
        },
      );
      expect(probe.status).toBe(200);
      expect(probe.body).toEqual({ result: { code: 'CREDENTIAL_PROFILE_NOT_FOUND' } });
      expect(JSON.stringify(probe.body)).not.toContain(secret);
      expect(await owner.get(profile.id)).toMatchObject({ secret });
    } finally {
      if (profileId) await owner.delete(profileId).catch(() => undefined);
      if (server) await server.stop().catch(() => undefined);
      else vault.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function runCredentialScenario(input: {
  secret: string;
  databasePath: string;
  keyring: KeyringAdapter;
  driver: FakeMysqlDriver;
}): Promise<CredentialScenarioSurfaces> {
  const surfaces: CredentialScenarioSurfaces = {
    applicationBootstrap: [],
    sessionBootstrap: [],
    broadcasts: [],
    panelResponses: [],
    sqliteRows: [],
    capturedLogs: [],
  };
  const restoreLogs = captureConsole(surfaces.capturedLogs);
  console.error(Object.assign(new Error('credential leak log instrumentation probe'), {
    cause: new Error('controlled secret-free cause'),
  }));
  let restoreDriver: (() => void) | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  const start = async (): Promise<{ baseUrl: string; server: ReturnType<typeof createServer> }> => {
    const vault = new CredentialVault({
      mode: 'local',
      store: new CredentialStore(input.databasePath),
      keyring: input.keyring,
    });
    const nextServer = createServer({
      pluginPathRoots: createTestPluginPathRoots(),
      applicationHostMode: 'web',
      credentialMode: 'local',
      host: '127.0.0.1',
      dbPath: input.databasePath,
      assembly: mysqlAssembly(),
      credentialVault: vault,
    });
    const port = await nextServer.start(0);
    return { baseUrl: `http://127.0.0.1:${port}`, server: nextServer };
  };

  try {
    restoreDriver = await installFakeDriver(input.driver);
    let running = await start();
    server = running.server;
    surfaces.applicationBootstrap.push(await getJson(running.baseUrl, '/api/application/bootstrap'));
    surfaces.panelResponses.push(await createMysqlSession(running.baseUrl));
    attachBroadcastCapture(server, surfaces.broadcasts);
    surfaces.sessionBootstrap.push(await getJson(
      running.baseUrl,
      `/api/bootstrap/${encodeURIComponent(sessionId)}`,
    ));

    const firstState = await collectMysqlResponse(surfaces, running.baseUrl, 'getConnectionState');
    expect(firstState).toMatchObject({ connected: false, profileId: null });
    await collectMysqlResponse(surfaces, running.baseUrl, 'getCredentialCapability');
    await collectMysqlResponse(surfaces, running.baseUrl, 'connect', connectionInput(input.secret));
    const saved = await collectMysqlResponse(
      surfaces,
      running.baseUrl,
      'saveCurrentConnection',
      { label: '泄露回归连接' },
    ) as { id: string };
    await collectMysqlResponse(surfaces, running.baseUrl, 'listConnectionProfiles');
    surfaces.sqliteRows.push(readSqliteSurface(input.databasePath, 'saved'));

    await server.stop();
    server = undefined;
    surfaces.sqliteRows.push(readSqliteSurface(input.databasePath, 'first-stop'));

    running = await start();
    server = running.server;
    surfaces.applicationBootstrap.push(await getJson(running.baseUrl, '/api/application/bootstrap'));
    surfaces.panelResponses.push(await createMysqlSession(running.baseUrl));
    attachBroadcastCapture(server, surfaces.broadcasts);
    surfaces.sessionBootstrap.push(await getJson(
      running.baseUrl,
      `/api/bootstrap/${encodeURIComponent(sessionId)}`,
    ));

    const restartedState = await collectMysqlResponse(
      surfaces,
      running.baseUrl,
      'getConnectionState',
    );
    expect(restartedState).toMatchObject({ connected: false, profileId: null });
    await collectMysqlResponse(surfaces, running.baseUrl, 'listConnectionProfiles');
    await collectMysqlResponse(surfaces, running.baseUrl, 'connectSaved', { profileId: saved.id });
    await collectMysqlResponse(surfaces, running.baseUrl, 'updateConnectionProfile', {
      profileId: saved.id,
      password: replacementSecret,
    });
    surfaces.sqliteRows.push(readSqliteSurface(input.databasePath, 'updated'));
    await collectMysqlResponse(surfaces, running.baseUrl, 'deleteConnectionProfile', {
      profileId: saved.id,
    });
    const finalProfiles = await collectMysqlResponse(
      surfaces,
      running.baseUrl,
      'listConnectionProfiles',
    );
    expect(finalProfiles).toEqual([]);
    surfaces.sqliteRows.push(readSqliteSurface(input.databasePath, 'deleted'));

    await server.stop();
    server = undefined;
    surfaces.sqliteRows.push(readSqliteSurface(input.databasePath, 'final-stop'));
    return surfaces;
  } finally {
    if (server) await server.stop().catch(() => undefined);
    restoreDriver?.();
    restoreLogs();
  }
}

function mysqlAssembly() {
  return createDefaultAssemblyConfig(projectRoot, {
    defaultKit: mysqlKitPath,
    kitSources: [
      { directory: path.join(projectRoot, 'kits/default'), source: 'builtin' },
      { directory: mysqlKitPath, source: 'development' },
    ],
  });
}

function connectionInput(password: string): ConnectionInput {
  return {
    host: 'db.local',
    port: 3306,
    user: 'regression',
    password,
    database: 'app',
    tls: true,
  };
}

async function installFakeDriver(driver: FakeMysqlDriver): Promise<() => void> {
  const driverPath = path.join(
    mysqlKitPath,
    'plugins/mysql-core/main/dist/mysql-driver.js',
  );
  const driverModule = await import(pathToFileURL(driverPath).href) as {
    Mysql2Driver: new () => {
      createPool(input: ConnectionInput): DriverPool;
    };
  };
  const prototype = driverModule.Mysql2Driver.prototype as {
    createPool(input: ConnectionInput): DriverPool;
  };
  const spy = vi.spyOn(prototype, 'createPool')
    .mockImplementation((nextInput) => driver.createPool(nextInput));
  return () => spy.mockRestore();
}

async function createMysqlSession(baseUrl: string): Promise<unknown> {
  const response = await postJson(baseUrl, '/api/session', {
    sessionId,
    workspacePath: '/credential-leak-regression',
    kit: '@itharbors/kit-mysql',
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function requestMysql(baseUrl: string, method: string, input?: unknown): Promise<unknown> {
  const response = await postJson(
    baseUrl,
    `/api/message/request?sessionId=${encodeURIComponent(sessionId)}`,
    {
      plugin: mysqlCore,
      name: method,
      args: input === undefined ? [] : [input],
    },
  );
  expect(response.status).toBe(200);
  return (response.body as { result: unknown }).result;
}

async function collectMysqlResponse(
  surfaces: CredentialScenarioSurfaces,
  baseUrl: string,
  method: string,
  input?: unknown,
): Promise<unknown> {
  const response = await postJson(
    baseUrl,
    `/api/message/request?sessionId=${encodeURIComponent(sessionId)}`,
    {
      plugin: mysqlCore,
      name: method,
      args: input === undefined ? [] : [input],
    },
  );
  expect(response.status).toBe(200);
  surfaces.panelResponses.push(response.body);
  return (response.body as { result: unknown }).result;
}

async function getJson(baseUrl: string, route: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${route}`);
  return response.json();
}

async function postJson(
  baseUrl: string,
  route: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function attachBroadcastCapture(
  server: ReturnType<typeof createServer>,
  broadcasts: unknown[],
): void {
  const response = new Writable({
    write(chunk, _encoding, callback) {
      const serialized = String(chunk).replace(/^data: /u, '').trim();
      if (serialized !== '') broadcasts.push(JSON.parse(serialized));
      callback();
    },
  }) as unknown as ServerResponse;
  server.channel.addClient(sessionId, response);
}

function readSqliteSurface(databasePath: string, stage: string): SqliteSurface {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const journalMode = database.pragma('journal_mode', { simple: true }) as string;
    const tableNames = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tables = tableNames.map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
    const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((filename) => fs.existsSync(filename))
      .map((filename) => ({
        name: path.basename(filename),
        bytes: fs.readFileSync(filename).toString('latin1'),
      }));
    return { stage, journalMode, tables, files };
  } finally {
    database.close();
  }
}

function captureConsole(target: unknown[]): () => void {
  const capture = (level: string, args: unknown[]) => {
    target.push({ level, args: args.map(serializeLogArgument) });
  };
  const spies = [
    vi.spyOn(console, 'debug').mockImplementation((...args) => capture('debug', args)),
    vi.spyOn(console, 'error').mockImplementation((...args) => capture('error', args)),
    vi.spyOn(console, 'info').mockImplementation((...args) => capture('info', args)),
    vi.spyOn(console, 'log').mockImplementation((...args) => capture('log', args)),
    vi.spyOn(console, 'warn').mockImplementation((...args) => capture('warn', args)),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

function serializeLogArgument(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: serializeLogArgument(value.cause),
    };
  }
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function createCredentialProbeKit(root: string): string {
  const kitDirectory = path.join(root, 'credential-probe-kit');
  const pluginDirectory = path.join(kitDirectory, 'plugins/credential-probe');
  fs.mkdirSync(path.join(pluginDirectory, 'main/dist'), { recursive: true });
  fs.writeFileSync(path.join(kitDirectory, 'package.json'), JSON.stringify({
    name: '@example/kit-credential-probe',
    version: '1.0.0',
    type: 'module',
    'ce-editor': {
      kit: {
        menuRoot: { id: 'credential-probe', label: 'Credential Probe' },
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        plugin: ['@example/credential-probe'],
      },
    },
  }));
  fs.writeFileSync(path.join(kitDirectory, 'kit.json'), JSON.stringify({
    schemaVersion: 1,
    id: '@example/kit-credential-probe',
    version: '1.0.0',
    channel: 'stable',
    publisher: 'example',
    requires: { harbors: '*', kitApi: '*', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' },
    permissions: ['credentials'],
    entry: 'package.json',
  }));
  fs.writeFileSync(path.join(kitDirectory, 'layout.json'), JSON.stringify({ windows: [] }));
  fs.writeFileSync(path.join(kitDirectory, 'main.html'), '<!doctype html>');
  fs.writeFileSync(path.join(kitDirectory, 'secondary.html'), '<!doctype html>');
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({
    name: '@example/credential-probe',
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': {
      capabilities: ['credentials'],
      contribute: {
        message: { request: { probeProfile: ['probeProfile'] } },
      },
    },
  }));
  fs.writeFileSync(path.join(pluginDirectory, 'main/dist/index.js'), `
    let credentials;
    editor.plugin.define({
      lifecycle: { load(runtime) { credentials = runtime.credentials; } },
      methods: {
        async probeProfile(id) {
          try {
            await credentials.get(id);
            return { code: 'UNEXPECTED_ACCESS' };
          } catch (error) {
            return { code: error && typeof error.code === 'string' ? error.code : 'UNKNOWN' };
          }
        },
      },
    });
  `);
  return kitDirectory;
}
