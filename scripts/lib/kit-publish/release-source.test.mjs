import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverTrustedKitReleases } from './release-source.mjs';
import { buildKitRegistryIndex } from './registry.mjs';

const repository = 'itharbors/harbors';
const API_ORIGIN = 'https://api.github.com';
const repositoryId = '123456';
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

function browserAssetUrl(tag, name) {
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
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
    immutable: true,
    prerelease: value.release.channel === 'preview',
    tag_name: value.tag,
    target_commitish: commit,
    assets: [
      { name: 'release.json', browser_download_url: browserAssetUrl(value.tag, 'release.json') },
      { name: 'registry-entry.json', browser_download_url: browserAssetUrl(value.tag, 'registry-entry.json') },
      {
        name: value.artifactName,
        digest: `sha256:${digest}`,
        browser_download_url: browserAssetUrl(value.tag, value.artifactName),
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

function releaseFetch({ pages, metadata = new Map(), refs = new Map(), calls = [], responseFor }) {
  return async (url, options = {}) => {
    const requestUrl = new URL(url);
    calls.push({ url: requestUrl.toString(), options });
    if (responseFor) {
      const response = await responseFor(requestUrl, options);
      if (response) return response;
    }
    if (requestUrl.origin === 'https://api.github.com') {
      if (requestUrl.pathname.includes('/git/ref/tags/')) {
        const tag = decodeURIComponent(requestUrl.pathname.slice(requestUrl.pathname.indexOf('/git/ref/tags/') + 14));
        return json(refs.get(requestUrl.pathname) ?? {
          ref: `refs/tags/${tag}`,
          url: `${API_ORIGIN}/repos/${repository}/git/refs/tags/${tag}`,
          object: {
            type: 'commit',
            sha: commit,
            url: `${API_ORIGIN}/repos/${repository}/git/commits/${commit}`,
          },
        });
      }
      if (requestUrl.pathname.includes('/git/tags/')) {
        const sha = requestUrl.pathname.slice(requestUrl.pathname.lastIndexOf('/') + 1);
        return json(refs.get(requestUrl.pathname) ?? {
          sha,
          url: `${API_ORIGIN}/repos/${repository}/git/tags/${sha}`,
          object: {
            type: 'commit',
            sha: commit,
            url: `${API_ORIGIN}/repos/${repository}/git/commits/${commit}`,
          },
        });
      }
      const page = pages.get(requestUrl.searchParams.get('page')) ?? [];
      return Array.isArray(page) ? json(page) : json(page.body, { headers: page.headers });
    }
    if (!metadata.has(requestUrl.toString())) return new Response('not found', { status: 404 });
    return json(metadata.get(requestUrl.toString()));
  };
}

function verifier({ fail = false, calls = [], claims } = {}) {
  return {
    verify: async (expected) => {
      calls.push(expected);
      if (fail) throw new Error('attestation failed');
      return claims ? claims(expected) : { ...expected, verified: true };
    },
  };
}

function metadataFor(value) {
  return new Map([
    [browserAssetUrl(value.tag, 'release.json'), value.release],
    [browserAssetUrl(value.tag, 'registry-entry.json'), value.entry],
  ]);
}

async function discover({ pages, metadata, refs, calls, verifierOptions, responseFor, requestTimeoutMs } = {}) {
  return discoverTrustedKitReleases({
    policy,
    repository,
    githubToken: 'token',
    fetchImpl: releaseFetch({ pages, metadata, refs, calls, responseFor }),
    provenanceVerifier: verifier(verifierOptions),
    requestTimeoutMs,
  });
}

test('lists 100-Release pages through the first short page with GitHub authentication and API version', async () => {
  const value = values();
  const calls = [];
  const result = await discover({
    pages: new Map([
      ['1', {
        body: [releaseRecord(value), ...Array.from({ length: 99 }, () => ({ draft: true }))],
        headers: {
          link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=2>; rel=\"next\"`,
        },
      }],
      ['2', []],
    ]),
    metadata: metadataFor(value),
    calls,
  });

  assert.equal(result.entries.length, 1);
  const apiCalls = calls.filter((call) => new URL(call.url).pathname.endsWith('/releases'));
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

test('resolves the exact lightweight Tag ref instead of target_commitish', async () => {
  const value = values();
  const calls = [];
  await discover({
    pages: new Map([['1', [releaseRecord(value, { target_commitish: 'main' })]]]),
    metadata: metadataFor(value),
    calls,
  });
  const ref = calls.find((call) => new URL(call.url).pathname.includes('/git/ref/tags/'));
  assert.equal(new URL(ref.url).pathname, `/repos/${repository}/git/ref/tags/${encodeURIComponent(value.tag)}`);
  assert.equal(ref.options.headers.Authorization, 'Bearer token');
  assert.equal(ref.options.headers.Accept, 'application/vnd.github+json');
  assert.equal(ref.options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.ok(ref.options.signal instanceof AbortSignal);
});

test('peels annotated Tags and rejects missing, malformed, cyclic, type-drift, and wrong Tag commits', async () => {
  const value = values();
  const refPath = `/repos/${repository}/git/ref/tags/${encodeURIComponent(value.tag)}`;
  const tagPath = `/repos/${repository}/git/tags/${'b'.repeat(40)}`;
  await assert.doesNotReject(discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    refs: new Map([
      [refPath, {
        ref: `refs/tags/${value.tag}`,
        url: `${API_ORIGIN}/repos/${repository}/git/refs/tags/${value.tag}`,
        object: { type: 'tag', sha: 'b'.repeat(40), url: `${API_ORIGIN}/repos/${repository}/git/tags/${'b'.repeat(40)}` },
      }],
      [tagPath, {
        sha: 'b'.repeat(40),
        url: `${API_ORIGIN}/repos/${repository}/git/tags/${'b'.repeat(40)}`,
        object: { type: 'commit', sha: commit, url: `${API_ORIGIN}/repos/${repository}/git/commits/${commit}` },
      }],
    ]),
  }));
  for (const refs of [
    new Map([[refPath, { object: { type: 'blob', sha: commit } }]]),
    new Map([[refPath, { object: { type: 'tag', sha: 'b'.repeat(40) } }], [tagPath, { object: { type: 'tag', sha: 'b'.repeat(40) } }]]),
    new Map([[refPath, { object: { type: 'commit', sha: 'c'.repeat(40) } }]]),
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [releaseRecord(value)]]]),
      metadata: metadataFor(value),
      refs,
    }), /tag|commit/i);
  }
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    responseFor: (url) => (url.pathname === refPath ? new Response('missing', { status: 404 }) : undefined),
  }), /GitHub.*failed|tag/i);
});

