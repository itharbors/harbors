import assert from 'node:assert/strict';
import test from 'node:test';

import * as metadataModule from './metadata.mjs';

const {
  parseAppReleaseTag,
  validateAppReleaseIdentity,
  validateAppUpdateMetadata,
} = metadataModule;

test('parses canonical stable app releases', () => {
  assert.deepEqual(parseAppReleaseTag('refs/tags/v1.2.3'), {
    version: '1.2.3',
    channel: 'stable',
    tag: 'v1.2.3',
  });
});

test('parses canonical preview app releases', () => {
  assert.deepEqual(parseAppReleaseTag('refs/tags/v1.2.3-preview.1'), {
    version: '1.2.3-preview.1',
    channel: 'preview',
    tag: 'v1.2.3-preview.1',
  });
});

for (const ref of [
  'v1.2.3',
  'refs/tags/v01.2.3',
  'refs/tags/v1.2.3+build.1',
  'refs/tags/app/v1.2.3',
  'refs/tags/kit/sqlite/v1.2.3',
]) {
  test(`rejects invalid app release ref: ${ref}`, () => {
    assert.throws(() => parseAppReleaseTag(ref));
  });
}

test('validates that the app tag and desktop package version agree', () => {
  assert.deepEqual(
    validateAppReleaseIdentity({
      ref: 'refs/tags/v1.2.3-preview.1',
      packageVersion: '1.2.3-preview.1',
    }),
    { version: '1.2.3-preview.1', channel: 'preview', tag: 'v1.2.3-preview.1' },
  );
  assert.throws(() => validateAppReleaseIdentity({
    ref: 'refs/tags/v1.2.3',
    packageVersion: '1.2.4',
  }));
});

test('validates the exact ZIP and DMG references emitted in latest-mac.yml', () => {
  assert.equal(typeof validateAppUpdateMetadata, 'function');
  const zipName = 'ITHARBORS-1.2.3-preview.2-arm64-mac.zip';
  const dmgName = 'ITHARBORS-1.2.3-preview.2-arm64.dmg';
  const valid = {
    version: '1.2.3-preview.2',
    files: [
      { url: zipName, sha512: 'zip' },
      { url: dmgName, sha512: 'dmg' },
    ],
    path: zipName,
  };

  assert.doesNotThrow(() => validateAppUpdateMetadata({
    metadata: valid,
    zipName,
    dmgName,
  }));

  for (const metadata of [
    { ...valid, files: [{ url: zipName }] },
    { ...valid, files: [...valid.files, { url: 'unexpected.pkg' }] },
    { ...valid, files: [{ url: zipName }, { url: zipName }] },
    { ...valid, path: dmgName },
  ]) {
    assert.throws(() => validateAppUpdateMetadata({ metadata, zipName, dmgName }), /latest-mac\.yml/u);
  }
});
