import {
  CORE_TOPICS,
  type ConnectionSnapshot,
  type DataChangedEvent,
  type MysqlConnectionProfile,
  type MysqlCredentialCapability,
  type MysqlErrorEnvelope,
  type MysqlPublicError,
  type RevisionSnapshot,
} from '@itharbors/mysql-contracts';
import {
  MysqlService,
  MysqlWorkbenchError,
  type PreparedConnection,
} from './mysql-service.js';
import {
  parseConnectionInput,
  parseConnectionMetadata,
  parseConnectionProfileUpdateInput,
  parseProfileId,
  parseProfileIdInput,
  parseProfileLabelInput,
  type ConnectionInput,
} from './protocol.js';

declare const editor: any;

type CredentialProfile = {
  id: string;
  label: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
};

type PluginCredentialVault = {
  available(): Promise<boolean>;
  list(): Promise<CredentialProfile[]>;
  get(id: string): Promise<{ profile: CredentialProfile; secret: string }>;
  put(input: {
    id?: string;
    label: string;
    metadata: CredentialProfile['metadata'];
    secret: string;
  }): Promise<CredentialProfile>;
  delete(id: string): Promise<void>;
};

type Runtime = {
  message: {
    broadcast(topic: string, payload: unknown): void;
  };
  credentials?: PluginCredentialVault;
};

type ConnectionState = Omit<ConnectionSnapshot, keyof RevisionSnapshot | 'profileId'>;

const service = new MysqlService();
let runtime: Runtime | undefined;
let connectionRevision = 0;
let schemaRevision = 0;
let dataRevision = 0;
let disposed = false;
let activeProfileId: string | null = null;
let connectionProvenance: 'none' | 'manual' | 'saved' = 'none';

class AsyncMutationLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const connectionMutationLock = new AsyncMutationLock();

function mutateConnection<T>(operation: () => T | Promise<T>): Promise<T | MysqlErrorEnvelope> {
  return connectionMutationLock.runExclusive(() => {
    if (disposed) {
      return errorEnvelope(new MysqlWorkbenchError('SERVICE_DISPOSED', 'MySQL plugin is unloaded'));
    }
    return operation();
  });
}

function revisions(): RevisionSnapshot {
  return { connectionRevision, schemaRevision, dataRevision };
}

function withRevisions<T extends object>(value: T): T & RevisionSnapshot {
  return { ...value, ...revisions() };
}

function toPublicError(error: unknown): MysqlPublicError {
  if (error instanceof MysqlWorkbenchError) {
    return { code: error.code, message: error.message };
  }
  const code = errorCode(error);
  if (code !== null && Object.prototype.hasOwnProperty.call(CREDENTIAL_ERROR_MESSAGES, code)) {
    const message = CREDENTIAL_ERROR_MESSAGES[code];
    if (typeof message !== 'string') {
      return { code: 'MYSQL_ERROR', message: 'MySQL operation failed' };
    }
    return {
      code,
      message,
    };
  }
  return { code: 'MYSQL_ERROR', message: 'MySQL operation failed' };
}

const CREDENTIAL_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze(Object.assign(
  Object.create(null) as Record<string, string>,
  {
    CREDENTIALS_DISABLED: '当前宿主未启用本机凭据。',
    CREDENTIALS_UNAVAILABLE: '本机凭据库当前不可用。',
    CREDENTIALS_LOCKED: '请先解锁本机凭据库。',
    CREDENTIAL_PROFILE_NOT_FOUND: '保存的连接不存在或密码已丢失。',
    CREDENTIAL_PROFILE_CONFLICT: '保存的连接已被其他操作修改。',
    CREDENTIAL_OPERATION_FAILED: '无法完成本机凭据操作。',
  },
));

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function errorEnvelope(error: unknown): MysqlErrorEnvelope {
  return { $mysqlError: toPublicError(error) };
}

async function callService(method: string, input?: unknown): Promise<unknown> {
  const candidate = (service as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') {
    return errorEnvelope(new Error(`[NOT_IMPLEMENTED] ${method} is not implemented`));
  }
  try {
    return await candidate.call(service, input);
  } catch (error) {
    return errorEnvelope(error);
  }
}