test('follows only canonical Link pagination and permits exactly 1,000 Releases', async () => {
  const pages = new Map();
  for (let page = 1; page <= 10; page += 1) {
    pages.set(String(page), {
      body: Array.from({ length: 100 }, () => ({ draft: true })),
      headers: page === 10 ? {} : {
        link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=${page + 1}>; rel=\"next\"`,
      },
    });
  }
  await assert.doesNotReject(discover({ pages, metadata: new Map() }));
  for (const firstPage of [
    { body: Array.from({ length: 101 }, () => ({ draft: true })), headers: {} },
    { body: [{ draft: true }], headers: { link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=2>; rel=\"next\"` } },
    { body: Array.from({ length: 100 }, () => ({ draft: true })), headers: { link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=99&page=2>; rel=\"next\"` } },
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', firstPage]]),
      metadata: new Map(),
    }), /array|page|Link|limit/i);
  }
  pages.set('10', {
    body: Array.from({ length: 100 }, () => ({ draft: true })),
    headers: { link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=11>; rel=\"next\"` },
  });
  await assert.rejects(discover({ pages, metadata: new Map() }), /limit/i);
});

test('accepts terminal GitHub Link headers that contain only first and previous relations', async () => {
  await assert.doesNotReject(discover({
    pages: new Map([
      ['1', {
        body: Array.from({ length: 100 }, () => ({ draft: true })),
        headers: { link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=2>; rel=\"next\"` },
      }],
      ['2', {
        body: [],
        headers: {
          link: `<https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=1>; rel=\"first\", <https://api.github.com/repositories/${repositoryId}/releases?per_page=100&page=1>; rel=\"prev\"`,
        },
      }],
    ]),
    metadata: new Map(),
  }));
  await assert.rejects(discover({
    pages: new Map([['1', {
      body: [],
      headers: { link: '<https://example.test/releases?per_page=100&page=1>; rel="prev"' },
    }]]),
    metadata: new Map(),
  }), /Link|trusted/i);
});

test('requires policy display identity and rejects duplicate trusted Release identities', async () => {
  const value = values();
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: new Map([
      [browserAssetUrl(value.tag, 'release.json'), value.release],
      [browserAssetUrl(value.tag, 'registry-entry.json'), { ...value.entry, label: 'Drift' }],
    ]),
  }), /policy|identity/i);
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value), releaseRecord(value)]]]),
    metadata: metadataFor(value),
  }), /duplicate/i);
  const preview = values({ version: '1.3.0-preview.1', channel: 'preview' });
  assert.equal((await discover({
    pages: new Map([['1', [releaseRecord(value), releaseRecord(preview)]]]),
    metadata: new Map([...metadataFor(value), ...metadataFor(preview)]),
  })).entries.length, 2);
});

