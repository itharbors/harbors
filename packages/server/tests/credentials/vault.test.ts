import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialAccount, credentialScopeDigest } from '../../src/credentials/scope';
import { CredentialStore } from '../../src/credentials/store';
import type { KeyringAdapter, KeyringModule } from '../../src/credentials/keyring';
import {
  CredentialVault,
  createCredentialVault,
  createLocalCredentialVault,
} from '../../src/credentials/vault';

const kitId = '@itharbors/kit-mysql';
const pluginName = '@itharbors/mysql-core';
const scope = credentialScopeDigest(kitId, pluginName);
const profileId = '00112233-4455-4677-8899-aabbccddeeff';
const oldVersion = 'ffeeddcc-bbaa-4988-8776-554433221100';
const newVersion = '11223344-5566-4788-99aa-bbccddeeff00';
const thirdVersion = '22334455-6677-4899-aabb-ccddeeff0011';

class FakeKeyring implements KeyringAdapter {
  readonly secrets = new Map<string, string>();
  readonly operations: string[] = [];
  failSetAfterWrite = false;
  failDeleteAccounts = new Set<string>();
  onDelete?: (account: string) => void;

  async get(account: string): Promise<string | null> {
    this.operations.push(`get:${account}`);
    return this.secrets.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    this.operations.push(`set:${account}`);
    this.secrets.set(account, secret);
    if (this.failSetAfterWrite) {
      this.failSetAfterWrite = false;
      throw new Error('native set failure with private details');
    }
  }

  async delete(account: string): Promise<void> {
    this.operations.push(`delete:${account}`);
    this.onDelete?.(account);
    if (this.failDeleteAccounts.delete(account)) {
      throw new Error('native delete failure with private details');
    }
    this.secrets.delete(account);
  }
}

