import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodeKitId, parseKitRegistryIndex } from '@itharbors/kit-core';

import {
  aggregateKitRegistry,
  buildKitRegistryIndex,
  parseRegistryEntry,
  validateRegistryRelease,
} from './registry.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const repository = 'itharbors/harbors';
const publishSignerV1 = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';
const publishSignerV2 = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2';

function manifest(channel = 'stable') {
  return {
    schemaVersion: 1,
    id: '@itharbors/kit-mysql',
    version: channel === 'stable' ? '1.2.3' : '1.3.0-preview.1',
    channel,
    publisher: 'itharbors',
    requires: {
      harbors: '>=1.0.0 <2.0.0',
      kitApi: '>=1.0.0 <2.0.0',
      protocolVersion: 1,
    },
    target: { platform: 'any', arch: 'any' },
    permissions: ['network'],
    entry: 'package.json',
  };
}

function entry(channel = 'stable', overrides = {}) {
  const value = manifest(channel);
  const tag = `kit/mysql/v${value.version}`;
  return {
    schemaVersion: 1,
    id: value.id,
    label: 'MySQL',
    publisher: value.publisher,
    summary: 'MySQL database workbench',
    channel,
    version: value.version,
    releaseManifestUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/release.json`,
    permissions: value.permissions,
    source: { repository, tag },
    ...overrides,
  };
}

function release(channel = 'stable', overrides = {}) {
  const value = manifest(channel);
  const publication = entry(channel);
  const artifactName = `kit-mysql-${value.version}-any-any.hkit`;
  return {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    channel,
    publisher: value.publisher,
    source: {
      repository,
      commit,
      workflow: `${repository}/.github/workflows/publish-kit.yml@refs/tags/${publication.source.tag}`,
      signerWorkflow: publishSignerV1,
      attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${digest}`,
    },
    assets: [{
      name: artifactName,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(publication.source.tag)}/${artifactName}`,
      sha256: digest,
      size: 3_179,
      manifest: value,
    }],
    ...overrides,
  };
}

test('builds a deterministic Registry index from verified Stable and Preview entries', () => {
  const stable = entry('stable');
  const preview = entry('preview');
  const index = buildKitRegistryIndex({
    entries: [preview, stable],
    releasesByUrl: new Map([
      [preview.releaseManifestUrl, release('preview')],
      [stable.releaseManifestUrl, release('stable')],
    ]),
    revocations: [{
      id: stable.id,
      version: stable.version,
      sha256: digest,
      reason: 'known-vulnerability',
      action: 'block-install',
      releaseManifestUrl: stable.releaseManifestUrl,
    }],
    generatedAt: '2026-07-23T12:00:00.000Z',
  });
  assert.deepEqual(index, {
    schemaVersion: 1,
    generatedAt: '2026-07-23T12:00:00.000Z',
    kits: [{
      id: stable.id,
      label: stable.label,
      publisher: stable.publisher,
      summary: stable.summary,
      channels: {
        stable: {
          version: stable.version,
          releaseManifestUrl: stable.releaseManifestUrl,
          permissions: ['network'],
        },
        preview: {
          version: preview.version,
          releaseManifestUrl: preview.releaseManifestUrl,
          permissions: ['network'],
        },
      },
    }],
    revocations: [{
      id: stable.id,
      version: stable.version,
      sha256: digest,
      reason: 'known-vulnerability',
      action: 'block-install',
    }],
  });
  assert.deepEqual(parseKitRegistryIndex(index), index);
  assert.equal(Object.isFrozen(index), true);
});

test('parses only canonical channel entries with exact GitHub Release URLs', () => {
  const stable = entry('stable');
  const preview = entry('preview');
  assert.deepEqual(parseRegistryEntry(stable), stable);
  assert.deepEqual(parseRegistryEntry(preview), preview);
  for (const mutation of [
    { extra: true },
    { releaseManifestUrl: 'https://example.test/release.json' },
    { source: { ...stable.source, repository: 'other/harbors' } },
    { source: { ...stable.source, tag: 'kit/mysql/v9.9.9' } },
  ]) {
    assert.throws(() => parseRegistryEntry({ ...stable, ...mutation }));
  }
  assert.throws(() => parseRegistryEntry({
    ...preview,
    source: { ...preview.source, tag: 'preview/mysql/41-0123456789ab' },
  }));
});

test('rejects duplicate channels and inconsistent display identity for one Kit', () => {
  const stable = entry('stable');
  const releasesByUrl = new Map([[stable.releaseManifestUrl, release('stable')]]);
  assert.throws(() => buildKitRegistryIndex({
    entries: [stable, stable],
    releasesByUrl,
    revocations: [],
    generatedAt: '2026-07-23T12:00:00.000Z',
  }), /duplicate/i);
  const preview = entry('preview', { label: 'Different' });
  assert.throws(() => buildKitRegistryIndex({
    entries: [stable, preview],
    releasesByUrl: new Map([
      [stable.releaseManifestUrl, release('stable')],
      [preview.releaseManifestUrl, release('preview')],
    ]),
    revocations: [],
    generatedAt: '2026-07-23T12:00:00.000Z',
  }), /identity/i);
});

test('trusts only immutable v1 or v2 signer releases with Tag-based caller workflows', () => {
  const preview = entry('preview');
  for (const signerWorkflow of [publishSignerV1, publishSignerV2]) {
    assert.doesNotThrow(() => buildKitRegistryIndex({
      entries: [preview],
      releasesByUrl: new Map([[preview.releaseManifestUrl, release('preview', {
        source: { ...release('preview').source, signerWorkflow },
      })]]),
      revocations: [],
      generatedAt: '2026-07-23T12:00:00.000Z',
    }));
  }
  for (const signerWorkflow of [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/heads/main',
  ]) {
    assert.throws(() => buildKitRegistryIndex({
      entries: [preview],
      releasesByUrl: new Map([[preview.releaseManifestUrl, release('preview', {
        source: { ...release('preview').source, signerWorkflow },
      })]]),
      revocations: [],
      generatedAt: '2026-07-23T12:00:00.000Z',
    }), /signer/i);
  }
  assert.throws(() => buildKitRegistryIndex({
    entries: [preview],
    releasesByUrl: new Map([[preview.releaseManifestUrl, release('preview', {
      source: {
        ...release('preview').source,
        workflow: `${repository}/.github/workflows/publish-kit.yml@refs/heads/kit/mysql`,
      },
    })]]),
    revocations: [],
    generatedAt: '2026-07-23T12:00:00.000Z',
  }), /workflow/i);
});

test('rejects Release identity, permissions, repository, workflow, asset URL, and attestation drift', () => {
  const stable = entry('stable');
  const base = release('stable');
  const mutations = [
    { ...base, version: '1.2.4' },
    { ...base, assets: [{ ...base.assets[0], manifest: { ...base.assets[0].manifest, permissions: [] } }] },
    { ...base, source: { ...base.source, repository: 'itharbors/other' } },
    { ...base, source: { ...base.source, workflow: `${repository}/.github/workflows/other.yml@refs/tags/${stable.source.tag}` } },
    { ...base, assets: [{ ...base.assets[0], url: 'https://example.test/kit.hkit' }] },
    { ...base, source: { ...base.source, attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${'b'.repeat(64)}` } },
  ];
  for (const mutated of mutations) {
    assert.throws(() => buildKitRegistryIndex({
      entries: [stable],
      releasesByUrl: new Map([[stable.releaseManifestUrl, mutated]]),
      revocations: [],
      generatedAt: '2026-07-23T12:00:00.000Z',
    }));
  }
});

