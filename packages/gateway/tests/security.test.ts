import { describe, expect, it } from 'vitest';

import { resolveGatewayCredentialMode } from '../src/security.js';

describe('gateway credential security', () => {
  it('keeps an ordinary Web gateway off by default', () => {
    expect(resolveGatewayCredentialMode({})).toBe('off');
  });

  it('accepts explicitly loopback-bound local mode', () => {
    expect(resolveGatewayCredentialMode({
      HARBORS_HOST_MODE: 'web',
      HARBORS_CREDENTIAL_MODE: 'local',
      HARBORS_BIND_HOST: '127.0.0.1',
    })).toBe('local');
  });

  it('rejects local mode when only request-derived loopback values are present', () => {
    expect(() => resolveGatewayCredentialMode({
      HARBORS_HOST_MODE: 'web',
      HARBORS_CREDENTIAL_MODE: 'local',
      REMOTE_ADDR: '127.0.0.1',
      HTTP_HOST: '127.0.0.1',
      HTTP_FORWARDED: 'for=127.0.0.1;host=127.0.0.1',
      HTTP_X_FORWARDED_FOR: '127.0.0.1',
    })).toThrow(/loopback/i);
  });
});
