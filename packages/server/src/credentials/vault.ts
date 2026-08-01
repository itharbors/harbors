import { randomUUID } from 'node:crypto';
import type {
  CredentialCapabilitySnapshot,
  CredentialMode,
  CredentialProfile,
  PluginCredentialVault,
} from '@itharbors/plugin-types';
import {
  credentialError,
  isCredentialError,
  type CredentialError,
  type CredentialErrorCode,
} from './errors';
import {
  createNativeKeyringAdapter,
  type KeyringAdapter,
  type KeyringModuleLoader,
} from './keyring';
import { credentialScopeDigest } from './scope';
import { CredentialStore, type CredentialRecord } from './store';

type UnavailableReason = 'CREDENTIALS_DISABLED' | 'CREDENTIALS_UNAVAILABLE' | 'CREDENTIALS_LOCKED';

export interface CredentialVaultOptions {
  mode: CredentialMode;
  store?: CredentialStore;
  keyring?: KeyringAdapter;
  unavailableReason?: UnavailableReason;
  randomUuid?: () => string;
}

export interface CreateCredentialVaultOptions {
  mode: CredentialMode;
  databasePath?: string;
  dbPath?: string;
  store?: CredentialStore;
  keyring?: KeyringAdapter;
  loadKeyring?: KeyringModuleLoader;
  randomUuid?: () => string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function asProfile(record: CredentialRecord): CredentialProfile {
  return {
    id: record.id,
    label: record.label,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function stableError(error: unknown, fallback: CredentialErrorCode): CredentialError {
  return isCredentialError(error) ? error : credentialError(fallback);
}

function assertProfileId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw credentialError('CREDENTIAL_OPERATION_FAILED');
}

export class CredentialVault {
  private readonly mode: CredentialMode;
  private readonly store?: CredentialStore;
  private readonly keyring?: KeyringAdapter;
  private readonly randomUuid: () => string;
  private unavailableReason?: UnavailableReason;
  private readonly locks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: CredentialVaultOptions) {
    this.mode = options.mode;
    this.store = options.store;
    this.keyring = options.keyring;
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.unavailableReason =
      options.unavailableReason ??
      (options.mode === 'off'
        ? 'CREDENTIALS_DISABLED'
        : options.mode !== 'local' || !options.store || !options.keyring
          ? 'CREDENTIALS_UNAVAILABLE'
          : undefined);
  }

  bind(kitId: string, pluginName: string): PluginCredentialVault {
    const scope = credentialScopeDigest(kitId, pluginName);
    return {
      available: async () => this.capability().status === 'available',
      list: async () => this.list(scope),
      get: async (id) => this.get(scope, id),
      put: async (input) => this.put(scope, input),
      delete: async (id) => this.delete(scope, id),
    };
  }

  capability(): CredentialCapabilitySnapshot {
    if (this.unavailableReason) {
      return { mode: this.mode, status: 'unavailable', reason: this.unavailableReason };
    }
    return { mode: this.mode, status: 'available' };
  }

  async recover(): Promise<void> {
    const backend = this.backendOrUndefined();
    if (!backend) return;

    let pending: CredentialRecord[] = [];
    let deleting: CredentialRecord[] = [];
    let cleanupAccounts: string[] = [];
    try {
      pending = backend.store.listPending();
      deleting = backend.store.listDeleting();
      cleanupAccounts = backend.store.listCleanupAccounts();
    } catch {
      return;
    }

    for (const record of pending) {
      await this.withLock(record.scope, record.id, async () => {
        try {
          const current = backend.store.getRecord(record.scope, record.id);
          if (current?.state !== 'pending' || current.secretReference !== record.secretReference) return;
          await backend.keyring.delete(record.secretReference);
          backend.store.removePending(record.scope, record.id, record.secretVersion);
        } catch (error) {
          this.observeBackendError(error);
        }
      });
    }

    for (const record of deleting) {
      await this.withLock(record.scope, record.id, async () => {
        try {
          const current = backend.store.getRecord(record.scope, record.id);
          if (current?.state !== 'deleting' || current.secretReference !== record.secretReference) return;
          await backend.keyring.delete(record.secretReference);
          backend.store.removeDeleting(record.scope, record.id, record.secretVersion);
        } catch (error) {
          this.observeBackendError(error);
        }
      });
    }

    for (const account of cleanupAccounts) {
      const [accountScope, id] = account.split(':');
      if (!accountScope || !id) continue;
      await this.withLock(accountScope, id, async () => {
        try {
          if (backend.store.isSecretReferenceActive(account)) {
            backend.store.removeCleanup(account);
            return;
          }
          await backend.keyring.delete(account);
          backend.store.removeCleanup(account);
        } catch (error) {
          this.observeBackendError(error);
        }
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store?.close();
  }

  private async list(scope: string): Promise<CredentialProfile[]> {
    const { store } = this.requireBackend();
    try {
      return store.listActive(scope);
    } catch (error) {
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
  }

  private async get(
    scope: string,
    id: string
  ): Promise<{ profile: CredentialProfile; secret: string }> {
    assertProfileId(id);
    return this.withLock(scope, id, async () => {
      const { store, keyring } = this.requireBackend();
      let record: CredentialRecord | undefined;
      try {
        record = store.getActiveRecord(scope, id);
      } catch (error) {
        throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
      }
      if (!record) throw credentialError('CREDENTIAL_PROFILE_NOT_FOUND');

      let secret: string | null;
      try {
        secret = await keyring.get(record.secretReference);
      } catch (error) {
        this.observeBackendError(error);
        throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
      }
      if (secret === null) throw credentialError('CREDENTIAL_PROFILE_NOT_FOUND');
      return { profile: asProfile(record), secret };
    });
  }

  private async put(
    scope: string,
    input: Parameters<PluginCredentialVault['put']>[0]
  ): Promise<CredentialProfile> {
    const id = input.id ?? this.randomUuid();
    assertProfileId(id);
    return this.withLock(scope, id, async () => {
      this.requireBackend();
      return input.id ? this.update(scope, id, input) : this.create(scope, id, input);
    });
  }

  private async create(
    scope: string,
    id: string,
    input: Parameters<PluginCredentialVault['put']>[0]
  ): Promise<CredentialProfile> {
    const { store, keyring } = this.requireBackend();
    const secretVersion = this.randomUuid();
    assertProfileId(secretVersion);
    let pending: CredentialRecord;
    try {
      pending = store.createPending({
        scope,
        id,
        label: input.label,
        metadata: input.metadata,
        secretVersion,
      });
    } catch (error) {
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }

    try {
      await keyring.set(pending.secretReference, input.secret);
    } catch (error) {
      this.observeBackendError(error);
      await this.compensatePending(pending);
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }

    let activated: boolean;
    try {
      activated = store.activatePending(scope, id, secretVersion);
    } catch (error) {
      const current = this.tryGetRecord(scope, id);
      if (current?.state === 'active' && current.secretReference === pending.secretReference) {
        return asProfile(current);
      }
      await this.compensatePending(pending);
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
    if (!activated) {
      await this.compensatePending(pending);
      throw credentialError('CREDENTIAL_PROFILE_CONFLICT');
    }

    try {
      const active = store.getActiveRecord(scope, id);
      if (!active) throw credentialError('CREDENTIAL_PROFILE_CONFLICT');
      return asProfile(active);
    } catch (error) {
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
  }

  private async update(
    scope: string,
    id: string,
    input: Parameters<PluginCredentialVault['put']>[0]
  ): Promise<CredentialProfile> {
    const { store, keyring } = this.requireBackend();
    let current: CredentialRecord | undefined;
    try {
      current = store.getActiveRecord(scope, id);
    } catch (error) {
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
    if (!current) throw credentialError('CREDENTIAL_PROFILE_NOT_FOUND');

    const secretVersion = this.randomUuid();
    assertProfileId(secretVersion);
    const newReference = `${scope}:${id}:${secretVersion}`;
    try {
      store.validateInput({
        scope,
        id,
        label: input.label,
        metadata: input.metadata,
        secretVersion,
      });
    } catch (error) {
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
    try {
      await keyring.set(newReference, input.secret);
    } catch (error) {
      this.observeBackendError(error);
      await this.cleanupUnreferenced(newReference);
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }

    let swapped: boolean;
    try {
      swapped = store.updateActive({
        scope,
        id,
        expectedSecretVersion: current.secretVersion,
        secretVersion,
        label: input.label,
        metadata: input.metadata,
      });
    } catch (error) {
      const observed = this.tryGetRecord(scope, id);
      if (observed?.state === 'active' && observed.secretReference === newReference) {
        await this.finishQueuedCleanup(current.secretReference);
        return asProfile(observed);
      }
      await this.cleanupUnreferenced(newReference);
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
    if (!swapped) {
      await this.cleanupUnreferenced(newReference);
      throw credentialError('CREDENTIAL_PROFILE_CONFLICT');
    }

    await this.finishQueuedCleanup(current.secretReference);
    try {
      const updated = store.getActiveRecord(scope, id);
      if (!updated) throw credentialError('CREDENTIAL_PROFILE_CONFLICT');
      return asProfile(updated);
    } catch (error) {
      throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
    }
  }

  private async delete(scope: string, id: string): Promise<void> {
    assertProfileId(id);
    return this.withLock(scope, id, async () => {
      const { store, keyring } = this.requireBackend();
      let current: CredentialRecord | undefined;
      try {
        current = store.getActiveRecord(scope, id);
      } catch (error) {
        throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
      }
      if (!current) throw credentialError('CREDENTIAL_PROFILE_NOT_FOUND');

      let marked: boolean;
      try {
        marked = store.markDeleting(scope, id, current.secretVersion);
      } catch (error) {
        const observed = this.tryGetRecord(scope, id);
        if (observed?.state !== 'deleting' || observed.secretReference !== current.secretReference) {
          throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
        }
        marked = true;
      }
      if (!marked) throw credentialError('CREDENTIAL_PROFILE_CONFLICT');

      try {
        await keyring.delete(current.secretReference);
      } catch (error) {
        this.observeBackendError(error);
        throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
      }

      try {
        if (!store.removeDeleting(scope, id, current.secretVersion)) {
          throw credentialError('CREDENTIAL_PROFILE_CONFLICT');
        }
      } catch (error) {
        throw stableError(error, 'CREDENTIAL_OPERATION_FAILED');
      }
    });
  }

  private async compensatePending(record: CredentialRecord): Promise<void> {
    const backend = this.backendOrUndefined();
    if (!backend) return;
    const recoverable = await this.cleanupUnreferenced(record.secretReference);
    if (!recoverable) return;
    try {
      backend.store.removePending(record.scope, record.id, record.secretVersion);
    } catch {
      // The pending row remains a durable recovery record.
    }
  }

  private async cleanupUnreferenced(account: string): Promise<boolean> {
    const backend = this.backendOrUndefined();
    if (!backend) return false;
    try {
      await backend.keyring.delete(account);
      return true;
    } catch (error) {
      this.observeBackendError(error);
      try {
        backend.store.queueCleanup(account);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async finishQueuedCleanup(account: string): Promise<void> {
    const backend = this.backendOrUndefined();
    if (!backend) return;
    try {
      await backend.keyring.delete(account);
      try {
        backend.store.removeCleanup(account);
      } catch {
        // updateActive already persisted the cleanup entry atomically.
      }
    } catch (error) {
      this.observeBackendError(error);
      // updateActive already persisted the cleanup entry atomically.
    }
  }

  private tryGetRecord(scope: string, id: string): CredentialRecord | undefined {
    try {
      return this.store?.getRecord(scope, id);
    } catch {
      return undefined;
    }
  }

  private observeBackendError(error: unknown): void {
    if (!isCredentialError(error)) return;
    if (error.code === 'CREDENTIALS_UNAVAILABLE' || error.code === 'CREDENTIALS_LOCKED') {
      this.unavailableReason = error.code;
    }
  }

  private requireBackend(): { store: CredentialStore; keyring: KeyringAdapter } {
    if (this.closed) throw credentialError('CREDENTIAL_OPERATION_FAILED');
    if (this.unavailableReason) throw credentialError(this.unavailableReason);
    if (!this.store || !this.keyring) throw credentialError('CREDENTIALS_UNAVAILABLE');
    return { store: this.store, keyring: this.keyring };
  }

  private backendOrUndefined(): { store: CredentialStore; keyring: KeyringAdapter } | undefined {
    if (this.closed || !this.store || !this.keyring) return undefined;
    return { store: this.store, keyring: this.keyring };
  }

  private async withLock<T>(scope: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = `${scope}\0${id}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export async function createCredentialVault(
  options: CreateCredentialVaultOptions
): Promise<CredentialVault> {
  if (options.mode === 'off') return new CredentialVault({ mode: 'off' });
  if (options.mode !== 'local') {
    return new CredentialVault({ mode: options.mode, unavailableReason: 'CREDENTIALS_UNAVAILABLE' });
  }

  let store: CredentialStore;
  try {
    const databasePath = options.databasePath ?? options.dbPath;
    if (options.store) {
      store = options.store;
    } else if (databasePath) {
      store = new CredentialStore(databasePath);
    } else {
      return new CredentialVault({ mode: 'local', unavailableReason: 'CREDENTIALS_UNAVAILABLE' });
    }
  } catch {
    return new CredentialVault({ mode: 'local', unavailableReason: 'CREDENTIALS_UNAVAILABLE' });
  }
  if (options.keyring) {
    return new CredentialVault({
      mode: 'local',
      store,
      keyring: options.keyring,
      randomUuid: options.randomUuid,
    });
  }

  try {
    const keyring = await createNativeKeyringAdapter({ mode: 'local', load: options.loadKeyring });
    return new CredentialVault({
      mode: 'local',
      store,
      keyring,
      randomUuid: options.randomUuid,
    });
  } catch (error) {
    const reason: UnavailableReason =
      isCredentialError(error) && error.code === 'CREDENTIALS_LOCKED'
        ? 'CREDENTIALS_LOCKED'
        : 'CREDENTIALS_UNAVAILABLE';
    return new CredentialVault({ mode: 'local', store, unavailableReason: reason });
  }
}

export async function createLocalCredentialVault(
  options: Omit<CreateCredentialVaultOptions, 'mode'>
): Promise<CredentialVault> {
  return createCredentialVault({ ...options, mode: 'local' });
}