test('requires the only Release asset to use the name derived from its parsed manifest', () => {
  const stable = entry('stable');
  const base = release('stable');
  for (const name of [
    'source.zip',
    'kit-mysql-9.9.9-any-any.hkit',
  ]) {
    const mutated = {
      ...base,
      assets: [{
        ...base.assets[0],
        name,
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(stable.source.tag)}/${name}`,
      }],
    };
    assert.throws(() => buildKitRegistryIndex({
      entries: [stable],
      releasesByUrl: new Map([[stable.releaseManifestUrl, mutated]]),
      revocations: [],
      generatedAt: '2026-07-23T12:00:00.000Z',
    }), /asset/i);
  }
});

test('exports the strict Registry Release validator for trusted Release discovery', () => {
  const stable = entry('stable');
  assert.deepEqual(validateRegistryRelease(stable, release('stable')), release('stable'));
  assert.throws(() => validateRegistryRelease(stable, release('stable', {
    source: {
      ...release('stable').source,
      workflow: `${repository}/.github/workflows/publish-kit.yml@refs/heads/main`,
    },
  })), /workflow/i);
});

test('validates Preview revocation evidence against its exact immutable Tag', () => {
  const preview = entry('preview');
  const revocation = {
    id: preview.id,
    version: preview.version,
    sha256: digest,
    reason: 'known-vulnerability',
    action: 'block-install',
    releaseManifestUrl: preview.releaseManifestUrl,
  };
  assert.doesNotThrow(() => buildKitRegistryIndex({
    entries: [preview],
    releasesByUrl: new Map([[preview.releaseManifestUrl, release('preview')]]),
    revocations: [revocation],
    generatedAt: '2026-07-23T12:00:00.000Z',
  }));
  assert.throws(() => buildKitRegistryIndex({
    entries: [preview],
    releasesByUrl: new Map([
      [preview.releaseManifestUrl, release('preview')],
      ['https://github.com/itharbors/harbors/releases/download/preview%2Fmysql%2F41-0123456789ab/release.json', release('preview')],
    ]),
    revocations: [{
      ...revocation,
      releaseManifestUrl: `https://github.com/${repository}/releases/download/preview%2Fmysql%2F41-0123456789ab/release.json`,
    }],
    generatedAt: '2026-07-23T12:00:00.000Z',
  }), (error) => {
    assert.equal(error.message, 'Revocation evidence must be an immutable GitHub Release manifest');
    assert.doesNotMatch(error.message, /Stable/u);
    return true;
  });
});

