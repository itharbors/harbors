import { describe, expect, it } from 'vitest';

import { resolveCredentialMode } from '../src/index.js';

describe('resolveCredentialMode', () => {
  it('keeps Web credentials off when no mode is explicitly requested', () => {
    expect(resolveCredentialMode({
      hostMode: 'web',
      requested: undefined,
      bindHost: undefined,
    })).toBe('off');
  });

  it.each(['127.0.0.1', '::1'])('defaults desktop credentials to local on %s', (bindHost) => {
    expect(resolveCredentialMode({
      hostMode: 'desktop',
      requested: undefined,
      bindHost,
    })).toBe('local');
  });

  it('keeps desktop credentials local when the desktop host listens on every IPv4 interface', () => {
    expect(resolveCredentialMode({
      hostMode: 'desktop',
      requested: 'local',
      bindHost: '0.0.0.0',
    })).toBe('local');
  });

  it.each([undefined, '::', 'localhost', '192.0.2.10'])(
    'rejects desktop local mode without an explicit loopback or wildcard bind (%s)',
    (bindHost) => {
      expect(() => resolveCredentialMode({
        hostMode: 'desktop',
        requested: 'local',
        bindHost,
      })).toThrow(/explicit/i);
    },
  );

  it.each([undefined, '0.0.0.0', '::', 'localhost', '192.0.2.10'])(
    'rejects local mode without an explicit IP loopback bind (%s)',
    (bindHost) => {
      expect(() => resolveCredentialMode({
        hostMode: 'web',
        requested: 'local',
        bindHost,
      })).toThrow(/loopback/i);
    },
  );

  it('does not infer local mode from a loopback request address or forwarded headers', () => {
    const requestDerivedInput = {
      hostMode: 'web',
      requested: 'local',
      bindHost: undefined,
      remoteAddress: '127.0.0.1',
      headers: {
        forwarded: 'for=127.0.0.1;host=127.0.0.1',
        'x-forwarded-for': '127.0.0.1',
        host: '127.0.0.1',
      },
    } as Parameters<typeof resolveCredentialMode>[0] & Record<string, unknown>;

    expect(() => resolveCredentialMode(requestDerivedInput)).toThrow(/loopback/i);
  });

  it('fails explicitly for the reserved multi-user mode', () => {
    expect(() => resolveCredentialMode({
      hostMode: 'web',
      requested: 'multi-user',
      bindHost: '127.0.0.1',
    })).toThrow(/not implemented/i);
  });

  it('rejects unknown credential modes', () => {
    expect(() => resolveCredentialMode({
      hostMode: 'web',
      requested: 'shared',
      bindHost: '127.0.0.1',
    })).toThrow(/invalid credential mode/i);
  });
});