function isErrorEnvelope(value: unknown): value is MysqlErrorEnvelope {
  return typeof value === 'object' && value !== null && '$mysqlError' in value;
}

function connectionSnapshot(): ConnectionSnapshot {
  return { ...withRevisions(service.getConnectionState() as ConnectionState), profileId: activeProfileId };
}

async function connect(input: unknown): Promise<unknown> {
  const result = await callService('connect', input);
  if (isErrorEnvelope(result)) return result;
  return publishSuccessfulConnection(result as ConnectionState, null);
}

function publishSuccessfulConnection(
  result: ConnectionState,
  profileId: string | null,
): ConnectionSnapshot {
  activeProfileId = profileId;
  connectionProvenance = profileId === null ? 'manual' : 'saved';
  connectionRevision += 1;
  schemaRevision += 1;
  dataRevision += 1;
  const snapshot = { ...withRevisions(result), profileId };
  runtime?.message.broadcast(CORE_TOPICS.connectionChanged, snapshot);
  return snapshot;
}

async function disconnect(): Promise<unknown> {
  const before = service.getConnectionState();
  const result = await callService('disconnect');
  const after = service.getConnectionState() as ConnectionState;
  let snapshot: ConnectionSnapshot | null = null;
  if (!after.connected) {
    activeProfileId = null;
    connectionProvenance = 'none';
  }
  if (before.connected && !after.connected) {
    connectionRevision += 1;
    schemaRevision += 1;
    dataRevision += 1;
    snapshot = { ...withRevisions(after), profileId: null };
    runtime?.message.broadcast(CORE_TOPICS.connectionChanged, snapshot);
  }
  if (isErrorEnvelope(result)) return result;
  return snapshot ?? { ...withRevisions(after), profileId: activeProfileId };
}

async function getCredentialCapability(): Promise<unknown> {
  const vault = runtime?.credentials;
  if (!vault) {
    return { available: false, reason: 'CREDENTIALS_DISABLED' } satisfies MysqlCredentialCapability;
  }
  try {
    return await vault.available()
      ? { available: true } satisfies MysqlCredentialCapability
      : { available: false, reason: 'CREDENTIALS_UNAVAILABLE' } satisfies MysqlCredentialCapability;
  } catch (error) {
    return {
      available: false,
      reason: errorCode(error) === 'CREDENTIALS_LOCKED'
        ? 'CREDENTIALS_LOCKED'
        : 'CREDENTIALS_UNAVAILABLE',
    } satisfies MysqlCredentialCapability;
  }
}

async function listConnectionProfiles(): Promise<unknown> {
  try {
    return (await requireVault().list()).map(toMysqlConnectionProfile);
  } catch (error) {
    return errorEnvelope(error);
  }
}

async function connectSaved(input: unknown): Promise<unknown> {
  try {
    const { profileId } = parseProfileIdInput(input);
    const saved = await requireVault().get(profileId);
    const profile = requireMatchingProfile(saved.profile, profileId);
    const result = await callService(
      'connect',
      connectionInputFromProfile(profile, saved.secret),
    );
    if (isErrorEnvelope(result)) return result;
    return publishSuccessfulConnection(result as ConnectionState, profileId);
  } catch (error) {
    return errorEnvelope(error);
  }
}

async function saveCurrentConnection(input: unknown): Promise<unknown> {
  try {
    const { label } = parseProfileLabelInput(input);
    const activeInput = service.getActiveConnectionInput();
    if (!activeInput || connectionProvenance !== 'manual') {
      throw new MysqlWorkbenchError(
        'NOT_CONNECTED',
        '请先成功建立手工连接，再保存连接。',
      );
    }
    const profile = toMysqlConnectionProfile(await requireVault().put({
      label,
      metadata: metadataFromConnectionInput(activeInput),
      secret: activeInput.password,
    }));
    activeProfileId = profile.id;
    connectionProvenance = 'saved';
    connectionRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.connectionChanged, connectionSnapshot());
    return profile;
  } catch (error) {
    return errorEnvelope(error);
  }
}