test('requires revocation evidence to meet the immutable Release trust contract', () => {
  const preview = entry('preview');
  const base = release('preview');
  const revocation = {
    id: preview.id,
    version: preview.version,
    sha256: digest,
    reason: 'known-vulnerability',
    action: 'block-install',
    releaseManifestUrl: preview.releaseManifestUrl,
  };
  const mutations = [
    {
      source: {
        ...base.source,
        workflow: `${repository}/.github/workflows/publish-kit.yml@refs/heads/kit/mysql`,
      },
    },
    {
      source: {
        ...base.source,
        signerWorkflow: 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
      },
    },
    {
      source: {
        ...base.source,
        signerWorkflow: 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/heads/main',
      },
    },
    {
      assets: [{
        ...base.assets[0],
        name: 'source.zip',
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(preview.source.tag)}/source.zip`,
      }],
    },
    {
      assets: [{
        ...base.assets[0],
        name: 'kit-mysql-9.9.9-any-any.hkit',
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(preview.source.tag)}/kit-mysql-9.9.9-any-any.hkit`,
      }],
    },
    { assets: [{ ...base.assets[0], url: 'https://example.test/kit.hkit' }] },
    {
      source: {
        ...base.source,
        attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${'b'.repeat(64)}`,
      },
    },
  ];
  for (const mutation of mutations) {
    assert.throws(() => buildKitRegistryIndex({
      entries: [],
      releasesByUrl: new Map([[preview.releaseManifestUrl, { ...base, ...mutation }]]),
      revocations: [revocation],
      generatedAt: '2026-07-23T12:00:00.000Z',
    }), /workflow|signer|asset|attestation/i);
  }
});

test('loads canonical entry paths, fetches bounded manifests, and validates revocation evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-registry-'));
  const entriesDirectory = path.join(root, 'entries');
  const stable = entry('stable');
  const encoded = encodeKitId(stable.id);
  await mkdir(path.join(entriesDirectory, encoded), { recursive: true });
  await writeFile(path.join(entriesDirectory, encoded, 'stable.json'), JSON.stringify(stable));
  const revocationsFile = path.join(root, 'revocations.json');
  await writeFile(revocationsFile, JSON.stringify({
    schemaVersion: 1,
    revocations: [{
      id: stable.id,
      version: stable.version,
      sha256: digest,
      reason: 'known-vulnerability',
      action: 'deactivate',
      releaseManifestUrl: stable.releaseManifestUrl,
    }],
  }));
  try {
    const requests = [];
    const index = await aggregateKitRegistry({
      entriesDirectory,
      revocationsFile,
      generatedAt: '2026-07-23T12:00:00.000Z',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(release('stable')));
      },
    });
    assert.equal(index.kits.length, 1);
    assert.equal(index.revocations.length, 1);
    assert.deepEqual(requests.map(({ url }) => url), [stable.releaseManifestUrl]);
    assert.equal(requests[0].init.redirect, 'follow');

    await writeFile(path.join(entriesDirectory, encoded, 'preview.json'), JSON.stringify(stable));
    await assert.rejects(() => aggregateKitRegistry({
      entriesDirectory,
      revocationsFile,
      generatedAt: '2026-07-23T12:00:00.000Z',
      fetchImpl: async () => new Response(JSON.stringify(release('stable'))),
    }), /path|channel/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects failed, oversized, invalid, and missing remote Release manifests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-registry-'));
  const stable = entry('stable');
  const entriesDirectory = path.join(root, 'entries', encodeKitId(stable.id));
  await mkdir(entriesDirectory, { recursive: true });
  await writeFile(path.join(entriesDirectory, 'stable.json'), JSON.stringify(stable));
  const revocationsFile = path.join(root, 'revocations.json');
  await writeFile(revocationsFile, JSON.stringify({ schemaVersion: 1, revocations: [] }));
  try {
    for (const response of [
      new Response('missing', { status: 404 }),
      new Response('{'),
      new Response('x'.repeat(1_100_000)),
    ]) {
      await assert.rejects(() => aggregateKitRegistry({
        entriesDirectory: path.dirname(entriesDirectory),
        revocationsFile,
        generatedAt: '2026-07-23T12:00:00.000Z',
        fetchImpl: async () => response,
      }));
    }
    assert.throws(() => buildKitRegistryIndex({
      entries: [stable],
      releasesByUrl: new Map(),
      revocations: [],
      generatedAt: '2026-07-23T12:00:00.000Z',
    }), /missing/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
