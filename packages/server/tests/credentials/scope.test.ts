import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_SERVICE,
  credentialAccount,
  credentialScopeDigest,
} from '../../src/credentials/scope';

describe('credential identities', () => {
  it('derives the versioned User scope without exposing caller names', () => {
    expect(credentialScopeDigest('test-user', '@itharbors/kit-mysql', '@itharbors/mysql-core')).toBe(
      'c9bac68c9217c7689223b3ba03aeb083a9643169b6c959c25f0624742418e106'
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
