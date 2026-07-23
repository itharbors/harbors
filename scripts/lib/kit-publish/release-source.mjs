import {
  parseRegistryEntry,
  validateRegistryRelease,
} from './registry.mjs';

const RELEASE_TAG = /^kit\/(mysql|notifications|sqlite)\/v(.+)$/u;
const API_VERSION = '2026-03-10';
const API_ORIGIN = 'https://api.github.com';
const GITHUB_ORIGIN = 'https://github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TAG_PEELS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_DOWNLOAD_ORIGINS = new Set([
  GITHUB_ORIGIN,
  'https://github-releases.githubusercontent.com',
  'https://objects.githubusercontent.com',
  'https://release-assets.githubusercontent.com',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function readOnlyMap(entries) {
  const target = new Map(entries);
  let facade;
  facade = new Proxy(target, {
    get(map, property) {
      if (['set', 'delete', 'clear'].includes(property)) {
        return () => { throw new TypeError('Trusted Release map is read-only'); };
      }
      if (property === 'forEach') {
        return (callback, thisArg) => map.forEach((value, key) => callback.call(thisArg, value, key, facade));
      }
      if (property === 'size') return map.size;
      const value = Reflect.get(map, property, map);
      return typeof value === 'function' ? value.bind(map) : value;
    },
    set() { throw new TypeError('Trusted Release map is read-only'); },
    defineProperty() { throw new TypeError('Trusted Release map is read-only'); },
    deleteProperty() { throw new TypeError('Trusted Release map is read-only'); },
    setPrototypeOf() { throw new TypeError('Trusted Release map is read-only'); },
    preventExtensions() { throw new TypeError('Trusted Release map is read-only'); },
  });
  return facade;
}

function releaseDownloadUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function browserDownloadUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

function apiBase(repository) {
  return `${API_ORIGIN}/repos/${repository}`;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function cancelBody(response) {
  return response.body?.cancel().catch(() => undefined);
}

function apiUrl(value, message) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    url.origin !== API_ORIGIN
    || url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.hash !== ''
  ) throw new Error(message);
  return url;
}

function downloadUrl(value, message) {
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
    || url.port !== ''
    || url.hash !== ''
    || !SAFE_DOWNLOAD_ORIGINS.has(url.origin)
  ) throw new Error(message);
  if (url.origin === GITHUB_ORIGIN && url.search !== '') {
    throw new Error(message);
  }
  return url;
}

function timeoutError(label) {
  return new Error(`${label} timed out`);
}

async function readLimitedJson(response, { maxBytes, label, signal }) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelBody(response);
      throw new Error(`${label} exceeds the size limit`);
    }
  }
  if (!response.body) throw new Error(`${label} body is empty`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => reader.cancel().catch(() => undefined);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(timeoutError(label));
    else {
      abortListener = () => {
      void abort();
      reject(timeoutError(label));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw timeoutError(label);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds the size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function request(fetchImpl, url, init, { label, maxBytes, redirects, timeoutMs }) {
  let current = url;
  let requestInit = init;
  let redirectCount = 0;
  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(timeoutError(label)), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current.href, { ...requestInit, signal: controller.signal });
      if (redirects && response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        if (redirectCount >= MAX_REDIRECTS) throw new Error(`${label} redirected too many times`);
        const location = response.headers.get('location');
        if (!location) throw new Error(`${label} redirect is missing a Location header`);
        let next;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error(`${label} redirect URL is invalid`);
        }
        current = downloadUrl(next.href, `${label} redirect URL is not trusted HTTPS`);
        redirectCount += 1;
        // Do not restore Authorization if a CDN ever redirects back to github.com.
        if (current.origin !== GITHUB_ORIGIN) {
          const { Authorization: _authorization, ...headers } = requestInit.headers;
          requestInit = { ...requestInit, headers };
        }
        continue;
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new Error(`${label} failed with HTTP ${response.status}`);
      }
      return { value: await readLimitedJson(response, { maxBytes, label, signal: controller.signal }), response };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function fetchApiJson(fetchImpl, url, githubToken, label, timeoutMs) {
  const current = apiUrl(url, `${label} URL is not trusted`);
  return request(fetchImpl, current, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': API_VERSION,
    },
  }, { label, maxBytes: MAX_METADATA_BYTES, redirects: false, timeoutMs });
}

