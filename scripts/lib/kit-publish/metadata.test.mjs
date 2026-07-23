import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKitPublicationMetadata,
  deriveArtifactName,
} from './metadata.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const previewTag = 'kit/mysql/v1.3.0-preview.1';
const publishSignerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2';

const stableManifest = {
  schemaVersion: 1,
  id: '@itharbors/kit-mysql',
  version: '1.2.3',
  channel: 'stable',
  publisher: 'itharbors',
  requires: {
    harbors: '>=1.0.0 <2.0.0',
    kitApi: '>=1.0.0 <2.0.0',
    protocolVersion: 1,
  },
  target: { platform: 'darwin', arch: 'arm64', nodeAbi: '127' },
  permissions: ['network', 'filesystem', 'native-code'],
  entry: 'package.json',
};

function input(overrides = {}) {
  const manifest = overrides.manifest ?? stableManifest;
  const tag = `kit/mysql/v${manifest.version}`;
  const ref = overrides.ref ?? `refs/tags/${tag}`;
  return {
    manifest,
    sha256: 'a'.repeat(64),
    size: 3_179,
    repository: 'itharbors/harbors',
    commit,
    workflow: overrides.workflow ?? `itharbors/harbors/.github/workflows/publish-kit.yml@${ref}`,
    signerWorkflow: publishSignerWorkflow,
    ref,
    tag,
    label: 'MySQL',
    summary: 'MySQL database workbench',
    ...overrides,
  };
}

test('creates immutable Stable Release and Registry metadata from the inspected artifact', () => {
  const metadata = createKitPublicationMetadata(input());
  assert.equal(metadata.artifactName, 'kit-mysql-1.2.3-darwin-arm64-abi127.hkit');
  assert.deepEqual(metadata.release, {
    schemaVersion: 1,
    id: stableManifest.id,
    version: stableManifest.version,
    channel: 'stable',
    publisher: 'itharbors',
    source: {
      repository: 'itharbors/harbors',
      commit,
      workflow: 'itharbors/harbors/.github/workflows/publish-kit.yml@refs/tags/kit/mysql/v1.2.3',
      signerWorkflow: publishSignerWorkflow,
      attestationUrl: `https://api.github.com/repos/itharbors/harbors/attestations/sha256:${'a'.repeat(64)}`,
    },
    assets: [{
      name: metadata.artifactName,
      url: 'https://github.com/itharbors/harbors/releases/download/kit%2Fmysql%2Fv1.2.3/kit-mysql-1.2.3-darwin-arm64-abi127.hkit',
      sha256: 'a'.repeat(64),
      size: 3_179,
      manifest: stableManifest,
    }],
  });
  assert.deepEqual(metadata.registryEntry, {
    schemaVersion: 1,
    id: stableManifest.id,
    label: 'MySQL',
    publisher: 'itharbors',
    summary: 'MySQL database workbench',
    channel: 'stable',
    version: '1.2.3',
    releaseManifestUrl: 'https://github.com/itharbors/harbors/releases/download/kit%2Fmysql%2Fv1.2.3/release.json',
    permissions: stableManifest.permissions,
    source: { repository: 'itharbors/harbors', tag: 'kit/mysql/v1.2.3' },
  });
  assert.equal(Object.isFrozen(metadata.release), true);
  assert.equal(Object.isFrozen(metadata.registryEntry), true);
});

test('creates Preview metadata only for a prerelease manifest on its immutable Tag', () => {
  const manifest = {
    ...stableManifest,
    version: '1.3.0-preview.1',
    channel: 'preview',
  };
  const metadata = createKitPublicationMetadata(input({ manifest }));
  assert.equal(metadata.registryEntry.channel, 'preview');
  assert.deepEqual(metadata.registryEntry.source, {
    repository: 'itharbors/harbors',
    tag: previewTag,
  });
  assert.match(metadata.release.assets[0].url, /kit%2Fmysql%2Fv1\.3\.0-preview\.1/u);
  assert.equal(
    metadata.release.source.workflow,
    `itharbors/harbors/.github/workflows/publish-kit.yml@refs/tags/${previewTag}`,
  );
  assert.equal(metadata.release.source.signerWorkflow, publishSignerWorkflow);
});

test('derives portable artifact names for any and native targets', () => {
  assert.equal(
    deriveArtifactName({ ...stableManifest, target: { platform: 'any', arch: 'any' } }),
    'kit-mysql-1.2.3-any-any.hkit',
  );
  assert.equal(deriveArtifactName(stableManifest), 'kit-mysql-1.2.3-darwin-arm64-abi127.hkit');
});

test('rejects channel-specific SemVer, Tag, source workflow, and signer mismatches', () => {
  const preview = { ...stableManifest, version: '1.2.3-preview.1', channel: 'preview' };
  for (const [name, overrides] of [
    ['Stable prerelease', { manifest: { ...stableManifest, version: '1.2.3-preview.1' } }],
    ['Preview release version', { manifest: { ...stableManifest, channel: 'preview' } }],
    ['Stable tag', { tag: 'kit/mysql/v9.9.9' }],
    ['Stable ref', { ref: 'refs/heads/kit/mysql' }],
    ['Preview branch ref', { manifest: preview, ref: 'refs/heads/kit/mysql' }],
    ['Preview tag version', { manifest: preview, tag: 'kit/mysql/v1.2.4-preview.1' }],
    ['Preview legacy tag', { manifest: preview, tag: 'preview/mysql/41-0123456789ab' }],
    ['publisher owner', { repository: 'other/harbors' }],
    ['workflow repository', { workflow: 'other/harbors/.github/workflows/publish-kit.yml@refs/tags/kit/mysql/v1.2.3' }],
    ['workflow path', { workflow: 'itharbors/harbors/.github/workflows/other.yml@refs/tags/kit/mysql/v1.2.3' }],
    ['workflow ref', { workflow: 'itharbors/harbors/.github/workflows/publish-kit.yml@refs/heads/main' }],
    ['signer workflow', { signerWorkflow: 'itharbors/harbors/.github/workflows/other.yml@refs/tags/kit-publish-v2' }],
    ['repository casing', { repository: 'ITHARBORS/harbors' }],
    ['digest', { sha256: 'A'.repeat(64) }],
  ]) {
    assert.throws(
      () => createKitPublicationMetadata(input(overrides)),
      Error,
      name,
    );
  }
});

test('rejects display metadata and Kit identities that could become paths or workflow commands', () => {
  for (const overrides of [
    { label: 'MySQL\nINJECT=1' },
    { summary: 'x'.repeat(281) },
    { manifest: { ...stableManifest, id: '@itharbors/mysql' } },
    { manifest: { ...stableManifest, id: '@other/kit-mysql' } },
  ]) {
    assert.throws(() => createKitPublicationMetadata(input(overrides)));
  }
});
