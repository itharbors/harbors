import {
  parseRegistryEntry,
  validateRegistryRelease,
} from './registry.mjs';

const RELEASE_TAG = /^kit\/(mysql|notifications|sqlite)\/v(.+)$/u;
const API_VERSION = '2026-03-10';
const MAX_RELEASES = 1000;
const PAGE_SIZE = 100;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const GITHUB_ORIGIN = 'https://github.com';
const SAFE_DOWNLOAD_ORIGINS = new Set([
  GITHUB_ORIGIN,
  'https://github-releases.githubusercontent.com',
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
]);

function releaseDownloadUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function requireHttpsUrl(value, message, allowedOrigins) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || !allowedOrigins.has(url.origin)
  ) throw new Error(message);
  return url;
}

async function readLimitedJson(response, { maxBytes, label }) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`${label} exceeds the size limit`);
    }
  }
  if (!response.body) throw new Error(`${label} body is empty`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds the size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function fetchJson(fetchImpl, url, init, { maxBytes, label }) {
  let current = requireHttpsUrl(url, `${label} URL is not HTTPS`, SAFE_DOWNLOAD_ORIGINS);
  let redirectCount = 0;
  let currentInit = init;
  while (true) {
    const response = await fetchImpl(current.href, { ...currentInit, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error(`${label} redirected too many times`);
      const location = response.headers.get('location');
      if (!location) throw new Error(`${label} redirect is missing a Location header`);
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`${label} redirect URL is invalid`);
      }
      requireHttpsUrl(next.href, `${label} redirect URL is not trusted HTTPS`, SAFE_DOWNLOAD_ORIGINS);
      current = next;
      redirectCount += 1;
      // A GitHub download redirect may contain a signed CDN URL. Never forward the token there.
      if (current.origin !== GITHUB_ORIGIN) {
        const { Authorization: _authorization, ...headers } = currentInit.headers;
        currentInit = { ...currentInit, headers };
      }
      continue;
    }
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
    return readLimitedJson(response, { maxBytes, label });
  }
}

