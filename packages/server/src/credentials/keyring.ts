import type { CredentialMode } from '@itharbors/plugin-types';
import { credentialError, isCredentialError, type CredentialErrorCode } from './errors';
import { CREDENTIAL_SERVICE } from './scope';

export interface KeyringAdapter {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface KeyringModule {
  getPassword(service: string, account: string): string | null;
  setPassword(service: string, account: string, secret: string): void;
  deletePassword(service: string, account: string): boolean;
}

export type KeyringModuleLoader = () => Promise<KeyringModule>;

export interface NativeKeyringOptions {
  mode?: CredentialMode;
  load?: KeyringModuleLoader;
}

// This reserved account cannot be produced by credentialAccount(). Health checks
// only attempt a read and never create or mutate a persistent keyring entry.
export const CREDENTIAL_HEALTH_ACCOUNT = '__harbors_credential_health_v1__';

async function loadNativeKeyring(): Promise<KeyringModule> {
  const imported = await import('@itharbors/native-credential-vault');
  const candidate = imported.default ?? imported;
  return candidate as KeyringModule;
}

function nativeErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>).code
    : undefined;
}

function classifyNativeError(error: unknown): CredentialErrorCode {
  if (isCredentialError(error)) return error.code;
  const code = nativeErrorCode(error);
  if (code === 'BACKEND_LOCKED') return 'CREDENTIALS_LOCKED';
  if (code === 'BACKEND_UNAVAILABLE') return 'CREDENTIALS_UNAVAILABLE';
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
    if (
      typeof module?.getPassword !== 'function'
      || typeof module.setPassword !== 'function'
      || typeof module.deletePassword !== 'function'
    ) throw credentialError('CREDENTIALS_UNAVAILABLE');
  } catch {
    throw credentialError('CREDENTIALS_UNAVAILABLE');
  }

  return {
    async get(account) {
      try {
        const secret = module.getPassword(CREDENTIAL_SERVICE, account);
        if (secret !== null && typeof secret !== 'string') {
          throw credentialError('CREDENTIAL_OPERATION_FAILED');
        }
        return secret;
      } catch (error) {
        throw mappedNativeError(error);
      }
    },

    async set(account, secret) {
      try {
        module.setPassword(CREDENTIAL_SERVICE, account, secret);
      } catch (error) {
        throw mappedNativeError(error);
      }
    },

    async delete(account) {
      try {
        const deleted = module.deletePassword(CREDENTIAL_SERVICE, account);
        if (typeof deleted !== 'boolean') {
          throw credentialError('CREDENTIAL_OPERATION_FAILED');
        }
      } catch (error) {
        throw mappedNativeError(error);
      }
    },
  };
}
