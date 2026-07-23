import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseKitRegistryIndex } from '@itharbors/kit-core';

import {
  aggregateKitRegistry,
  buildKitRegistryIndex,
  parseRegistryEntry,
  validateRegistryRelease,
} from './registry.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const repository = 'itharbors/harbors';
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
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

function entryAtVersion({ version, channel }) {
  const value = entry(channel);
  const tag = `kit/mysql/v${version}`;
  return {
    ...value,
    version,
    releaseManifestUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/release.json`,
    source: { repository, tag },
  };
}

function releaseAtVersion({ version, channel, sha256 = digest }) {
  const value = release(channel);
  const publication = entryAtVersion({ version, channel });
  const artifactName = `kit-mysql-${version}-any-any.hkit`;
  return {
    ...value,
    version,
    channel,
    source: {
      ...value.source,
      workflow: `${repository}/.github/workflows/publish-kit.yml@refs/tags/${publication.source.tag}`,
      attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${sha256}`,
    },
    assets: [{
      ...value.assets[0],
      name: artifactName,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(publication.source.tag)}/${artifactName}`,
      sha256,
      manifest: { ...value.assets[0].manifest, version, channel },
    }],
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

test('selects the newest valid version in each channel after validating every Release', () => {
  const entries = [
    entryAtVersion({ version: '1.0.0', channel: 'stable' }),
    entryAtVersion({ version: '1.1.0', channel: 'stable' }),
    entryAtVersion({ version: '2.0.0', channel: 'stable' }),
    entryAtVersion({ version: '2.1.0-preview.1', channel: 'preview' }),
    entryAtVersion({ version: '2.1.0-preview.2', channel: 'preview' }),
  ];
  const releasesByUrl = new Map(entries.map((candidate) => [candidate.releaseManifestUrl, releaseAtVersion(candidate)]));
  const index = buildKitRegistryIndex({
    entries: [...entries].reverse(),
    releasesByUrl,
    revocations: [],
    generatedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(index.kits[0].channels.stable.version, '2.0.0');
  assert.equal(index.kits[0].channels.preview.version, '2.1.0-preview.2');

  const oldest = entries[0];
  releasesByUrl.set(oldest.releaseManifestUrl, {
    ...releaseAtVersion(oldest),
    source: {
      ...releaseAtVersion(oldest).source,
      workflow: `${repository}/.github/workflows/publish-kit.yml@refs/heads/main`,
    },
  });
  assert.throws(() => buildKitRegistryIndex({
    entries,
    releasesByUrl,
    revocations: [],
    generatedAt: '2026-07-24T00:00:00.000Z',
  }), /workflow/i);
});

test('excludes only the matching revoked artifact and falls back to the next version', () => {
  const stable = ['1.0.0', '1.1.0', '2.0.0'].map((version) => entryAtVersion({ version, channel: 'stable' }));
  const preview = entryAtVersion({ version: '2.1.0-preview.2', channel: 'preview' });
  const entries = [...stable, preview];
  const releasesByUrl = new Map(entries.map((candidate) => [candidate.releaseManifestUrl, releaseAtVersion(candidate)]));
  const revocation = {
    id: stable[2].id,
    version: stable[2].version,
    sha256: digest,
    reason: 'known-vulnerability',
    action: 'block-install',
    releaseManifestUrl: stable[2].releaseManifestUrl,
  };
  const index = buildKitRegistryIndex({
    entries,
    releasesByUrl,
    revocations: [revocation],
    generatedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(index.kits[0].channels.stable.version, '1.1.0');
  assert.equal(index.kits[0].channels.preview.version, '2.1.0-preview.2');

  const allStableRevocations = stable.map((candidate) => ({ ...revocation, version: candidate.version, releaseManifestUrl: candidate.releaseManifestUrl }));
  const withoutStable = buildKitRegistryIndex({
    entries,
    releasesByUrl,
    revocations: allStableRevocations,
    generatedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(withoutStable.kits[0].channels.stable, undefined);
  assert.equal(withoutStable.kits[0].channels.preview.version, '2.1.0-preview.2');
});

test('rejects duplicate entry tuples, source Tags, and Release manifest URLs', () => {
  const stable = entryAtVersion({ version: '1.0.0', channel: 'stable' });
  const duplicateTuple = { ...stable };
  for (const entries of [
    [stable, duplicateTuple],
    [stable, { ...stable, source: { ...stable.source } }],
    [stable, { ...stable, releaseManifestUrl: stable.releaseManifestUrl }],
  ]) {
    assert.throws(() => buildKitRegistryIndex({
      entries,
      releasesByUrl: new Map(entries.map((candidate) => [candidate.releaseManifestUrl, releaseAtVersion(candidate)])),
      revocations: [],
      generatedAt: '2026-07-24T00:00:00.000Z',
    }), /duplicate/i);
  }
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

test('discovers trusted Releases and supplements only missing revocation evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-registry-'));
  const stable = entry('stable', { summary: 'MySQL 数据库连接、浏览、编辑、关系图与 SQL 工作台' });
  const revoked = entryAtVersion({ version: '1.1.0', channel: 'stable' });
  const revocationsFile = path.join(root, 'revocations.json');
  await writeFile(revocationsFile, JSON.stringify({
    schemaVersion: 1,
    revocations: [{
      id: revoked.id,
      version: revoked.version,
      sha256: digest,
      reason: 'known-vulnerability',
      action: 'deactivate',
      releaseManifestUrl: revoked.releaseManifestUrl,
    }],
  }));
  try {
    const requests = [];
    const index = await aggregateKitRegistry({
      repositoryRoot: root,
      repository,
      policyFile: path.join(repositoryRoot, 'registry/policy.json'),
      revocationsFile,
      generatedAt: '2026-07-23T12:00:00.000Z',
      githubToken: 'token',
      provenanceVerifier: { verify: async (expected) => ({ ...expected, verified: true }) },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        const request = new URL(url);
        if (request.pathname.endsWith('/releases')) {
          return new Response(JSON.stringify([{
            draft: false,
            immutable: true,
            prerelease: false,
            tag_name: stable.source.tag,
            target_commitish: commit,
            assets: [
              { name: 'release.json', browser_download_url: stable.releaseManifestUrl.replace(encodeURIComponent(stable.source.tag), stable.source.tag) },
              { name: 'registry-entry.json', browser_download_url: stable.releaseManifestUrl.replace('release.json', 'registry-entry.json').replace(encodeURIComponent(stable.source.tag), stable.source.tag) },
              { name: release('stable').assets[0].name, digest: `sha256:${digest}`, browser_download_url: release('stable').assets[0].url.replace(encodeURIComponent(stable.source.tag), stable.source.tag) },
            ],
          }]));
        }
        if (request.pathname.includes('/git/ref/tags/')) {
          return new Response(JSON.stringify({
            ref: `refs/tags/${stable.source.tag}`,
            url: `https://api.github.com/repos/${repository}/git/refs/tags/${stable.source.tag}`,
            object: { type: 'commit', sha: commit, url: `https://api.github.com/repos/${repository}/git/commits/${commit}` },
          }));
        }
        if (url === stable.releaseManifestUrl.replace(encodeURIComponent(stable.source.tag), stable.source.tag)) {
          return new Response(JSON.stringify(release('stable')));
        }
        if (url.endsWith('/registry-entry.json')) return new Response(JSON.stringify(stable));
        if (url === revoked.releaseManifestUrl) return new Response(JSON.stringify(releaseAtVersion(revoked)));
        return new Response('not found', { status: 404 });
      },
    });
    assert.equal(index.kits.length, 1);
    assert.equal(index.revocations.length, 1);
    assert.equal(index.kits[0].channels.stable.version, stable.version);
    assert.equal(requests.some(({ url }) => url === revoked.releaseManifestUrl), true);
    assert.equal(requests.every(({ init }) => init.headers.Authorization === 'Bearer token' || init.headers.Authorization === undefined), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires Release evidence for every candidate before it can be selected', () => {
  const stable = entry('stable');
  assert.throws(() => buildKitRegistryIndex({
    entries: [stable],
    releasesByUrl: new Map(),
    revocations: [],
    generatedAt: '2026-07-23T12:00:00.000Z',
  }), /missing/i);
});
