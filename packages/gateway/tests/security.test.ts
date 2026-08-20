import { describe, expect, it } from 'vitest';

import {
  resolveGatewayCredentialMode,
  resolveGatewayUpstreamHost,
} from '../src/security.js';

describe('gateway credential security', () => {
  it('enables credentials by default', () => {
    expect(resolveGatewayCredentialMode({})).toBe('on');
  });

  it.each(['off', 'on'])('accepts the supported mode %s', (requested) => {
    expect(resolveGatewayCredentialMode({
      HARBORS_CREDENTIAL_MODE: requested,
    })).toBe(requested);
  });

  it('does not use the listener address to restrict credentials', () => {
    expect(() => resolveGatewayCredentialMode({
      HARBORS_CREDENTIAL_MODE: 'on',
    })).not.toThrow();
  });

  it('rejects unknown credential modes', () => {
    expect(() => resolveGatewayCredentialMode({
      HARBORS_CREDENTIAL_MODE: 'shared',
    })).toThrow(/invalid credential mode/i);
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['0.0.0.0', '127.0.0.1'],
    ['::', '::1'],
    [undefined, 'localhost'],
  ])('routes upstream traffic to the listener represented by %s', (bindHost, expected) => {
    expect(resolveGatewayUpstreamHost(bindHost)).toBe(expected);
  });
});
