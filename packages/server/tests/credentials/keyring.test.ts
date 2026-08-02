import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_HEALTH_ACCOUNT,
  createNativeKeyringAdapter,
  probeKeyringAdapter,
  type KeyringModule,
} from '../../src/credentials/keyring';
import { CREDENTIAL_SERVICE } from '../../src/credentials/scope';

function nativeModule(overrides: Partial<KeyringModule> = {}): KeyringModule {
  return {
    getPassword: vi.fn(() => null),
    setPassword: vi.fn(() => undefined),
    deletePassword: vi.fn(() => false),
    ...overrides,
  };
}

function nativeError(code: string, nativeText: string): Error & { code: string } {
  return Object.assign(new Error(nativeText), { code });
}

describe('native credential adapter', () => {
  it('probes the fixed service with a read-only reserved non-profile account', async () => {
    const module = nativeModule();
    const adapter = await createNativeKeyringAdapter({ mode: 'local', load: async () => module });

    await probeKeyringAdapter(adapter);

    expect(module.getPassword).toHaveBeenCalledWith(
      CREDENTIAL_SERVICE,
      CREDENTIAL_HEALTH_ACCOUNT,
    );
    expect(CREDENTIAL_HEALTH_ACCOUNT).not.toMatch(
      /^[a-f0-9]{64}:[0-9a-f-]{36}:[0-9a-f-]{36}$/iu,
    );
    expect(module.setPassword).not.toHaveBeenCalled();
    expect(module.deletePassword).not.toHaveBeenCalled();
  });

  it('passes only the fixed service, opaque account, and secret to the native module', async () => {
    const module = nativeModule({ getPassword: vi.fn(() => 'stored-value') });
    const adapter = await createNativeKeyringAdapter({ mode: 'local', load: async () => module });

    await expect(adapter.get('opaque-account')).resolves.toBe('stored-value');
    await adapter.set('opaque-account', 'new-value');
    await adapter.delete('opaque-account');

    expect(module.getPassword).toHaveBeenCalledWith(CREDENTIAL_SERVICE, 'opaque-account');
    expect(module.setPassword).toHaveBeenCalledWith(
      CREDENTIAL_SERVICE,
      'opaque-account',
      'new-value',
    );
    expect(module.deletePassword).toHaveBeenCalledWith(CREDENTIAL_SERVICE, 'opaque-account');
  });

  it('does not load the native module when credential mode is off', async () => {
    const load = vi.fn<() => Promise<KeyringModule>>();

    await expect(createNativeKeyringAdapter({ mode: 'off', load })).rejects.toMatchObject({
      code: 'CREDENTIALS_DISABLED',
      message: '凭据存储已禁用',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('maps a missing or malformed native module to a fixed unavailable error', async () => {
    const nativeText = 'Cannot find native binding at /private/native/path';
    const missingError = await createNativeKeyringAdapter({
      mode: 'local',
      load: async () => { throw new Error(nativeText); },
    }).catch((reason: unknown) => reason);

    expect(missingError).toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      message: '系统凭据库不可用',
    });
    expect(String(missingError)).not.toContain(nativeText);
    await expect(createNativeKeyringAdapter({
      mode: 'local',
      load: async () => ({}) as KeyringModule,
    })).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  });

  it('maps only stable native machine codes and never native message text', async () => {
    const lockedText = 'unlock details at /private/keychain';
    const unavailableText = 'backend details at /private/service';
    const deniedText = 'user denied details';
    const locked = await createNativeKeyringAdapter({
      load: async () => nativeModule({
        getPassword() { throw nativeError('BACKEND_LOCKED', lockedText); },
      }),
    });
    const unavailable = await createNativeKeyringAdapter({
      load: async () => nativeModule({
        setPassword() { throw nativeError('BACKEND_UNAVAILABLE', unavailableText); },
      }),
    });
    const denied = await createNativeKeyringAdapter({
      load: async () => nativeModule({
        deletePassword() { throw nativeError('ACCESS_DENIED', deniedText); },
      }),
    });

    const lockedError = await locked.get('account').catch((reason: unknown) => reason);
    const unavailableError = await unavailable.set('account', 'secret').catch((reason: unknown) => reason);
    const deniedError = await denied.delete('account').catch((reason: unknown) => reason);

    expect(lockedError).toMatchObject({ code: 'CREDENTIALS_LOCKED', message: '系统凭据库已锁定' });
    expect(unavailableError).toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      message: '系统凭据库不可用',
    });
    expect(deniedError).toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });
    expect(JSON.stringify([lockedError, unavailableError, deniedError])).not.toContain('/private');
    expect(String(deniedError)).not.toContain(deniedText);
  });

  it('maps unknown codes and suggestive messages to operation failed', async () => {
    const module = nativeModule({
      getPassword() {
        throw nativeError('SOMETHING_NEW', 'keyring locked and backend unavailable');
      },
    });
    const adapter = await createNativeKeyringAdapter({ load: async () => module });

    await expect(adapter.get('account')).rejects.toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });
  });

  it('treats only native null and false results as idempotent absence', async () => {
    const module = nativeModule();
    const adapter = await createNativeKeyringAdapter({ load: async () => module });

    await expect(adapter.get('missing')).resolves.toBeNull();
    await expect(adapter.delete('missing')).resolves.toBeUndefined();
    expect(module.deletePassword).toHaveReturnedWith(false);
  });
});