async function updateConnectionProfile(input: unknown): Promise<unknown> {
  let prepared: PreparedConnection | null = null;
  try {
    const { profileId, password } = parseConnectionProfileUpdateInput(input);
    const vault = requireVault();
    const saved = await vault.get(profileId);
    const profile = requireMatchingProfile(saved.profile, profileId);
    const previousMetadata = { ...parseConnectionMetadata(profile.metadata) };
    const connectionInput = connectionInputFromProfile(profile, password);
    prepared = await service.prepareConnection(connectionInput);
    const previousCredential = {
      id: profileId,
      label: profile.label,
      metadata: previousMetadata,
      secret: saved.secret,
    };
    saved.secret = '';
    const updated = toMysqlConnectionProfile(await vault.put({
      id: profileId,
      label: profile.label,
      metadata: metadataFromConnectionInput(connectionInput),
      secret: password,
    }));
    let result: ConnectionState;
    try {
      result = service.commitPreparedConnection(prepared);
    } catch (commitError) {
      try {
        await vault.put(previousCredential);
      } catch {
        throw Object.assign(new Error('Credential compensation failed'), {
          code: 'CREDENTIAL_OPERATION_FAILED',
        });
      }
      throw commitError;
    }
    prepared = null;
    publishSuccessfulConnection(result, profileId);
    return updated;
  } catch (error) {
    return errorEnvelope(error);
  } finally {
    if (prepared) await service.discardPreparedConnection(prepared);
  }
}

async function deleteConnectionProfile(input: unknown): Promise<unknown> {
  try {
    const { profileId } = parseProfileIdInput(input);
    const vault = requireVault();
    if (activeProfileId === profileId) {
      const disconnected = await disconnect();
      if (isErrorEnvelope(disconnected)) return disconnected;
    }
    await vault.delete(profileId);
    return { deleted: true, profileId };
  } catch (error) {
    return errorEnvelope(error);
  }
}

function connectionInputFromProfile(profile: CredentialProfile, secret: string): ConnectionInput {
  return parseConnectionInput({ ...parseConnectionMetadata(profile.metadata), password: secret });
}

function requireVault(): PluginCredentialVault {
  const vault = runtime?.credentials;
  if (!vault) {
    throw Object.assign(new Error('Credentials disabled'), { code: 'CREDENTIALS_DISABLED' });
  }
  return vault;
}

function requireMatchingProfile(profile: CredentialProfile, expectedId: string): CredentialProfile {
  if (parseProfileId(profile.id) !== expectedId) {
    throw Object.assign(new Error('Credential profile mismatch'), {
      code: 'CREDENTIAL_PROFILE_NOT_FOUND',
    });
  }
  return profile;
}

function toMysqlConnectionProfile(profile: CredentialProfile): MysqlConnectionProfile {
  const metadata = parseConnectionMetadata(profile.metadata);
  return {
    id: parseProfileId(profile.id),
    label: parseProfileLabelInput({ label: profile.label }).label,
    ...metadata,
    createdAt: parseTimestamp(profile.createdAt, 'createdAt'),
    updatedAt: parseTimestamp(profile.updatedAt, 'updatedAt'),
  };
}

function metadataFromConnectionInput(input: ConnectionInput): CredentialProfile['metadata'] {
  return {
    host: input.host,
    port: input.port,
    user: input.user,
    database: input.database,
    tls: input.tls,
  };
}

function parseTimestamp(value: unknown, name: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 64
    || Number.isNaN(Date.parse(value))
  ) {
    throw Object.assign(new Error(`${name} is invalid`), { code: 'CREDENTIAL_OPERATION_FAILED' });
  }
  return value;
}

async function schemaSnapshot(): Promise<unknown> {
  const result = await callService('getSchema');
  return isErrorEnvelope(result) ? result : withRevisions(result as object);
}

async function databasesSnapshot(): Promise<unknown> {
  const result = await callService('getDatabases');
  return isErrorEnvelope(result) ? result : withRevisions(result as object);
}