test('returns deep-frozen entries and a read-only Map that remains usable by the projector', async () => {
  const value = values();
  const result = await discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
  });
  const release = result.releasesByUrl.get(value.entry.releaseManifestUrl);
  assert.equal(result.releasesByUrl instanceof Map, true);
  assert.equal(Object.isFrozen(result.entries[0]), true);
  assert.equal(Object.isFrozen(release.assets[0].manifest), true);
  assert.throws(() => { result.entries[0].source.tag = 'kit/mysql/v9.9.9'; }, TypeError);
  assert.throws(() => result.releasesByUrl.set('x', release), TypeError);
  assert.throws(() => result.releasesByUrl.delete(value.entry.releaseManifestUrl), TypeError);
  assert.throws(() => result.releasesByUrl.clear(), TypeError);
  result.releasesByUrl.forEach((candidate, url, facade) => {
    assert.equal(facade, result.releasesByUrl);
    assert.equal(candidate, release);
    assert.equal(url, value.entry.releaseManifestUrl);
    assert.throws(() => facade.clear(), TypeError);
  });
  assert.equal(result.releasesByUrl.size, 1);
  assert.throws(() => { result.releasesByUrl.extra = true; }, TypeError);
  assert.throws(() => Object.defineProperty(result.releasesByUrl, 'extra', { value: true }), TypeError);
  assert.throws(() => Object.setPrototypeOf(result.releasesByUrl, null), TypeError);
  assert.throws(() => Object.preventExtensions(result.releasesByUrl), TypeError);
  assert.throws(() => Map.prototype.set.call(result.releasesByUrl, 'x', release), TypeError);
  assert.throws(() => Map.prototype.delete.call(result.releasesByUrl, value.entry.releaseManifestUrl), TypeError);
  assert.throws(() => Map.prototype.clear.call(result.releasesByUrl), TypeError);
  assert.deepEqual([...result.releasesByUrl.keys()], [value.entry.releaseManifestUrl]);
  assert.deepEqual([...result.releasesByUrl.values()], [release]);
  assert.deepEqual([...result.releasesByUrl.entries()], [[value.entry.releaseManifestUrl, release]]);
  assert.deepEqual([...result.releasesByUrl], [[value.entry.releaseManifestUrl, release]]);
  assert.equal(buildKitRegistryIndex({
    entries: result.entries,
    releasesByUrl: result.releasesByUrl,
    revocations: [],
    generatedAt: '2026-07-24T00:00:00.000Z',
  }).kits.length, 1);
});