async function listReleases({ repository, githubToken, fetchImpl }) {
  const releases = [];
  for (let page = 1; page <= MAX_RELEASES / PAGE_SIZE; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/releases`);
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
    if (!response.ok) throw new Error(`GitHub Releases API failed with HTTP ${response.status}`);
    const values = await readLimitedJson(response, {
      maxBytes: MAX_METADATA_BYTES,
      label: 'GitHub Releases API response',
    });
    if (!Array.isArray(values)) throw new Error('GitHub Releases API response must be an array');
    releases.push(...values);
    if (values.length < PAGE_SIZE) return releases;
  }
  throw new Error(`GitHub Releases API exceeds the ${MAX_RELEASES} Release limit`);
}

function indexAssets(rawAssets, { repository, tag }) {
  if (!Array.isArray(rawAssets)) throw new Error(`GitHub Release assets must be an array: ${tag}`);
  const assets = new Map();
  for (const rawAsset of rawAssets) {
    const asset = requireObject(rawAsset, `GitHub Release asset is invalid: ${tag}`);
    if (typeof asset.name !== 'string' || asset.name.length === 0) {
      throw new Error(`GitHub Release asset name is invalid: ${tag}`);
    }
    if (typeof asset.browser_download_url !== 'string') {
      throw new Error(`GitHub Release asset URL is invalid: ${tag}`);
    }
    if (assets.has(asset.name)) throw new Error(`GitHub Release contains duplicate asset ${asset.name}`);
    const expectedUrl = releaseDownloadUrl(repository, tag, asset.name);
    if (asset.browser_download_url !== expectedUrl) {
      throw new Error(`GitHub Release asset URL is not the immutable download URL: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  return assets;
}

async function fetchAssetJson(asset, { githubToken, fetchImpl, maxBytes }) {
  return fetchJson(fetchImpl, asset.browser_download_url, {
    method: 'GET',
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${githubToken}`,
    },
  }, { maxBytes, label: `GitHub Release asset ${asset.name}` });
}

function assertVerifiedClaims(claims, expected) {
  if (
    claims?.verified !== true
    || claims.subjectName !== expected.subjectName
    || claims.subjectSha256 !== expected.subjectSha256
    || claims.repository !== expected.repository
    || claims.commit !== expected.commit
    || claims.workflow !== expected.workflow
    || claims.signerWorkflow !== expected.signerWorkflow
  ) throw new Error('Artifact attestation does not match the trusted Release asset');
}

export async function discoverTrustedKitReleases({
  policy,
  repository,
  githubToken,
  fetchImpl = globalThis.fetch,
  provenanceVerifier,
}) {
  if (!policy || repository !== policy.repository) throw new Error('Release repository is not trusted');
  if (typeof githubToken !== 'string' || githubToken.length === 0) {
    throw new Error('GitHub token is required');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (!provenanceVerifier || typeof provenanceVerifier.verify !== 'function') {
    throw new TypeError('provenanceVerifier is required');
  }
  const releases = await listReleases({ repository, githubToken, fetchImpl });
  const entries = [];
  const releasesByUrl = new Map();
  for (const rawRecord of releases) {
    const releaseRecord = requireObject(rawRecord, 'GitHub Release record is invalid');
    if (releaseRecord.draft === true) continue;
    if (releaseRecord.draft !== false || typeof releaseRecord.tag_name !== 'string') {
      throw new Error('GitHub Release record is invalid');
    }
    const match = RELEASE_TAG.exec(releaseRecord.tag_name);
    if (!match || !Object.hasOwn(policy.kits, match[1])) continue;
    if (typeof releaseRecord.prerelease !== 'boolean' || typeof releaseRecord.target_commitish !== 'string') {
      throw new Error(`GitHub Release metadata is invalid: ${releaseRecord.tag_name}`);
    }
    const assets = indexAssets(releaseRecord.assets, {
      repository,
      tag: releaseRecord.tag_name,
    });
    if (!assets.has('release.json') || !assets.has('registry-entry.json')) {
      throw new Error(`Trusted Kit Release is incomplete: ${releaseRecord.tag_name}`);
    }
    const hkitAssets = [...assets.values()].filter((asset) => asset.name.endsWith('.hkit'));
    if (hkitAssets.length !== 1) {
      throw new Error(`Trusted Kit Release must contain exactly one .hkit: ${releaseRecord.tag_name}`);
    }
    const entry = parseRegistryEntry(await fetchAssetJson(assets.get('registry-entry.json'), {
      githubToken,
      fetchImpl,
      maxBytes: MAX_METADATA_BYTES,
    }));
    if (entry.source.repository !== repository || entry.source.tag !== releaseRecord.tag_name) {
      throw new Error('Release Tag or repository does not match Registry entry');
    }
    const rawRelease = await fetchAssetJson(assets.get('release.json'), {
      githubToken,
      fetchImpl,
      maxBytes: MAX_METADATA_BYTES,
    });
    const validated = validateRegistryRelease(entry, rawRelease);
    if (!policy.signerWorkflows.includes(validated.source.signerWorkflow)) {
      throw new Error('Release signer workflow is not trusted');
    }
    const expectedPrerelease = validated.channel === 'preview';
    if (
      releaseRecord.prerelease !== expectedPrerelease
      || releaseRecord.target_commitish !== validated.source.commit
    ) throw new Error('GitHub Release channel or target Commit does not match release.json');
    const artifact = validated.assets[0];
    const [hkitAsset] = hkitAssets;
    if (
      artifact.name !== hkitAsset.name
      || hkitAsset.digest !== `sha256:${artifact.sha256}`
      || artifact.url !== hkitAsset.browser_download_url
    ) {
      throw new Error('Release .hkit asset does not match release.json');
    }
    const expected = {
      repository: validated.source.repository,
      subjectName: artifact.name,
      subjectSha256: artifact.sha256,
      commit: validated.source.commit,
      workflow: validated.source.workflow,
      signerWorkflow: validated.source.signerWorkflow,
      attestationUrl: validated.source.attestationUrl,
    };
    let claims;
    try {
      claims = await provenanceVerifier.verify(expected);
    } catch (error) {
      throw new Error('Artifact attestation verification failed', { cause: error });
    }
    assertVerifiedClaims(claims, expected);
    entries.push(entry);
    releasesByUrl.set(entry.releaseManifestUrl, validated);
  }
  return Object.freeze({ entries: Object.freeze(entries), releasesByUrl });
}
