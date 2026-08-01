import type { CredentialMode } from '@itharbors/plugin-types';
import { credentialError, isCredentialError, type CredentialErrorCode } from './errors';
import { CREDENTIAL_SERVICE } from './scope';

export interface KeyringAdapter {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface NativeKeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deletePassword(): boolean;
}

export interface KeyringModule {
  Entry: new (service: string, account: string) => NativeKeyringEntry;
}

export type KeyringModuleLoader = () => Promise<KeyringModule>;

export interface NativeKeyringOptions {
  mode?: CredentialMode;
  load?: KeyringModuleLoader;
}

// This reserved account cannot be produced by credentialAccount(). Health checks
// only attempt a read and never create or mutate a persistent keyring entry.
export const CREDENTIAL_HEALTH_ACCOUNT = '__harbors_credential_health_v1__';

const NATIVE_NOT_FOUND_CODES = new Set([
  'NO_ENTRY',
  'NOENTRY',
  'NOT_FOUND',
  'NOTFOUND',
]);
const NATIVE_LOCKED_CODES = new Set([
  'ACCESS_DENIED',
  'INTERACTION_NOT_ALLOWED',
  'KEYRING_LOCKED',
  'LOCKED',
  'USER_CANCELED',
  'USER_CANCELLED',
]);
const NATIVE_UNAVAILABLE_CODES = new Set([
  'BINDING_NOT_FOUND',
  'DBUS_ERROR',
  'MODULE_NOT_FOUND',
  'NO_SECRET_SERVICE',
  'NOT_AVAILABLE',
  'PLATFORM_UNSUPPORTED',
  'SERVICE_UNAVAILABLE',
  'UNAVAILABLE',
  'UNSUPPORTED_PLATFORM',
]);

async function loadNativeKeyring(): Promise<KeyringModule> {
  return import('@napi-rs/keyring');
}

function nativeErrorClassifications(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return [];
  const record = error as Record<string, unknown>;
  return [record.code, record.name]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toUpperCase().replaceAll(/[ -]/gu, '_'));
}

function classifyNativeError(error: unknown): CredentialErrorCode {
  if (isCredentialError(error)) return error.code;
  const classifications = nativeErrorClassifications(error);
  if (classifications.some((value) => NATIVE_NOT_FOUND_CODES.has(value))) {
    return 'CREDENTIAL_PROFILE_NOT_FOUND';
  }
  if (classifications.some((value) => NATIVE_LOCKED_CODES.has(value))) {
    return 'CREDENTIALS_LOCKED';
  }
  if (classifications.some((value) => NATIVE_UNAVAILABLE_CODES.has(value))) {
    return 'CREDENTIALS_UNAVAILABLE';
  }
  return 'CREDENTIAL_OPERATION_FAILED';
}

export async function probeKeyringAdapter(adapter: KeyringAdapter): Promise<void> {
  await adapter.get(CREDENTIAL_HEALTH_ACCOUNT);
}

function mappedNativeError(error: unknown): ReturnType<typeof credentialError> {
  return credentialError(classifyNativeError(error));
}

export async function createNativeKeyringAdapter(
  options: NativeKeyringOptions = {}
): Promise<KeyringAdapter> {
  const mode = options.mode ?? 'local';
  if (mode === 'off') throw credentialError('CREDENTIALS_DISABLED');
  if (mode !== 'local') throw credentialError('CREDENTIALS_UNAVAILABLE');

  let module: KeyringModule;
  try {
    module = await (options.load ?? loadNativeKeyring)();
    if (typeof module.Entry !== 'function') throw credentialError('CREDENTIALS_UNAVAILABLE');
  } catch {
    throw credentialError('CREDENTIALS_UNAVAILABLE');
  }

  return {
    async get(account) {
      try {
        return new module.Entry(CREDENTIAL_SERVICE, account).getPassword();
      } catch (error) {
        if (classifyNativeError(error) === 'CREDENTIAL_PROFILE_NOT_FOUND') return null;
        throw mappedNativeError(error);
      }
    },

    async set(account, secret) {
      try {
        new module.Entry(CREDENTIAL_SERVICE, account).setPassword(secret);
      } catch (error) {
        throw mappedNativeError(error);
      }
    },

    async delete(account) {
      try {
        new module.Entry(CREDENTIAL_SERVICE, account).deletePassword();
      } catch (error) {
        if (classifyNativeError(error) === 'CREDENTIAL_PROFILE_NOT_FOUND') return;
        throw mappedNativeError(error);
      }
    },
  };
}