test('times out stalled response bodies from fetch start and cancels their streams', async () => {
  let cancelled = false;
  const stalled = new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        try {
          controller.enqueue(new TextEncoder().encode('[]'));
          controller.close();
        } catch {
          // The timeout cancellation closes this test stream first.
        }
      }, 50);
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(discover({
    pages: new Map(),
    metadata: new Map(),
    requestTimeoutMs: 5,
    responseFor: (url) => (url.pathname.endsWith('/releases') ? stalled : undefined),
  }), /timed out|aborted/i);
  assert.equal(cancelled, true);
  await assert.rejects(discover({ pages: new Map(), metadata: new Map(), requestTimeoutMs: 0 }), /timeout/i);
  await assert.rejects(discover({ pages: new Map(), metadata: new Map(), requestTimeoutMs: 15_001 }), /timeout/i);
});

test('requires exact canonical Git ref and annotated Tag evidence URLs', async () => {
  const value = values();
  const refPath = `/repos/${repository}/git/ref/tags/${encodeURIComponent(value.tag)}`;
  const tagSha = 'b'.repeat(40);
  const tagPath = `/repos/${repository}/git/tags/${tagSha}`;
  const goodRef = {
    ref: `refs/tags/${value.tag}`,
    url: `${API_ORIGIN}/repos/${repository}/git/refs/tags/${value.tag}`,
    object: { type: 'tag', sha: tagSha, url: `${API_ORIGIN}/repos/${repository}/git/tags/${tagSha}` },
  };
  const goodTag = {
    sha: tagSha,
    url: `${API_ORIGIN}/repos/${repository}/git/tags/${tagSha}`,
    object: { type: 'commit', sha: commit, url: `${API_ORIGIN}/repos/${repository}/git/commits/${commit}` },
  };
  await assert.doesNotReject(discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    refs: new Map([[refPath, goodRef], [tagPath, goodTag]]),
  }));
  for (const ref of [
    { ...goodRef, ref: 'refs/tags/other' },
    { ...goodRef, url: 'https://api.github.com/repos/other/repo/git/refs/tags/kit/mysql/v1.2.3' },
    { ...goodRef, object: { ...goodRef.object, url: `${API_ORIGIN}/repos/${repository}/git/commits/${tagSha}` } },
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [releaseRecord(value)]]]),
      metadata: metadataFor(value),
      refs: new Map([[refPath, ref], [tagPath, goodTag]]),
    }), /Tag|ref|URL|object/i);
  }
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    refs: new Map([[refPath, goodRef], [tagPath, { ...goodTag, sha: 'c'.repeat(40) }]]),
  }), /Tag|object|URL/i);
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    refs: new Map([[refPath, goodRef], [tagPath, {
      ...goodTag,
      object: { type: 'tag', sha: tagSha, url: `${API_ORIGIN}/repos/${repository}/git/tags/${tagSha}` },
    }]]),
  }), /cycle/i);
  const peelShas = Array.from({ length: 6 }, (_, index) => `${index}`.repeat(40));
  const deepRefs = new Map([[
    refPath,
    { ...goodRef, object: { type: 'tag', sha: peelShas[0], url: `${API_ORIGIN}/repos/${repository}/git/tags/${peelShas[0]}` } },
  ]]);
  for (let index = 0; index < peelShas.length; index += 1) {
    deepRefs.set(`/repos/${repository}/git/tags/${peelShas[index]}`, {
      sha: peelShas[index],
      url: `${API_ORIGIN}/repos/${repository}/git/tags/${peelShas[index]}`,
      object: {
        type: 'tag',
        sha: peelShas[(index + 1) % peelShas.length],
        url: `${API_ORIGIN}/repos/${repository}/git/tags/${peelShas[(index + 1) % peelShas.length]}`,
      },
    });
  }
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value)]]]), metadata: metadataFor(value), refs: deepRefs,
  }), /peel limit/i);
});

