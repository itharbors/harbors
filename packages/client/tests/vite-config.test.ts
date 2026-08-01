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

  it.each(['127.0.0.1', '::1'])(
    'binds the client listener to the validated explicit loopback %s',
    async (bindHost) => {
      vi.stubEnv('HARBORS_HOST_MODE', 'web');
      vi.stubEnv('HARBORS_CREDENTIAL_MODE', 'local');
      vi.stubEnv('HARBORS_BIND_HOST', bindHost);
      vi.stubEnv('CLIENT_PORT', '49382');

      const config = await loadConfig();

      expect(config.server).toMatchObject({
        host: bindHost,
        port: 49382,
        strictPort: true,
      });
    },
  );

  it('fails before Vite can listen when local mode has an unsafe bind', async () => {
    vi.stubEnv('HARBORS_HOST_MODE', 'web');
    vi.stubEnv('HARBORS_CREDENTIAL_MODE', 'local');
    vi.stubEnv('HARBORS_BIND_HOST', '0.0.0.0');

    await expect(loadConfig()).rejects.toThrow(/loopback/i);
  });

  it('does not silently enable or force local mode for default Web development', async () => {
    vi.stubEnv('HARBORS_HOST_MODE', 'web');
    vi.stubEnv('HARBORS_CREDENTIAL_MODE', undefined);
    vi.stubEnv('HARBORS_BIND_HOST', undefined);

    const config = await loadConfig();

    expect(config.server?.host).toBeUndefined();
  });
});