async function selectDatabase(input: unknown): Promise<unknown> {
  const before = service.getConnectionState();
  const result = await callService('selectDatabase', input);
  if (isErrorEnvelope(result)) return result;
  const next = result as ConnectionState;
  if (before.database === next.database && before.endpoint === next.endpoint) {
    return { ...withRevisions(next), profileId: activeProfileId };
  }
  connectionRevision += 1;
  schemaRevision += 1;
  dataRevision += 1;
  const snapshot = { ...withRevisions(next), profileId: activeProfileId };
  runtime?.message.broadcast(CORE_TOPICS.connectionChanged, snapshot);
  return snapshot;
}

async function mutateData(method: string, input: unknown): Promise<unknown> {
  const result = await callService(method, input);
  if (isErrorEnvelope(result)) return result;
  dataRevision += 1;
  const event: DataChangedEvent = {
    ...revisions(),
    objectName: objectNameOf(input),
  };
  runtime?.message.broadcast(CORE_TOPICS.dataChanged, event);
  return result;
}

async function executeSql(input: unknown): Promise<unknown> {
  const result = await callService('executeSql', input);
  if (isErrorEnvelope(result) || !isMutationResult(result)) return result;

  const keyword = firstSqlKeyword(sqlOf(input));
  if (keyword !== null && SCHEMA_KEYWORDS.has(keyword)) {
    schemaRevision += 1;
    dataRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.schemaChanged, revisions());
  } else if (keyword !== null && DATA_KEYWORDS.has(keyword)) {
    dataRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.dataChanged, {
      ...revisions(),
      objectName: null,
    } satisfies DataChangedEvent);
  } else {
    schemaRevision += 1;
    dataRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.schemaChanged, revisions());
  }
  return result;
}

const SCHEMA_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE']);
const DATA_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

function firstSqlKeyword(sql: string): string | null {
  let remaining = sql.trimStart();
  while (remaining !== '') {
    if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      if (end < 0) return null;
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    if (remaining.startsWith('--') || remaining.startsWith('#')) {
      const end = remaining.indexOf('\n');
      if (end < 0) return null;
      remaining = remaining.slice(end + 1).trimStart();
      continue;
    }
    return remaining.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? null;
  }
  return null;
}

function isMutationResult(value: unknown): value is { kind: 'mutation' } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'mutation';
}

function objectNameOf(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && typeof (input as { name?: unknown }).name === 'string') {
    return (input as { name: string }).name;
  }
  return null;
}

function sqlOf(input: unknown): string {
  if (typeof input === 'object' && input !== null && typeof (input as { sql?: unknown }).sql === 'string') {
    return (input as { sql: string }).sql;
  }
  return '';
}

editor.plugin.define({
  lifecycle: {
    load(ctx: Runtime) {
      runtime = ctx;
    },
    async unload() {
      await connectionMutationLock.runExclusive(async () => {
        if (disposed) return;
        disposed = true;
        try {
          await service.dispose();
        } finally {
          runtime = undefined;
        }
      });
    },
  },
  methods: {
    getConnectionState: () => connectionSnapshot(),
    connect: (input: unknown) => mutateConnection(() => connect(input)),
    getCredentialCapability,
    listConnectionProfiles,
    connectSaved: (input: unknown) => mutateConnection(() => connectSaved(input)),
    saveCurrentConnection: (input: unknown) => mutateConnection(() => saveCurrentConnection(input)),
    updateConnectionProfile: (input: unknown) => mutateConnection(() => updateConnectionProfile(input)),
    deleteConnectionProfile: (input: unknown) => mutateConnection(() => deleteConnectionProfile(input)),
    disconnect: () => mutateConnection(() => disconnect()),
    getDatabases: () => databasesSnapshot(),
    selectDatabase: (input: unknown) => mutateConnection(() => selectDatabase(input)),
    getSchema: () => schemaSnapshot(),
    getObjectSchema: (input: unknown) => callService('getObjectSchema', input),
    getRelationshipGraph: () => callService('getRelationshipGraph'),
    getRows: (input: unknown) => callService('getRows', input),
    insertRow: (input: unknown) => mutateData('insertRow', input),
    updateRow: (input: unknown) => mutateData('updateRow', input),
    deleteRow: (input: unknown) => mutateData('deleteRow', input),
    executeSql,
  },
});