test('rejects every attestation result drift including attestation URL and keeps timeout signals bounded', async () => {
  const value = values();
  for (const mutate of [
    (expected) => ({ ...expected, verified: false }),
    (expected) => ({ ...expected, attestationUrl: 'https://api.github.com/other' }),
    (expected) => ({ ...expected, subjectName: 'other.hkit' }),
    (expected) => ({ ...expected, subjectSha256: 'b'.repeat(64) }),
    (expected) => ({ ...expected, repository: 'itharbors/other' }),
    (expected) => ({ ...expected, commit: 'b'.repeat(40) }),
    (expected) => ({ ...expected, workflow: 'itharbors/harbors/.github/workflows/other.yml@refs/tags/v1' }),
    (expected) => ({ ...expected, signerWorkflow: 'itharbors/harbors/.github/workflows/other.yml@refs/tags/v1' }),
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [releaseRecord(value)]]]),
      metadata: metadataFor(value),
      verifierOptions: { claims: mutate },
    }), /attestation/i);
  }
});

test('requires immutable Releases and exact raw GitHub browser download URLs', async () => {
  const value = values();
  const missingImmutable = releaseRecord(value);
  delete missingImmutable.immutable;
  for (const record of [
    releaseRecord(value, { immutable: false }),
    missingImmutable,
    releaseRecord(value, { assets: releaseRecord(value).assets.map((asset) => (
      asset.name === 'release.json' ? { ...asset, browser_download_url: assetUrl(value.tag, asset.name) } : asset
    )) }),
    releaseRecord(value, { assets: releaseRecord(value).assets.map((asset) => (
      asset.name === 'release.json' ? { ...asset, browser_download_url: `${browserAssetUrl(value.tag, asset.name)}?drift=1` } : asset
    )) }),
    releaseRecord(value, { assets: releaseRecord(value).assets.map((asset) => (
      asset.name === 'release.json' ? { ...asset, browser_download_url: `https://github.com:444/${repository}/releases/download/${value.tag}/${asset.name}` } : asset
    )) }),
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [record]]]), metadata: metadataFor(value),
    }), /immutable|browser download|URL/i);
  }
  await assert.doesNotReject(discover({
    pages: new Map([['1', [releaseRecord(value, { immutable: true })]]]), metadata: metadataFor(value),
  }));
});

test('rejects unsafe responses, malformed assets, and over-limit bodies while cancelling unusable bodies', async () => {
  const value = values();
  for (const record of [
    releaseRecord(value, { assets: [...releaseRecord(value).assets, releaseRecord(value).assets[0]] }),
    releaseRecord(value, { assets: {} }),
    releaseRecord(value, { assets: releaseRecord(value).assets.map((asset) => (
      asset.name === 'release.json' ? { ...asset, browser_download_url: `http://github.com/${repository}/release.json` } : asset
    )) }),
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [record]]]), metadata: metadataFor(value),
    }), /array|duplicate|URL/i);
  }
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('[]')); },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'content-length': String(1024 * 1024 + 1) } });
  await assert.rejects(discover({
    pages: new Map(), metadata: new Map(), responseFor: (url) => (
      url.pathname.endsWith('/releases') ? oversized : undefined
    ),
  }), /size/i);
  assert.equal(cancelled, true);
  await assert.rejects(discover({
    pages: new Map(), metadata: new Map(), responseFor: (url) => (
      url.pathname.endsWith('/releases') ? new Response('not json', { status: 200 }) : undefined
    ),
  }), /JSON/i);
});

