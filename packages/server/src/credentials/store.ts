import Database from 'better-sqlite3';
import type { CredentialProfile } from '@itharbors/plugin-types';
import { credentialError } from './errors';
import { credentialAccount } from './scope';

type CredentialState = 'pending' | 'active' | 'deleting';

interface StoredCredentialRow {
  scope: string;
  id: string;
  label: string;
  metadata_json: string;
  secret_reference: string;
  state: CredentialState;
  created_at: string;
  updated_at: string;
}

export interface CredentialRecord {
  scope: string;
  id: string;
  label: string;
  metadata: CredentialProfile['metadata'];
  secretReference: string;
  secretVersion: string;
  state: CredentialState;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePendingInput {
  scope: string;
  id: string;
  label: string;
  metadata: unknown;
  secretVersion: string;
}

export interface UpdateActiveInput extends CreatePendingInput {
  expectedSecretVersion: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCOPE_PATTERN = /^[a-f0-9]{64}$/u;

function operationFailed(): never {
  throw credentialError('CREDENTIAL_OPERATION_FAILED');
}

function validateUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) operationFailed();
}

function validateScope(value: string): void {
  if (!SCOPE_PATTERN.test(value)) operationFailed();
}

function validateLabel(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > 80) operationFailed();
}

function isReservedMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
  return (
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('scope') ||
    normalized === 'account'
  );
}

function serializeMetadata(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) operationFailed();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) operationFailed();

  for (const [key, item] of Object.entries(value)) {
    if (isReservedMetadataKey(key)) operationFailed();
    if (
      item !== null &&
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      (typeof item !== 'number' || !Number.isFinite(item))
    ) {
      operationFailed();
    }
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 4096) operationFailed();
  return serialized;
}