function listUrl(repository, page) {
  const url = new URL(`${apiBase(repository)}/releases`);
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url;
}

function parseNextLink(header, { repository, page }) {
  if (header === null || header === '') return undefined;
  const humanPath = listUrl(repository, page).pathname;
  const numericRepositoryPath = /^\/repositories\/[1-9][0-9]*\/releases$/u;
  const links = header.split(',').map((item) => {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?([a-z]+)"?\s*$/u.exec(item);
    if (!match) throw new Error('GitHub Releases API Link header is invalid');
    const url = apiUrl(match[1], 'GitHub Releases API Link is not trusted');
    if (
      (url.pathname !== humanPath && !numericRepositoryPath.test(url.pathname))
      || url.searchParams.size !== 2
      || url.searchParams.get('per_page') !== String(PAGE_SIZE)
      || !/^[1-9][0-9]*$/u.test(url.searchParams.get('page') ?? '')
    ) throw new Error('GitHub Releases API Link is not canonical');
    return { url, relation: match[2] };
  });
  const nextLinks = links.filter((link) => link.relation === 'next');
  if (nextLinks.length === 0) return undefined;
  if (nextLinks.length !== 1) throw new Error('GitHub Releases API Link header is invalid');
  const next = nextLinks[0].url;
  const expected = listUrl(repository, page + 1);
  if (
    (next.pathname !== expected.pathname && !numericRepositoryPath.test(next.pathname))
    || next.searchParams.size !== 2
    || next.searchParams.get('per_page') !== String(PAGE_SIZE)
    || next.searchParams.get('page') !== String(page + 1)
  ) throw new Error('GitHub Releases API next Link is not canonical');
  return next;
}

async function listReleases({ repository, githubToken, fetchImpl, timeoutMs }) {
  const releases = [];
  let page = 1;
  let url = listUrl(repository, page);
  while (true) {
    const { value, response } = await fetchApiJson(fetchImpl, url.href, githubToken, 'GitHub Releases API', timeoutMs);
    if (!Array.isArray(value) || value.length > PAGE_SIZE) {
      throw new Error('GitHub Releases API response must be an array of at most 100 Releases');
    }
    releases.push(...value);
    const next = parseNextLink(response.headers.get('link'), { repository, page });
    if (value.length < PAGE_SIZE) {
      if (next) throw new Error('GitHub Releases API short page must not include next Link');
      return releases;
    }
    if (!next) return releases;
    if (page === MAX_PAGES) throw new Error('GitHub Releases API exceeds the 1000 Release limit');
    page += 1;
    // Numeric repository Links prove pagination but are not an identity authority.
    url = listUrl(repository, page);
  }
}

function tagRefUrl(repository, tag) {
  return `${apiBase(repository)}/git/ref/tags/${encodeURIComponent(tag)}`;
}

function tagObjectUrl(repository, sha) {
  return `${apiBase(repository)}/git/tags/${sha}`;
}

function exactApiUrl(value, expected, label) {
  const actual = apiUrl(value, `${label} URL is not trusted`);
  if (actual.href !== new URL(expected).href) throw new Error(`${label} URL is not canonical`);
}

function gitObject(value, { repository, label }) {
  const object = requireObject(value, `${label} object is invalid`);
  if (!['commit', 'tag'].includes(object.type) || typeof object.sha !== 'string' || !SHA_PATTERN.test(object.sha)) {
    throw new Error(`${label} object is invalid`);
  }
  exactApiUrl(
    object.url,
    object.type === 'commit' ? `${apiBase(repository)}/git/commits/${object.sha}` : tagObjectUrl(repository, object.sha),
    `${label} object`,
  );
  return object;
}

