// @vitest-environment node

import type { UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(): Promise<UserConfig> {
  vi.resetModules();
  return (await import('../vite.config')).default as UserConfig;
}

describe('Vite listener security', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('enables credentials by default', async () => {
    vi.stubEnv('HARBORS_CREDENTIAL_MODE', undefined);
    vi.stubEnv('HARBORS_BIND_HOST', undefined);

    const config = await loadConfig();

    expect(config.server?.host).toBeUndefined();
  });

  it.each(['off', 'on'])('accepts the explicit credential mode %s', async (mode) => {
    vi.stubEnv('HARBORS_CREDENTIAL_MODE', mode);

    await expect(loadConfig()).resolves.toBeDefined();
  });

  it('rejects unknown credential modes before Vite can start', async () => {
    vi.stubEnv('HARBORS_CREDENTIAL_MODE', 'shared');

    await expect(loadConfig()).rejects.toThrow(/invalid credential mode/i);
  });

  it.each(['off', 'on'])('keeps the Vite bind host independent of credential mode %s', async (mode) => {
    vi.stubEnv('HARBORS_CREDENTIAL_MODE', mode);
    vi.stubEnv('HARBORS_BIND_HOST', '0.0.0.0');
    vi.stubEnv('CLIENT_PORT', '49382');

    const config = await loadConfig();

    expect(config.server).toMatchObject({
      host: '0.0.0.0',
      port: 49382,
      strictPort: true,
    });
  });
});