describe('CredentialVault', () => {
  let directory: string;
  let databasePath: string;
  let store: CredentialStore;
  let keyring: FakeKeyring;
  let vault: CredentialVault;
  let uuids: string[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-credentials-vault-'));
    databasePath = path.join(directory, 'credentials.sqlite');
    store = new CredentialStore(databasePath);
    keyring = new FakeKeyring();
    uuids = [profileId, oldVersion, newVersion, thirdVersion];
    vault = new CredentialVault({
      mode: 'local',
      store,
      keyring,
      randomUuid: () => {
        const value = uuids.shift();
        if (!value) throw new Error('test UUID sequence exhausted');
        return value;
      },
    });
  });

  afterEach(() => {
    vault.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates, reads, updates, and deletes a profile without persisting its secret', async () => {
    const bound = vault.bind(kitId, pluginName);

    expect(vault.capability()).toEqual({ mode: 'local', status: 'available' });
    await expect(bound.available()).resolves.toBe(true);
    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal', port: 3306, user: 'admin', database: null, tls: true },
      secret: 'never-log-this',
    });

    await expect(bound.list()).resolves.toEqual([profile]);
    await expect(bound.get(profile.id)).resolves.toEqual({ profile, secret: 'never-log-this' });
    const inspector = new Database(databasePath, { readonly: true });
    const persisted = inspector.prepare('SELECT * FROM credential_profiles').all();
    inspector.close();
    expect(JSON.stringify(persisted)).not.toContain('never-log-this');

    const updated = await bound.put({
      id: profile.id,
      label: '生产库（新密码）',
      metadata: { host: 'db.internal', port: 3306, user: 'admin', database: null, tls: true },
      secret: 'replacement-value',
    });
    await expect(bound.get(profile.id)).resolves.toEqual({
      profile: updated,
      secret: 'replacement-value',
    });
    expect(keyring.secrets.has(credentialAccount(scope, profile.id, oldVersion))).toBe(false);

    keyring.onDelete = () => {
      expect(store.listActive(scope)).toEqual([]);
    };
    await bound.delete(profile.id);
    await expect(bound.list()).resolves.toEqual([]);
    await expect(bound.get(profile.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_PROFILE_NOT_FOUND',
      message: '凭据配置不存在',
    });
  });

  it('isolates identical opaque IDs across host-derived scopes', async () => {
    const mysql = vault.bind(kitId, pluginName);
    const other = vault.bind('@itharbors/kit-other', '@itharbors/other-core');
    const profile = await mysql.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'isolated-value',
    });

    await expect(other.list()).resolves.toEqual([]);
    await expect(other.get(profile.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_PROFILE_NOT_FOUND',
      message: '凭据配置不存在',
    });
  });

  it('compensates a keyring write that fails after creating the new secret', async () => {
    keyring.failSetAfterWrite = true;
    const bound = vault.bind(kitId, pluginName);

    const error = await bound
      .put({ label: '生产库', metadata: { host: 'db.internal' }, secret: 'transient-value' })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'CREDENTIAL_OPERATION_FAILED', message: '凭据操作失败' });
    expect(String(error)).not.toContain('private details');
    expect(keyring.secrets.size).toBe(0);
    expect(store.listPending()).toEqual([]);
  });

  it('keeps an ambiguously committed pending insert recoverable behind a stable error', async () => {
    const createPending = store.createPending.bind(store);
    vi.spyOn(store, 'createPending').mockImplementationOnce((input) => {
      createPending(input);
      throw new Error('SQLite insert response failed after commit');
    });
    const bound = vault.bind(kitId, pluginName);

    await expect(
      bound.put({ label: '生产库', metadata: { host: 'db.internal' }, secret: 'unused-value' })
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });
    expect(store.listPending()).toHaveLength(1);

    await vault.recover();
    await vault.recover();
    expect(store.listPending()).toEqual([]);
    expect(keyring.secrets.size).toBe(0);
  });

  it('removes a new secret when SQLite activation fails before the state change', async () => {
    vi.spyOn(store, 'activatePending').mockImplementationOnce(() => {
      throw new Error('SQLite activation at /private/path failed');
    });
    const bound = vault.bind(kitId, pluginName);

    await expect(
      bound.put({ label: '生产库', metadata: { host: 'db.internal' }, secret: 'transient-value' })
    ).rejects.toMatchObject({ code: 'CREDENTIAL_OPERATION_FAILED', message: '凭据操作失败' });
    expect(keyring.secrets.size).toBe(0);
    expect(store.listPending()).toEqual([]);
  });

  it('recognizes activation that committed before its SQLite boundary threw', async () => {
    const activate = store.activatePending.bind(store);
    vi.spyOn(store, 'activatePending').mockImplementationOnce((...args) => {
      activate(...args);
      throw new Error('SQLite response failed after commit');
    });
    const bound = vault.bind(kitId, pluginName);

    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'committed-value',
    });

    await expect(bound.get(profile.id)).resolves.toEqual({ profile, secret: 'committed-value' });
  });

  it('keeps the old active secret when the version pointer swap conflicts', async () => {
    const bound = vault.bind(kitId, pluginName);
    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'old-value',
    });
    vi.spyOn(store, 'updateActive').mockReturnValueOnce(false);

    await expect(
      bound.put({
        id: profile.id,
        label: '冲突更新',
        metadata: { host: 'new.internal' },
        secret: 'new-value',
      })
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_PROFILE_CONFLICT',
      message: '凭据配置已发生变化',
    });
    await expect(bound.get(profile.id)).resolves.toMatchObject({ secret: 'old-value' });
    expect(keyring.secrets.has(credentialAccount(scope, profile.id, newVersion))).toBe(false);
  });

  it('rejects an invalid update before writing a new keyring secret', async () => {
    const bound = vault.bind(kitId, pluginName);
    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'old-value',
    });
    keyring.operations.length = 0;

    await expect(
      bound.put({
        id: profile.id,
        label: '库'.repeat(81),
        metadata: { host: 'new.internal' },
        secret: 'rejected-value',
      })
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });

    expect(keyring.operations.some((operation) => operation.startsWith('set:'))).toBe(false);
    await expect(bound.get(profile.id)).resolves.toMatchObject({ secret: 'old-value' });
  });

  it('atomically queues an old account when post-swap keyring cleanup fails', async () => {
    const bound = vault.bind(kitId, pluginName);
    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'old-value',
    });
    const oldAccount = credentialAccount(scope, profile.id, oldVersion);
    keyring.failDeleteAccounts.add(oldAccount);

    const updated = await bound.put({
      id: profile.id,
      label: '生产库更新',
      metadata: { host: 'new.internal' },
      secret: 'new-value',
    });

    expect(updated.label).toBe('生产库更新');
    expect(store.listCleanupAccounts()).toEqual([oldAccount]);
    await expect(bound.get(profile.id)).resolves.toMatchObject({ secret: 'new-value' });

    await vault.recover();
    await vault.recover();
    expect(store.listCleanupAccounts()).toEqual([]);
    expect(keyring.secrets.has(oldAccount)).toBe(false);
  });

  it('leaves failed deletion hidden and lets recovery finish it idempotently', async () => {
    const bound = vault.bind(kitId, pluginName);
    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'delete-value',
    });
    const account = credentialAccount(scope, profile.id, oldVersion);
    keyring.failDeleteAccounts.add(account);

    await expect(bound.delete(profile.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });
    await expect(bound.list()).resolves.toEqual([]);
    expect(store.listDeleting()).toHaveLength(1);

    await vault.recover();
    await vault.recover();
    expect(store.listDeleting()).toEqual([]);
    expect(keyring.secrets.has(account)).toBe(false);
  });

  it('recovers when metadata removal fails after keyring deletion', async () => {
    const bound = vault.bind(kitId, pluginName);
    const profile = await bound.put({
      label: '生产库',
      metadata: { host: 'db.internal' },
      secret: 'delete-value',
    });
    vi.spyOn(store, 'removeDeleting').mockImplementationOnce(() => {
      throw new Error('SQLite remove failure');
    });

    await expect(bound.delete(profile.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });
    expect(store.listDeleting()).toHaveLength(1);

    await vault.recover();
    expect(store.listDeleting()).toEqual([]);
  });

  it('cleans pending records and orphan cleanup entries without touching active secrets', async () => {
    const pendingId = profileId;
    const activeId = '12345678-1234-4234-8234-1234567890ab';
    store.createPending({
      scope,
      id: pendingId,
      label: 'pending',
      metadata: { host: 'pending.internal' },
      secretVersion: oldVersion,
    });
    const pendingAccount = credentialAccount(scope, pendingId, oldVersion);
    keyring.secrets.set(pendingAccount, 'pending-value');
    store.createPending({
      scope,
      id: activeId,
      label: 'active',
      metadata: { host: 'active.internal' },
      secretVersion: newVersion,
    });
    store.activatePending(scope, activeId, newVersion);
    const activeAccount = credentialAccount(scope, activeId, newVersion);
    keyring.secrets.set(activeAccount, 'active-value');
    store.queueCleanup(activeAccount);

    await vault.recover();
    await vault.recover();

    expect(store.listPending()).toEqual([]);
    expect(store.listCleanupAccounts()).toEqual([]);
    expect(keyring.secrets.has(pendingAccount)).toBe(false);
    expect(keyring.secrets.get(activeAccount)).toBe('active-value');
  });

  it('serializes concurrent mutations of one scope and profile', async () => {
    const bound = vault.bind(kitId, pluginName);
    const profile = await bound.put({
      label: '初始',
      metadata: { host: 'db.internal' },
      secret: 'first-value',
    });
    const originalSet = keyring.set.bind(keyring);
    let releaseFirstUpdate!: () => void;
    const firstUpdateGate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let signalFirstUpdateStarted!: () => void;
    const firstUpdateStarted = new Promise<void>((resolve) => {
      signalFirstUpdateStarted = resolve;
    });
    const set = vi.spyOn(keyring, 'set').mockImplementation(async (account, secret) => {
      if (account.endsWith(newVersion)) {
        signalFirstUpdateStarted();
        await firstUpdateGate;
      }
      await originalSet(account, secret);
    });

    const first = bound.put({
      id: profile.id,
      label: '第一次更新',
      metadata: { host: 'first.internal' },
      secret: 'second-value',
    });
    await firstUpdateStarted;
    const second = bound.put({
      id: profile.id,
      label: '第二次更新',
      metadata: { host: 'second.internal' },
      secret: 'third-value',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(set).toHaveBeenCalledTimes(1);
    releaseFirstUpdate();
    await Promise.all([first, second]);
    await expect(bound.get(profile.id)).resolves.toMatchObject({
      profile: { label: '第二次更新' },
      secret: 'third-value',
    });
  });

  it('maps SQLite boundary text to a fixed operation error', async () => {
    vi.spyOn(store, 'listActive').mockImplementationOnce(() => {
      throw new Error('SQLite failed at /Users/private/database.sqlite with secret details');
    });
    const error = await vault.bind(kitId, pluginName).list().catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'CREDENTIAL_OPERATION_FAILED', message: '凭据操作失败' });
    expect(String(error)).not.toContain('/Users/private');
    expect(JSON.stringify(error)).not.toContain('secret details');
  });

  it('returns an unavailable vault on native import failure and never loads native code in off mode', async () => {
    vault.close();
    fs.rmSync(directory, { recursive: true, force: true });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-credentials-factory-'));
    databasePath = path.join(directory, 'credentials.sqlite');
    const missingLoad = vi.fn<() => Promise<KeyringModule>>(async () => {
      throw new Error('missing native module details');
    });

    vault = await createCredentialVault({ mode: 'local', databasePath, loadKeyring: missingLoad });
    expect(vault.capability()).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_UNAVAILABLE',
    });
    await expect(vault.bind(kitId, pluginName).available()).resolves.toBe(false);
    await expect(vault.bind(kitId, pluginName).list()).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      message: '系统凭据库不可用',
    });

    vault.close();
    fs.rmSync(directory, { recursive: true, force: true });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-credentials-off-'));
    databasePath = path.join(directory, 'credentials.sqlite');
    const offLoad = vi.fn<() => Promise<KeyringModule>>();
    vault = await createCredentialVault({ mode: 'off', databasePath, loadKeyring: offLoad });

    expect(vault.capability()).toEqual({
      mode: 'off',
      status: 'unavailable',
      reason: 'CREDENTIALS_DISABLED',
    });
    expect(offLoad).not.toHaveBeenCalled();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it('returns a stable unavailable vault when SQLite cannot be opened', async () => {
    vault.close();
    const invalidDatabasePath = directory;

    const result = await createCredentialVault({
      mode: 'local',
      databasePath: invalidDatabasePath,
      keyring,
    }).catch((reason: unknown) => reason);

    expect(result).toBeInstanceOf(CredentialVault);
    expect((result as CredentialVault).capability()).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_UNAVAILABLE',
    });
    vault = result as CredentialVault;
  });

  it('accepts the Task 3 dbPath factory contract for a local vault', async () => {
    vault.close();

    vault = await createLocalCredentialVault({ dbPath: databasePath, keyring });

    expect(vault.capability()).toEqual({ mode: 'local', status: 'available' });
  });
});