function tagRefEvidence(value, { repository, tag }) {
  const input = requireObject(value, 'GitHub Tag ref API response is invalid');
  if (input.ref !== `refs/tags/${tag}`) throw new Error('GitHub Tag ref does not match Release Tag');
  exactApiUrl(input.url, `${apiBase(repository)}/git/refs/tags/${tag}`, 'GitHub Tag ref');
  return gitObject(input.object, { repository, label: 'GitHub Tag ref' });
}

function annotatedTagEvidence(value, { repository, sha }) {
  const input = requireObject(value, 'GitHub Tag object API response is invalid');
  if (input.sha !== sha) throw new Error('GitHub Tag object SHA does not match requested Tag');
  exactApiUrl(input.url, tagObjectUrl(repository, sha), 'GitHub Tag object');
  return gitObject(input.object, { repository, label: 'GitHub Tag object' });
}

async function resolveTagCommit({ repository, tag, githubToken, fetchImpl, timeoutMs }) {
  let object = tagRefEvidence((await fetchApiJson(
    fetchImpl,
    tagRefUrl(repository, tag),
    githubToken,
    'GitHub Tag ref API',
    timeoutMs,
  )).value, { repository, tag });
  const seen = new Set();
  for (let depth = 0; depth <= MAX_TAG_PEELS; depth += 1) {
    if (object.type === 'commit') return object.sha;
    if (seen.has(object.sha)) throw new Error('GitHub Tag object cycle detected');
    seen.add(object.sha);
    if (depth === MAX_TAG_PEELS) throw new Error('GitHub Tag object exceeds peel limit');
    object = annotatedTagEvidence((await fetchApiJson(
      fetchImpl,
      tagObjectUrl(repository, object.sha),
      githubToken,
      'GitHub Tag object API',
      timeoutMs,
    )).value, { repository, sha: object.sha });
  }
  throw new Error('GitHub Tag object is invalid');
}

function assertBrowserDownloadUrl(value, { repository, tag, name }) {
  const url = downloadUrl(value, `GitHub Release asset URL is not trusted: ${name}`);
  const [owner, repo] = repository.split('/');
  const expectedPath = [
    '', owner, repo, 'releases', 'download', ...tag.split('/'), encodeURIComponent(name),
  ].join('/');
  if (url.origin !== GITHUB_ORIGIN || url.pathname !== expectedPath || url.search !== '') {
    throw new Error(`GitHub Release asset URL is not the canonical browser download URL: ${name}`);
  }
  return url;
}

function sameReleaseAssetUrl({ repository, tag, name, immutableUrl, browserUrl }) {
  if (immutableUrl !== releaseDownloadUrl(repository, tag, name)) return false;
  assertBrowserDownloadUrl(browserUrl, { repository, tag, name });
  return true;
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
    assertBrowserDownloadUrl(asset.browser_download_url, { repository, tag, name: asset.name });
    assets.set(asset.name, asset);
  }
  return assets;
}

