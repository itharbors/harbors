import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAppReleaseTag, validateAppReleaseIdentity } from './metadata.mjs';

test('parses canonical stable app releases', () => {
  assert.deepEqual(parseAppReleaseTag('refs/tags/app/v1.2.3'), {
    version: '1.2.3',
    channel: 'stable',
    tag: 'app/v1.2.3',
  });
});

test('parses canonical preview app releases', () => {
  assert.deepEqual(parseAppReleaseTag('refs/tags/app/v1.2.3-preview.1'), {
    version: '1.2.3-preview.1',
    channel: 'preview',
    tag: 'app/v1.2.3-preview.1',
  });
});

for (const ref of [
  'app/v1.2.3',
  'refs/tags/app/v01.2.3',
  'refs/tags/app/v1.2.3+build.1',
  'refs/tags/kit/sqlite/v1.2.3',
]) {
  test(`rejects invalid app release ref: ${ref}`, () => {
    assert.throws(() => parseAppReleaseTag(ref));
  });
}

test('validates that the app tag and desktop package version agree', () => {
  assert.deepEqual(
    validateAppReleaseIdentity({
      ref: 'refs/tags/app/v1.2.3-preview.1',
      packageVersion: '1.2.3-preview.1',
    }),
    { version: '1.2.3-preview.1', channel: 'preview', tag: 'app/v1.2.3-preview.1' },
  );
  assert.throws(() => validateAppReleaseIdentity({
    ref: 'refs/tags/app/v1.2.3',
    packageVersion: '1.2.4',
  }));
});
