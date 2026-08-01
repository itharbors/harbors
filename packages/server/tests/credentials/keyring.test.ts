import { describe, expect, it, vi } from 'vitest';
import {
  createNativeKeyringAdapter,
  type KeyringModule,
} from '../../src/credentials/keyring';
import { CREDENTIAL_SERVICE } from '../../src/credentials/scope';

function moduleWithEntry(entry: {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deletePassword(): boolean;
}): { module: KeyringModule; constructions: Array<[string, string]> } {
  const constructions: Array<[string, string]> = [];
  class Entry {
    constructor(service: string, account: string) {
      constructions.push([service, account]);
    }

    getPassword(): string | null {
      return entry.getPassword();
    }

    setPassword(secret: string): void {
      entry.setPassword(secret);
    }

    deletePassword(): boolean {
      return entry.deletePassword();
    }
  }
  return { module: { Entry }, constructions };
}

describe('native keyring adapter', () => {
  it('wraps each opaque account with the fixed Harbors service', async () => {
    const nativeEntry = {
      getPassword: vi.fn(() => 'stored-value'),
      setPassword: vi.fn((_secret: string) => undefined),
      deletePassword: vi.fn(() => true),
    };
    const { module, constructions } = moduleWithEntry(nativeEntry);
    const adapter = await createNativeKeyringAdapter({ mode: 'local', load: async () => module });

    await expect(adapter.get('opaque-account')).resolves.toBe('stored-value');
    await adapter.set('opaque-account', 'new-value');
    await adapter.delete('opaque-account');

    expect(constructions).toEqual([
      [CREDENTIAL_SERVICE, 'opaque-account'],
      [CREDENTIAL_SERVICE, 'opaque-account'],
      [CREDENTIAL_SERVICE, 'opaque-account'],
    ]);
    expect(nativeEntry.setPassword).toHaveBeenCalledWith('new-value');
  });

  it('does not load the native module when credential mode is off', async () => {
    const load = vi.fn<() => Promise<KeyringModule>>();

    await expect(createNativeKeyringAdapter({ mode: 'off', load })).rejects.toMatchObject({
      code: 'CREDENTIALS_DISABLED',
      message: '凭据存储已禁用',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('maps a missing native module to a fixed unavailable error', async () => {
    const nativeText = 'Cannot find native binding at /private/native/path';

    const error = await createNativeKeyringAdapter({
      mode: 'local',
      load: async () => {
        throw new Error(nativeText);
      },
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      message: '系统凭据库不可用',
    });
    expect(JSON.stringify(error)).not.toContain(nativeText);
    expect(String(error)).not.toContain(nativeText);
  });

  it('rejects a native module that does not expose Entry', async () => {
    const malformedModule = {} as KeyringModule;

    await expect(
      createNativeKeyringAdapter({ mode: 'local', load: async () => malformedModule })
    ).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      message: '系统凭据库不可用',
    });
  });

  it('maps a Linux host without Secret Service to unavailable without native text', async () => {
    const nativeText = 'org.freedesktop.secrets service is not available';
    const { module } = moduleWithEntry({
      getPassword() {
        throw Object.assign(new Error(nativeText), { code: 'NO_SECRET_SERVICE' });
      },
      setPassword() {
        throw new Error('unused');
      },
      deletePassword() {
        throw new Error('unused');
      },
    });
    const adapter = await createNativeKeyringAdapter({ mode: 'local', load: async () => module });

    const error = await adapter.get('opaque-account').catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      message: '系统凭据库不可用',
    });
    expect(String(error)).not.toContain(nativeText);
  });

  it('maps a locked backend and an unknown failure to fixed errors', async () => {
    const locked = moduleWithEntry({
      getPassword: () => null,
      setPassword() {
        throw Object.assign(new Error('native unlock details'), { code: 'KEYRING_LOCKED' });
      },
      deletePassword: () => false,
    });
    const unknown = moduleWithEntry({
      getPassword: () => null,
      setPassword: () => undefined,
      deletePassword() {
        throw new Error('native delete details');
      },
    });
    const lockedAdapter = await createNativeKeyringAdapter({
      mode: 'local',
      load: async () => locked.module,
    });
    const unknownAdapter = await createNativeKeyringAdapter({
      mode: 'local',
      load: async () => unknown.module,
    });

    await expect(lockedAdapter.set('opaque-account', 'new-value')).rejects.toMatchObject({
      code: 'CREDENTIALS_LOCKED',
      message: '系统凭据库已锁定',
    });
    await expect(unknownAdapter.delete('opaque-account')).rejects.toMatchObject({
      code: 'CREDENTIAL_OPERATION_FAILED',
      message: '凭据操作失败',
    });
  });

  it('treats a missing native entry as an absent secret and idempotent deletion', async () => {
    const { module } = moduleWithEntry({
      getPassword() {
        throw Object.assign(new Error('NoEntry'), { code: 'NO_ENTRY' });
      },
      setPassword: () => undefined,
      deletePassword() {
        throw Object.assign(new Error('NoEntry'), { code: 'NO_ENTRY' });
      },
    });
    const adapter = await createNativeKeyringAdapter({ mode: 'local', load: async () => module });

    await expect(adapter.get('opaque-account')).resolves.toBeNull();
    await expect(adapter.delete('opaque-account')).resolves.toBeUndefined();
  });
});