function toRecord(row: StoredCredentialRow): CredentialRecord {
  return {
    scope: row.scope,
    id: row.id,
    label: row.label,
    metadata: JSON.parse(row.metadata_json) as CredentialProfile['metadata'],
    secretReference: row.secret_reference,
    secretVersion: row.secret_reference.slice(row.secret_reference.lastIndexOf(':') + 1),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProfile(row: StoredCredentialRow): CredentialProfile {
  return {
    id: row.id,
    label: row.label,
    metadata: JSON.parse(row.metadata_json) as CredentialProfile['metadata'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CredentialStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS credential_profiles (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        secret_reference TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'deleting')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      );

      CREATE INDEX IF NOT EXISTS credential_profiles_scope_state
        ON credential_profiles (scope, state, created_at, id);

      CREATE TABLE IF NOT EXISTS credential_secret_cleanup (
        account TEXT PRIMARY KEY
      ) WITHOUT ROWID;
    `);
  }

  validateInput(input: CreatePendingInput): string {
    validateScope(input.scope);
    validateUuid(input.id);
    validateUuid(input.secretVersion);
    validateLabel(input.label);
    return serializeMetadata(input.metadata);
  }

  createPending(input: CreatePendingInput): CredentialRecord {
    const metadataJson = this.validateInput(input);
    const timestamp = new Date().toISOString();
    const secretReference = credentialAccount(input.scope, input.id, input.secretVersion);
    this.database
      .prepare(
        `INSERT INTO credential_profiles (
          scope, id, label, metadata_json, secret_reference, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        input.scope,
        input.id,
        input.label,
        metadataJson,
        secretReference,
        timestamp,
        timestamp
      );
    return {
      scope: input.scope,
      id: input.id,
      label: input.label,
      metadata: JSON.parse(metadataJson) as CredentialProfile['metadata'],
      secretReference,
      secretVersion: input.secretVersion,
      state: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  activatePending(scope: string, id: string, secretVersion: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE credential_profiles
         SET state = 'active', updated_at = ?
         WHERE scope = ? AND id = ? AND state = 'pending' AND secret_reference = ?`
      )
      .run(new Date().toISOString(), scope, id, credentialAccount(scope, id, secretVersion));
    return result.changes === 1;
  }

  removePending(scope: string, id: string, secretVersion: string): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM credential_profiles
         WHERE scope = ? AND id = ? AND state = 'pending' AND secret_reference = ?`
      )
      .run(scope, id, credentialAccount(scope, id, secretVersion));
    return result.changes === 1;
  }

  listActive(scope: string): CredentialProfile[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM credential_profiles
         WHERE scope = ? AND state = 'active'
         ORDER BY created_at, id`
      )
      .all(scope) as StoredCredentialRow[];
    return rows.map(toProfile);
  }

  getActive(scope: string, id: string): CredentialProfile | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM credential_profiles
         WHERE scope = ? AND id = ? AND state = 'active'`
      )
      .get(scope, id) as StoredCredentialRow | undefined;
    return row ? toProfile(row) : undefined;
  }

  getActiveRecord(scope: string, id: string): CredentialRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM credential_profiles
         WHERE scope = ? AND id = ? AND state = 'active'`
      )
      .get(scope, id) as StoredCredentialRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  getRecord(scope: string, id: string): CredentialRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM credential_profiles WHERE scope = ? AND id = ?')
      .get(scope, id) as StoredCredentialRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  updateActive(input: UpdateActiveInput): boolean {
    const metadataJson = this.validateInput(input);
    validateUuid(input.expectedSecretVersion);
    if (input.secretVersion === input.expectedSecretVersion) operationFailed();
    const update = this.database.prepare(
      `UPDATE credential_profiles
       SET label = ?, metadata_json = ?, secret_reference = ?, updated_at = ?
       WHERE scope = ? AND id = ? AND state = 'active' AND secret_reference = ?`
    );
    const queueOldReference = this.database.prepare(
      'INSERT INTO credential_secret_cleanup (account) VALUES (?) ON CONFLICT(account) DO NOTHING'
    );
    const hasStagedReference = this.database.prepare(
      'SELECT 1 FROM credential_secret_cleanup WHERE account = ?'
    );
    const removeStagedReference = this.database.prepare(
      'DELETE FROM credential_secret_cleanup WHERE account = ?'
    );
    const expectedReference = credentialAccount(
      input.scope,
      input.id,
      input.expectedSecretVersion
    );
    const newReference = credentialAccount(input.scope, input.id, input.secretVersion);
    const updateReference = this.database.transaction(() => {
      if (!hasStagedReference.get(newReference)) return false;
      const result = update.run(
        input.label,
        metadataJson,
        newReference,
        new Date().toISOString(),
        input.scope,
        input.id,
        expectedReference
      );
      if (result.changes === 1) {
        removeStagedReference.run(newReference);
        queueOldReference.run(expectedReference);
      }
      return result.changes === 1;
    });
    return updateReference();
  }

  markDeleting(scope: string, id: string, secretVersion: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE credential_profiles
         SET state = 'deleting', updated_at = ?
         WHERE scope = ? AND id = ? AND state = 'active' AND secret_reference = ?`
      )
      .run(new Date().toISOString(), scope, id, credentialAccount(scope, id, secretVersion));
    return result.changes === 1;
  }

  removeDeleting(scope: string, id: string, secretVersion: string): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM credential_profiles
         WHERE scope = ? AND id = ? AND state = 'deleting' AND secret_reference = ?`
      )
      .run(scope, id, credentialAccount(scope, id, secretVersion));
    return result.changes === 1;
  }

  listPending(): CredentialRecord[] {
    return this.listRecordsByState('pending');
  }

  listDeleting(): CredentialRecord[] {
    return this.listRecordsByState('deleting');
  }

  queueCleanup(account: string): void {
    this.database
      .prepare('INSERT INTO credential_secret_cleanup (account) VALUES (?) ON CONFLICT(account) DO NOTHING')
      .run(account);
  }

  listCleanupAccounts(): string[] {
    const rows = this.database
      .prepare('SELECT account FROM credential_secret_cleanup ORDER BY account')
      .all() as Array<{ account: string }>;
    return rows.map(({ account }) => account);
  }

  removeCleanup(account: string): boolean {
    return (
      this.database.prepare('DELETE FROM credential_secret_cleanup WHERE account = ?').run(account)
        .changes === 1
    );
  }

  isSecretReferenceActive(account: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM credential_profiles
           WHERE secret_reference = ? AND state = 'active'
           LIMIT 1`
        )
        .get(account)
    );
  }

  close(): void {
    this.database.close();
  }

  private listRecordsByState(state: CredentialState): CredentialRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM credential_profiles WHERE state = ? ORDER BY scope, created_at, id')
      .all(state) as StoredCredentialRow[];
    return rows.map(toRecord);
  }
}
