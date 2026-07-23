import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverTrustedKitReleases } from './release-source.mjs';

const repository = 'itharbors/harbors';
const commit = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2';

const policy = Object.freeze({
  repository,
  signerWorkflows: [signerWorkflow],
  kits: {
    mysql: { id: '@itharbors/kit-mysql', label: 'MySQL', summary: 'MySQL database workbench' },
    notifications: { id: '@itharbors/kit-notifications', label: 'Notifications', summary: 'Notification kit' },
    sqlite: { id: '@itharbors/kit-sqlite', label: 'SQLite', summary: 'SQLite database workbench' },
  },
});

function assetUrl(tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function values({ version = '1.2.3', channel = 'stable', overrides = {} } = {}) {
  const tag = `kit/mysql/v${version}`;
  const artifactName = `kit-mysql-${version}-any-any.hkit`;
  const manifest = {
    schemaVersion: 1,
    id: '@itharbors/kit-mysql',
    version,
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
  const entry = {
    schemaVersion: 1,
    id: manifest.id,
    label: 'MySQL',
    publisher: 'itharbors',
    summary: 'MySQL database workbench',
    channel,
    version,
    releaseManifestUrl: assetUrl(tag, 'release.json'),
    permissions: ['network'],
    source: { repository, tag },
  };
  const release = {
    schemaVersion: 1,
    id: manifest.id,
    version,
    channel,
    publisher: 'itharbors',
    source: {
      repository,
      commit,
      workflow: `${repository}/.github/workflows/publish-kit.yml@refs/tags/${tag}`,
      signerWorkflow,
      attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${digest}`,
    },
    assets: [{
      name: artifactName,
      url: assetUrl(tag, artifactName),
      sha256: digest,
      size: 3179,
      manifest,
    }],
  };
  return {
    tag,
    artifactName,
    entry: { ...entry, ...overrides.entry },
    release: { ...release, ...overrides.release },
  };
}

function releaseRecord(value, overrides = {}) {
  return {
    draft: false,
    prerelease: value.release.channel === 'preview',
    tag_name: value.tag,
    target_commitish: commit,
    assets: [
      { name: 'release.json', browser_download_url: assetUrl(value.tag, 'release.json') },
      { name: 'registry-entry.json', browser_download_url: assetUrl(value.tag, 'registry-entry.json') },
      {
        name: value.artifactName,
        digest: `sha256:${digest}`,
        browser_download_url: assetUrl(value.tag, value.artifactName),
      },
    ],
    ...overrides,
  };
}

function json(value, { headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function releaseFetch({ pages, metadata = new Map(), calls = [] }) {
  return async (url, options = {}) => {
    const requestUrl = new URL(url);
    calls.push({ url: requestUrl.toString(), options });
    if (requestUrl.origin === 'https://api.github.com') {
      return json(pages.get(requestUrl.searchParams.get('page')) ?? []);
    }
    if (!metadata.has(requestUrl.toString())) return new Response('not found', { status: 404 });
    return json(metadata.get(requestUrl.toString()));
  };
}

function verifier({ fail = false, calls = [] } = {}) {
  return {
    verify: async (expected) => {
      calls.push(expected);
      if (fail) throw new Error('attestation failed');
      return { ...expected, verified: true };
    },
  };
}

function metadataFor(value) {
  return new Map([
    [assetUrl(value.tag, 'release.json'), value.release],
    [assetUrl(value.tag, 'registry-entry.json'), value.entry],
  ]);
}

async function discover({ pages, metadata, calls, verifierOptions } = {}) {
  return discoverTrustedKitReleases({
    policy,
    repository,
    githubToken: 'token',
    fetchImpl: releaseFetch({ pages, metadata, calls }),
    provenanceVerifier: verifier(verifierOptions),
  });
}

test('lists 100-Release pages through the first short page with GitHub authentication and API version', async () => {
  const value = values();
  const calls = [];
  const result = await discover({
    pages: new Map([
      ['1', [releaseRecord(value), ...Array.from({ length: 99 }, () => ({ draft: true }))]],
      ['2', []],
    ]),
    metadata: metadataFor(value),
    calls,
  });

  assert.equal(result.entries.length, 1);
  const apiCalls = calls.filter((call) => call.url.startsWith('https://api.github.com/'));
  assert.deepEqual(apiCalls.map((call) => call.url), [
    `https://api.github.com/repos/${repository}/releases?per_page=100&page=1`,
    `https://api.github.com/repos/${repository}/releases?per_page=100&page=2`,
  ]);
  for (const { options } of apiCalls) {
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
  }
});

test('ignores drafts, unrelated Tags, and unknown Kit slugs', async () => {
  const value = values();
  const result = await discover({
    pages: new Map([['1', [
      { draft: true, tag_name: value.tag, assets: [] },
      { draft: false, tag_name: 'v1.2.3', assets: [] },
      { draft: false, tag_name: 'kit/unknown/v1.2.3', assets: [] },
      releaseRecord(value),
    ]]]),
    metadata: metadataFor(value),
  });
  assert.deepEqual(result.entries.map((entry) => entry.id), ['@itharbors/kit-mysql']);
});

test('rejects a trusted Release missing metadata or containing a non-unique Kit archive', async () => {
  const value = values();
  for (const record of [
    releaseRecord(value, { assets: releaseRecord(value).assets.filter((asset) => asset.name !== 'release.json') }),
    releaseRecord(value, { assets: [
      ...releaseRecord(value).assets,
      { name: 'another.hkit', browser_download_url: assetUrl(value.tag, 'another.hkit') },
    ] }),
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [record]]]),
      metadata: metadataFor(value),
    }), /incomplete|exactly one/i);
  }
});

