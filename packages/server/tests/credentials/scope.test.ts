import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_SERVICE,
  credentialAccount,
  credentialScopeDigest,
} from '../../src/credentials/scope';

describe('credential identities', () => {
  it('derives the canonical local scope without exposing caller names', () => {
    expect(credentialScopeDigest('@itharbors/kit-mysql', '@itharbors/mysql-core')).toBe(
      'c9ae63325590735060748c1ce66911e4c0b1aaa7acbf610362d7d3e56d26c209'
    );
  });

  it('uses the fixed service and opaque account format', () => {
    const scope = 'a'.repeat(64);
    const profileId = '00112233-4455-4677-8899-aabbccddeeff';
    const secretVersion = 'ffeeddcc-bbaa-4988-8776-554433221100';

    expect(CREDENTIAL_SERVICE).toBe('com.itharbors.credentials.v1');
    expect(credentialAccount(scope, profileId, secretVersion)).toBe(
      `${scope}:${profileId}:${secretVersion}`
    );
  });
});
