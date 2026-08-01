import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../main/src/redact';

describe('redactSecrets', () => {
  it('recursively masks secret-bearing keys without mutating input', () => {
    const input = { authorization: 'Bearer private', nested: { api_key: 'private', safe: 'visible', entries: [{ accessToken: 'private' }] } };
    expect(redactSecrets(input)).toEqual({ authorization: '[REDACTED]', nested: { api_key: '[REDACTED]', safe: 'visible', entries: [{ accessToken: '[REDACTED]' }] } });
    expect(input.nested.api_key).toBe('private');
  });
});