test('allows the canonical GitHub-to-CDN redirect chain without leaking Authorization', async () => {
  const value = values();
  const calls = [];
  await discover({
    pages: new Map([['1', [releaseRecord(value)]]]),
    metadata: metadataFor(value),
    calls,
    responseFor: (url) => {
      if (url.href === browserAssetUrl(value.tag, 'registry-entry.json')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/registry-entry.json' },
        });
      }
      if (url.href === 'https://release-assets.githubusercontent.com/registry-entry.json') return json(value.entry);
      return undefined;
    },
  });
  const cdn = calls.find((call) => call.url === 'https://release-assets.githubusercontent.com/registry-entry.json');
  assert.equal(cdn.options.headers.Authorization, undefined);
  assert.ok(cdn.options.signal instanceof AbortSignal);
});

test('rejects API and asset failures plus deceptive streamed and reader-error bodies', async () => {
  const value = values();
  await assert.rejects(discover({
    pages: new Map(), metadata: new Map(), responseFor: (url) => (
      url.pathname.endsWith('/releases') ? new Response('no', { status: 503 }) : undefined
    ),
  }), /HTTP 503/i);
  await assert.rejects(discover({
    pages: new Map([['1', [releaseRecord(value)]]]), metadata: metadataFor(value),
    responseFor: (url) => (
      url.href === browserAssetUrl(value.tag, 'registry-entry.json') ? new Response('no', { status: 404 }) : undefined
    ),
  }), /HTTP 404/i);
  await assert.rejects(discover({
    pages: new Map(), metadata: new Map(), responseFor: (url) => (
      url.pathname.endsWith('/releases') ? new Response(`[${' '.repeat(1024 * 1024 + 1)}]`) : undefined
    ),
  }), /size/i);
  await assert.rejects(discover({
    pages: new Map(), metadata: new Map(), responseFor: (url) => (
      url.pathname.endsWith('/releases') ? new Response(new ReadableStream({
        start(controller) { controller.error(new Error('reader failed')); },
      })) : undefined
    ),
  }), /reader failed/i);
});

test('rejects unsafe redirects and never restores Authorization after leaving github.com', async () => {
  const value = values();
  for (const location of [
    'http://release-assets.githubusercontent.com/entry.json',
    'https://example.test/entry.json',
    'https://token@release-assets.githubusercontent.com/entry.json',
    'https://release-assets.githubusercontent.com:444/entry.json',
    'https://release-assets.githubusercontent.com/entry.json#fragment',
    `https://github.com/${repository}/releases/download/${encodeURIComponent(value.tag)}/registry-entry.json?drift=1`,
  ]) {
    await assert.rejects(discover({
      pages: new Map([['1', [releaseRecord(value)]]]), metadata: metadataFor(value),
      responseFor: (url) => (
        url.href === browserAssetUrl(value.tag, 'registry-entry.json') ? new Response(null, {
          status: 302, headers: { location },
        }) : undefined
      ),
    }), /redirect|trusted HTTPS/i);
  }
  const calls = [];
  const returnUrl = browserAssetUrl(value.tag, 'registry-entry.json');
  await discover({
    pages: new Map([['1', [releaseRecord(value)]]]), metadata: metadataFor(value), calls,
    responseFor: (url) => {
      if (url.href === returnUrl && calls.filter((call) => call.url === returnUrl).length === 1) return new Response(null, {
        status: 302, headers: { location: 'https://release-assets.githubusercontent.com/entry.json' },
      });
      if (url.href === 'https://release-assets.githubusercontent.com/entry.json') return new Response(null, {
        status: 302, headers: { location: returnUrl },
      });
      if (url.href === returnUrl) return json(value.entry);
      return undefined;
    },
  });
  const returned = calls.filter((call) => call.url === returnUrl).at(-1);
  assert.equal(returned.options.headers.Authorization, undefined);
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
      { name: 'another.hkit', browser_download_url: browserAssetUrl(value.tag, 'another.hkit') },
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
    browserAssetUrl(value.tag, 'registry-entry.json'),
    browserAssetUrl(value.tag, 'release.json'),
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
      [browserAssetUrl(mismatched.tag, 'release.json'), mismatched.release],
      [browserAssetUrl(mismatched.tag, 'registry-entry.json'), entryWithWrongTag],
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