async function fetchAssetJson(asset, { githubToken, fetchImpl, maxBytes, timeoutMs }) {
  const url = downloadUrl(asset.browser_download_url, `GitHub Release asset ${asset.name} URL is not HTTPS`);
  return (await request(fetchImpl, url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${githubToken}`,
    },
  }, { maxBytes, label: `GitHub Release asset ${asset.name}`, redirects: true, timeoutMs })).value;
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
    || claims.attestationUrl !== expected.attestationUrl
  ) throw new Error('Artifact attestation does not match the trusted Release asset');
}

export async function discoverTrustedKitReleases({
  policy,
  repository,
  githubToken,
  fetchImpl = globalThis.fetch,
  provenanceVerifier,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!policy || repository !== policy.repository) throw new Error('Release repository is not trusted');
  if (typeof githubToken !== 'string' || githubToken.length === 0) throw new Error('GitHub token is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > REQUEST_TIMEOUT_MS) {
    throw new TypeError(`requestTimeoutMs must be a positive integer no greater than ${REQUEST_TIMEOUT_MS}`);
  }
  if (!provenanceVerifier || typeof provenanceVerifier.verify !== 'function') {
    throw new TypeError('provenanceVerifier is required');
  }
  const releases = await listReleases({ repository, githubToken, fetchImpl, timeoutMs: requestTimeoutMs });
  const entries = [];
  const releasesByUrl = [];
  const tags = new Set();
  const releaseUrls = new Set();
  for (const rawRecord of releases) {
    const releaseRecord = requireObject(rawRecord, 'GitHub Release record is invalid');
    if (releaseRecord.draft === true) continue;
    if (releaseRecord.draft !== false || typeof releaseRecord.tag_name !== 'string') {
      throw new Error('GitHub Release record is invalid');
    }
    const match = RELEASE_TAG.exec(releaseRecord.tag_name);
    if (!match || !Object.hasOwn(policy.kits, match[1])) continue;
    if (releaseRecord.immutable !== true) {
      throw new Error(`Trusted GitHub Release must be immutable: ${releaseRecord.tag_name}`);
    }
    if (tags.has(releaseRecord.tag_name)) throw new Error(`Duplicate trusted GitHub Release Tag: ${releaseRecord.tag_name}`);
    tags.add(releaseRecord.tag_name);
    if (typeof releaseRecord.prerelease !== 'boolean' || typeof releaseRecord.target_commitish !== 'string') {
      throw new Error(`GitHub Release metadata is invalid: ${releaseRecord.tag_name}`);
    }
    const assets = indexAssets(releaseRecord.assets, { repository, tag: releaseRecord.tag_name });
    if (!assets.has('release.json') || !assets.has('registry-entry.json')) {
      throw new Error(`Trusted Kit Release is incomplete: ${releaseRecord.tag_name}`);
    }
    const hkitAssets = [...assets.values()].filter((asset) => asset.name.endsWith('.hkit'));
    if (hkitAssets.length !== 1) throw new Error(`Trusted Kit Release must contain exactly one .hkit: ${releaseRecord.tag_name}`);
    const entry = parseRegistryEntry(await fetchAssetJson(assets.get('registry-entry.json'), {
      githubToken, fetchImpl, maxBytes: MAX_METADATA_BYTES, timeoutMs: requestTimeoutMs,
    }));
    const policyKit = policy.kits[match[1]];
    if (
      entry.source.repository !== repository
      || entry.source.tag !== releaseRecord.tag_name
      || entry.id !== policyKit.id
      || entry.label !== policyKit.label
      || entry.summary !== policyKit.summary
    ) throw new Error('Registry entry does not match trusted Release policy identity');
    if (releaseUrls.has(entry.releaseManifestUrl)) throw new Error(`Duplicate trusted Release manifest URL: ${entry.releaseManifestUrl}`);
    releaseUrls.add(entry.releaseManifestUrl);
    const rawRelease = await fetchAssetJson(assets.get('release.json'), {
      githubToken, fetchImpl, maxBytes: MAX_METADATA_BYTES, timeoutMs: requestTimeoutMs,
    });
    const validated = validateRegistryRelease(entry, rawRelease);
    if (!policy.signerWorkflows.includes(validated.source.signerWorkflow)) throw new Error('Release signer workflow is not trusted');
    if (releaseRecord.prerelease !== (validated.channel === 'preview')) {
      throw new Error('GitHub Release prerelease does not match release.json');
    }
    const tagCommit = await resolveTagCommit({
      repository,
      tag: releaseRecord.tag_name,
      githubToken,
      fetchImpl,
      timeoutMs: requestTimeoutMs,
    });
    if (tagCommit !== validated.source.commit) throw new Error('GitHub Tag Commit does not match release.json');
    const artifact = validated.assets[0];
    const [hkitAsset] = hkitAssets;
    if (
      artifact.name !== hkitAsset.name
      || hkitAsset.digest !== `sha256:${artifact.sha256}`
      || !sameReleaseAssetUrl({
        repository,
        tag: releaseRecord.tag_name,
        name: artifact.name,
        immutableUrl: artifact.url,
        browserUrl: hkitAsset.browser_download_url,
      })
    ) throw new Error('Release .hkit asset does not match release.json');
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
    entries.push(deepFreeze(entry));
    releasesByUrl.push([entry.releaseManifestUrl, deepFreeze(validated)]);
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    releasesByUrl: readOnlyMap(releasesByUrl),
  });
}