test('downloads named metadata assets from browser URLs as octet streams', async () => {
  const value = values();
  const calls = [];
  await discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    calls,
  });
  const metadataCalls = calls.filter((call) => call.url.startsWith('https://github.com/'));
  assert.deepEqual(metadataCalls.map((call) => call.url).sort(), [
    assetUrl(value.tag, 'registry-entry.json'),
    assetUrl(value.tag, 'release.json'),
  ].sort());
  for (const { options } of metadataCalls) {
    assert.equal(options.headers.Accept, 'application/octet-stream');
    assert.equal(options.headers.Authorization, 'Bearer token');
  }
});

test('attests a Release only when GitHub, entry, manifest, and archive metadata agree', async () => {
  const value = values();
  const verified = [];
  const result = await discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    verifierOptions: { calls: verified },
  });
  assert.equal(result.releasesByUrl.get(value.entry.releaseManifestUrl).version, '1.2.3');
  assert.deepEqual(verified, [{
    repository,
    subjectName: 'kit-mysql-1.2.3-any-any.hkit',
    subjectSha256: digest,
    commit,
    workflow: `${repository}/.github/workflows/publish-kit.yml@refs/tags/kit/mysql/v1.2.3`,
    signerWorkflow,
    attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${digest}`,
  }]);
});

test('rejects the complete aggregation for metadata drift and failed attestations', async () => {
  const valid = values();
  const mismatched = values({ version: '1.2.4' });
  const entryWithWrongTag = {
    ...mismatched.entry,
    source: { repository, tag: valid.tag },
  };
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(valid), releaseRecord(mismatched)]]]),
    metadata: new Map([
      ...metadataFor(valid),
      [assetUrl(mismatched.tag, 'release.json'), mismatched.release],
      [assetUrl(mismatched.tag, 'registry-entry.json'), entryWithWrongTag],
    ]),
  }), /tag/i);
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(valid)]]]),
    metadata: metadataFor(valid),
    verifierOptions: { fail: true },
  }), /attestation verification failed/i);
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(valid, {
      assets: releaseRecord(valid).assets.map((asset) => (
        asset.name === valid.artifactName ? { ...asset, digest: `sha256:${'b'.repeat(64)}` } : asset
      )),
    })]]]),
    metadata: metadataFor(valid),
  }), /asset/i);
});
