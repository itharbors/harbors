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

async function loadNativeKeyring(): Promise<KeyringModule> {
  return import('@napi-rs/keyring');
}

function nativeErrorSignature(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as Record<string, unknown>;
  return [record.code, record.name, record.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function classifyNativeError(error: unknown): CredentialErrorCode {
  if (isCredentialError(error)) return error.code;
  const signature = nativeErrorSignature(error);
  if (/no[_ -]?entry|not[_ -]?found/u.test(signature)) return 'CREDENTIAL_PROFILE_NOT_FOUND';
  if (/lock|denied|interaction[_ -]?not[_ -]?allowed|user[_ -]?cancel/u.test(signature)) {
    return 'CREDENTIALS_LOCKED';
  }
  if (
    /unavailable|not[_ -]?available|no[_ -]?secret[_ -]?service|dbus|unsupported|platform|binding|module/u.test(
      signature
    )
  ) {
    return 'CREDENTIALS_UNAVAILABLE';
  }
  return 'CREDENTIAL_OPERATION_FAILED';
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
