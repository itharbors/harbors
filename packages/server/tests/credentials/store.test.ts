import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/credentials/store';
import { credentialAccount } from '../../src/credentials/scope';

const scope = 'a'.repeat(64);
const profileId = '00112233-4455-4677-8899-aabbccddeeff';
const oldVersion = 'ffeeddcc-bbaa-4988-8776-554433221100';
const newVersion = '11223344-5566-4788-99aa-bbccddeeff00';

describe('CredentialStore', () => {
  let directory: string;
  let databasePath: string;
  let store: CredentialStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-credentials-store-'));
    databasePath = path.join(directory, 'credentials.sqlite');
    store = new CredentialStore(databasePath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps pending profiles out of public reads until compare-and-swap activation', () => {
    store.createPending({
      scope,
      id: profileId,
      label: '生产库',
      metadata: { host: 'db.internal', port: 3306, tls: true, database: null },
      secretVersion: oldVersion,
    });

    expect(store.listActive(scope)).toEqual([]);
    expect(store.getActive(scope, profileId)).toBeUndefined();

    expect(store.activatePending(scope, profileId, oldVersion)).toBe(true);
    expect(store.activatePending(scope, profileId, oldVersion)).toBe(false);
    expect(store.listActive(scope)).toEqual([
      expect.objectContaining({
        id: profileId,
        label: '生产库',
        metadata: { host: 'db.internal', port: 3306, tls: true, database: null },
      }),
    ]);
    expect(store.listActive(scope)[0]).not.toHaveProperty('scope');
    expect(store.listActive(scope)[0]).not.toHaveProperty('state');
    expect(store.listActive(scope)[0]).not.toHaveProperty('secretReference');
  });

  it('atomically swaps an active reference and rejects a stale update', () => {
    store.createPending({
      scope,
      id: profileId,
      label: '旧标签',
      metadata: { host: 'old.internal' },
      secretVersion: oldVersion,
    });
    expect(store.activatePending(scope, profileId, oldVersion)).toBe(true);
    store.queueCleanup(credentialAccount(scope, profileId, newVersion));

    expect(
      store.updateActive({
        scope,
        id: profileId,
        expectedSecretVersion: oldVersion,
        secretVersion: newVersion,
        label: '新标签',
        metadata: { host: 'new.internal' },
      })
    ).toBe(true);
    expect(
      store.updateActive({
        scope,
        id: profileId,
        expectedSecretVersion: oldVersion,
        secretVersion: '22334455-6677-4899-aabb-ccddeeff0011',
        label: '过期写入',
        metadata: { host: 'stale.internal' },
      })
    ).toBe(false);

    expect(store.getActiveRecord(scope, profileId)).toMatchObject({
      label: '新标签',
      secretReference: credentialAccount(scope, profileId, newVersion),
      secretVersion: newVersion,
    });
    expect(store.listCleanupAccounts()).toEqual([
      credentialAccount(scope, profileId, oldVersion),
    ]);
  });

  it('rejects a pointer swap that reuses the active secret version', () => {
    store.createPending({
      scope,
      id: profileId,
      label: '旧标签',
      metadata: { host: 'old.internal' },
      secretVersion: oldVersion,
    });
    store.activatePending(scope, profileId, oldVersion);
    const account = credentialAccount(scope, profileId, oldVersion);
    store.queueCleanup(account);

    expect(() =>
      store.updateActive({
        scope,
        id: profileId,
        expectedSecretVersion: oldVersion,
        secretVersion: oldVersion,
        label: '不应覆盖',
        metadata: { host: 'new.internal' },
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'CREDENTIAL_OPERATION_FAILED',
        message: '凭据操作失败',
      })
    );
    expect(store.getActiveRecord(scope, profileId)).toMatchObject({
      label: '旧标签',
      secretVersion: oldVersion,
    });
    expect(store.listCleanupAccounts()).toEqual([account]);
  });

  it('hides a deleting profile before removing its metadata', () => {
    store.createPending({
      scope,
      id: profileId,
      label: '待删除',
      metadata: { host: 'db.internal' },
      secretVersion: oldVersion,
    });
    store.activatePending(scope, profileId, oldVersion);

    expect(store.markDeleting(scope, profileId, oldVersion)).toBe(true);
    expect(store.listActive(scope)).toEqual([]);
    expect(store.getActive(scope, profileId)).toBeUndefined();
    expect(store.removeDeleting(scope, profileId, oldVersion)).toBe(true);
    expect(store.listDeleting()).toEqual([]);
  });

  it('exposes pending and deleting records only to recovery', () => {
    store.createPending({
      scope,
      id: profileId,
      label: 'pending',
      metadata: { host: 'pending.internal' },
      secretVersion: oldVersion,
    });
    store.createPending({
      scope,
      id: '12345678-1234-4234-8234-1234567890ab',
      label: 'deleting',
      metadata: { host: 'deleting.internal' },
      secretVersion: newVersion,
    });
    store.activatePending(scope, '12345678-1234-4234-8234-1234567890ab', newVersion);
    store.markDeleting(scope, '12345678-1234-4234-8234-1234567890ab', newVersion);

    expect(store.listPending()).toHaveLength(1);
    expect(store.listDeleting()).toHaveLength(1);
  });

  it('keeps the cleanup queue idempotent and limited to opaque accounts', () => {
    const account = credentialAccount(scope, profileId, oldVersion);

    store.queueCleanup(account);
    store.queueCleanup(account);

    expect(store.listCleanupAccounts()).toEqual([account]);
    const inspector = new Database(databasePath, { readonly: true });
    const columns = inspector.prepare('PRAGMA table_info(credential_secret_cleanup)').all() as Array<{
      name: string;
    }>;
    inspector.close();
    expect(columns.map(({ name }) => name)).toEqual(['account']);

    expect(store.removeCleanup(account)).toBe(true);
    expect(store.removeCleanup(account)).toBe(false);
  });

  it.each([
    ['an invalid UUID', { id: 'profile-1' }],
    ['an invalid scope', { scope: 'mysql' }],
    ['a label over 80 characters', { label: '库'.repeat(81) }],
    ['nested metadata', { metadata: { connection: { host: 'db.internal' } } }],
    ['array metadata', { metadata: { hosts: ['db.internal'] } }],
    ['non-finite metadata numbers', { metadata: { port: Number.NaN } }],
    ['metadata over 4096 UTF-8 bytes', { metadata: { note: '库'.repeat(1400) } }],
    ['a reserved password key', { metadata: { password: 'reserved-value' } }],
    ['a reserved scope key', { metadata: { scope: 'reserved-value' } }],
  ])('rejects %s', (_name, override) => {
    const input = {
      scope,
      id: profileId,
      label: '生产库',
      metadata: { host: 'db.internal' } as Record<string, unknown>,
      secretVersion: oldVersion,
      ...override,
    };

    expect(() => store.createPending(input)).toThrowError(
      expect.objectContaining({
        code: 'CREDENTIAL_OPERATION_FAILED',
        message: '凭据操作失败',
      })
    );
  });
});
