import { describe, expect, it } from 'vitest';

import { resolveCredentialMode } from '../src/index.js';

describe('resolveCredentialMode', () => {
  it('defaults credentials on when no mode is explicitly requested', () => {
    expect(resolveCredentialMode({})).toBe('on');
  });

  it.each(['off', 'on'])('accepts the supported mode %s', (requested) => {
    expect(resolveCredentialMode({ requested })).toBe(requested);
  });

  it('does not depend on host mode or bind address', () => {
    expect(resolveCredentialMode({ requested: 'on' })).toBe('on');
  });

  it('rejects unknown credential modes', () => {
    expect(() => resolveCredentialMode({ requested: 'shared' })).toThrow(/invalid credential mode/i);
  });
});
