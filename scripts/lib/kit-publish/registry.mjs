import {
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import {
  encodeKitId,
  parseKitRegistryIndex,
  parseReleaseManifest,
} from '@itharbors/kit-core';

import { fetchGitHubReleaseAsset } from '../kit-registry/github-release-fetch.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;
const KIT_ID_PATTERN = /^@([a-z0-9][a-z0-9._-]*)\/kit-([a-z0-9][a-z0-9-]*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PUBLISH_SIGNER_WORKFLOWS = new Set([
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function objectValue(value, context, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${context} contains unexpected field ${unknown}`);
  return value;
}

function nonEmptyString(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function kitIdentity(id, publisher) {
  const match = typeof id === 'string' ? KIT_ID_PATTERN.exec(id) : null;
  if (!match || match[1] !== publisher) {
    throw new Error('Registry entry id must use @publisher/kit-<name>');
  }
  return { slug: match[2] };
}

function exactReleaseUrl(repository, tag, file = 'release.json') {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;
}

function projectedIndex(entry) {
  return parseKitRegistryIndex({
    schemaVersion: 1,
    generatedAt: '1980-01-01T00:00:00.000Z',
    kits: [{
      id: entry.id,
      label: entry.label,
      publisher: entry.publisher,
      summary: entry.summary,
      channels: {
        [entry.channel]: {
          version: entry.version,
          releaseManifestUrl: entry.releaseManifestUrl,
          permissions: entry.permissions,
        },
      },
    }],
    revocations: [],
  }).kits[0];
}

export function parseRegistryEntry(value) {
  const input = objectValue(value, 'Registry channel entry', [
    'schemaVersion',
    'id',
    'label',
    'publisher',
    'summary',
    'channel',
    'version',
    'releaseManifestUrl',
    'permissions',
    'source',
  ]);
  if (input.schemaVersion !== 1) throw new Error('Registry channel entry schemaVersion must equal 1');
  const source = objectValue(input.source, 'Registry channel entry source', ['repository', 'tag']);
  const repository = nonEmptyString(source.repository, 'Registry channel entry repository');
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('Registry channel entry repository must be canonical lowercase owner/repository');
  }
  const publicEntry = {
    schemaVersion: 1,
    id: input.id,
    label: input.label,
    publisher: input.publisher,
    summary: input.summary,
    channel: input.channel,
    version: input.version,
    releaseManifestUrl: input.releaseManifestUrl,
    permissions: input.permissions,
  };
  const kit = projectedIndex(publicEntry);
  const channel = input.channel;
  const reference = kit.channels[channel];
  if (!reference || !['stable', 'preview'].includes(channel)) {
    throw new Error('Registry channel entry channel is invalid');
  }
  const { slug } = kitIdentity(kit.id, kit.publisher);
  if (repository.split('/')[0] !== kit.publisher) {
    throw new Error('Registry channel entry repository owner must match publisher');
  }
  const tag = nonEmptyString(source.tag, 'Registry channel entry tag');
  if (tag !== `kit/${slug}/v${reference.version}`) {
    throw new Error('Registry entry tag does not match Kit version');
  }
  if (reference.releaseManifestUrl !== exactReleaseUrl(repository, tag)) {
    throw new Error('Registry entry releaseManifestUrl does not match repository and tag');
  }
  return deepFreeze({
    schemaVersion: 1,
    id: kit.id,
    label: kit.label,
    publisher: kit.publisher,
    summary: kit.summary,
    channel,
    version: reference.version,
    releaseManifestUrl: reference.releaseManifestUrl,
    permissions: [...reference.permissions],
    source: { repository, tag },
  });
}

function sameStrings(left, right) {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validateRelease(entry, rawRelease) {
  const release = parseReleaseManifest(rawRelease);
  if (
    release.id !== entry.id
    || release.version !== entry.version
    || release.channel !== entry.channel
    || release.publisher !== entry.publisher
    || release.source.repository !== entry.source.repository
  ) throw new Error(`Release identity does not match Registry entry ${entry.id}@${entry.version}`);

  const expectedWorkflow = `${entry.source.repository}/.github/workflows/publish-kit.yml@refs/tags/${entry.source.tag}`;
  if (release.source.workflow !== expectedWorkflow) {
    throw new Error(`Release workflow does not match Registry entry ${entry.id}@${entry.version}`);
  }
  if (!PUBLISH_SIGNER_WORKFLOWS.has(release.source.signerWorkflow)) {
    throw new Error(`Release signer workflow does not match Registry entry ${entry.id}@${entry.version}`);
  }
  if (release.assets.length !== 1) {
    throw new Error('Release manifest must contain exactly one attested Kit asset');
  }
  const [asset] = release.assets;
  if (!sameStrings(asset.manifest.permissions, entry.permissions)) {
    throw new Error(`Release permissions do not match Registry entry ${entry.id}@${entry.version}`);
  }
  if (asset.url !== exactReleaseUrl(entry.source.repository, entry.source.tag, asset.name)) {
    throw new Error(`Release asset URL does not match Registry entry ${entry.id}@${entry.version}`);
  }
  const expectedAttestation = `https://api.github.com/repos/${entry.source.repository}/attestations/sha256:${asset.sha256}`;
  if (release.source.attestationUrl !== expectedAttestation) {
    throw new Error(`Release attestation URL does not match asset ${asset.name}`);
  }
  return release;
}

function parseInternalRevocations(value) {
  const input = objectValue(value, 'Registry revocations', ['schemaVersion', 'revocations']);
  if (input.schemaVersion !== 1 || !Array.isArray(input.revocations)) {
    throw new Error('Registry revocations must use schemaVersion 1 and an array');
  }
  return input.revocations.map((raw, index) => {
    const revocation = objectValue(raw, `Registry revocations[${index}]`, [
      'id', 'version', 'sha256', 'reason', 'action', 'releaseManifestUrl',
    ]);
    const releaseManifestUrl = nonEmptyString(
      revocation.releaseManifestUrl,
      `Registry revocations[${index}].releaseManifestUrl`,
    );
    // Validate the public projection with the same parser used by clients.
    const parsed = parseKitRegistryIndex({
      schemaVersion: 1,
      generatedAt: '1980-01-01T00:00:00.000Z',
      kits: [],
      revocations: [{
        id: revocation.id,
        version: revocation.version,
        sha256: revocation.sha256,
        reason: revocation.reason,
        action: revocation.action,
      }],
    }).revocations[0];
    return { ...parsed, releaseManifestUrl };
  });
}

function validateRevocation(revocation, rawRelease) {
  const release = parseReleaseManifest(rawRelease);
  if (release.id !== revocation.id || release.version !== revocation.version) {
    throw new Error(`Revocation evidence identity does not match ${revocation.id}@${revocation.version}`);
  }
  const asset = release.assets.find((candidate) => candidate.sha256 === revocation.sha256);
  if (!asset) throw new Error(`Revocation digest is absent from ${revocation.releaseManifestUrl}`);
  const { slug } = kitIdentity(release.id, release.publisher);
  const tag = `kit/${slug}/v${release.version}`;
  if (revocation.releaseManifestUrl !== exactReleaseUrl(release.source.repository, tag)) {
    throw new Error('Revocation evidence must be an immutable Stable GitHub Release manifest');
  }
  if (asset.url !== exactReleaseUrl(release.source.repository, tag, asset.name)) {
    throw new Error('Revocation evidence asset URL is inconsistent');
  }
  return release;
}

export function buildKitRegistryIndex({ entries, releasesByUrl, revocations, generatedAt }) {
  if (!Array.isArray(entries) || !(releasesByUrl instanceof Map) || !Array.isArray(revocations)) {
    throw new TypeError('entries, releasesByUrl, and revocations are required');
  }
  const parsedEntries = entries.map(parseRegistryEntry);
  const channels = new Set();
  const kits = new Map();
  for (const entry of parsedEntries) {
    const key = `${entry.id}\0${entry.channel}`;
    if (channels.has(key)) throw new Error(`Duplicate Registry channel ${entry.id} ${entry.channel}`);
    channels.add(key);
    const rawRelease = releasesByUrl.get(entry.releaseManifestUrl);
    if (rawRelease === undefined) throw new Error(`Missing Release manifest ${entry.releaseManifestUrl}`);
    validateRelease(entry, rawRelease);
    const existing = kits.get(entry.id);
    if (existing && (
      existing.label !== entry.label
      || existing.publisher !== entry.publisher
      || existing.summary !== entry.summary
    )) throw new Error(`Registry display identity differs across channels for ${entry.id}`);
    const kit = existing ?? {
      id: entry.id,
      label: entry.label,
      publisher: entry.publisher,
      summary: entry.summary,
      channels: {},
    };
    kit.channels[entry.channel] = {
      version: entry.version,
      releaseManifestUrl: entry.releaseManifestUrl,
      permissions: [...entry.permissions],
    };
    kits.set(entry.id, kit);
  }

  const publicRevocations = revocations.map((revocation) => {
    const rawRelease = releasesByUrl.get(revocation.releaseManifestUrl);
    if (rawRelease === undefined) {
      throw new Error(`Missing revocation Release manifest ${revocation.releaseManifestUrl}`);
    }
    validateRevocation(revocation, rawRelease);
    const { releaseManifestUrl: _evidence, ...publicValue } = revocation;
    return publicValue;
  });
  const index = parseKitRegistryIndex({
    schemaVersion: 1,
    generatedAt,
    kits: [...kits.values()].sort((left, right) => left.id.localeCompare(right.id)),
    revocations: publicRevocations.sort((left, right) => (
      `${left.id}\0${left.version}\0${left.sha256}`.localeCompare(`${right.id}\0${right.version}\0${right.sha256}`)
    )),
  });
  return deepFreeze(index);
}

async function readJson(file, context, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`${context} is not a bounded regular file`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${context} is not valid JSON`, { cause: error });
  }
}

async function loadEntries(entriesDirectory) {
  const directoryEntries = await readdir(entriesDirectory, { withFileTypes: true });
  const values = [];
  for (const directoryEntry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (directoryEntry.name === '.gitkeep') continue;
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new Error(`Registry entry path ${directoryEntry.name} must be a directory`);
    }
    const directory = path.join(entriesDirectory, directoryEntry.name);
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      if (file.name === '.gitkeep') continue;
      if (!file.isFile() || file.isSymbolicLink() || !['stable.json', 'preview.json'].includes(file.name)) {
        throw new Error(`Registry entry path ${directoryEntry.name}/${file.name} is invalid`);
      }
      const parsed = parseRegistryEntry(await readJson(
        path.join(directory, file.name),
        `Registry entry ${directoryEntry.name}/${file.name}`,
      ));
      if (
        directoryEntry.name !== encodeKitId(parsed.id)
        || file.name !== `${parsed.channel}.json`
      ) throw new Error(`Registry entry path does not match ${parsed.id} ${parsed.channel}`);
      values.push(parsed);
    }
  }
  return values;
}

async function readLimitedJsonResponse(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error('Remote Release manifest exceeds the size limit');
  }
  if (!response.body) throw new Error('Remote Release manifest body is empty');
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
        throw new Error('Remote Release manifest exceeds the size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    throw new Error('Remote Release manifest is not valid JSON', { cause: error });
  }
}

async function fetchRelease(url, { fetchImpl, timeoutMs, maxResponseBytes }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Release request timed out')), timeoutMs);
  try {
    const response = await fetchGitHubReleaseAsset(fetchImpl, url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Remote Release manifest failed with HTTP ${response.status}`);
    return await readLimitedJsonResponse(response, maxResponseBytes);
  } finally {
    clearTimeout(timeout);
  }
}

export async function aggregateKitRegistry({
  entriesDirectory,
  revocationsFile,
  generatedAt,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const entries = await loadEntries(path.resolve(entriesDirectory));
  const revocationDocument = await readJson(
    path.resolve(revocationsFile),
    'Registry revocations',
  );
  const revocations = parseInternalRevocations(revocationDocument);
  const urls = [...new Set([
    ...entries.map((entry) => entry.releaseManifestUrl),
    ...revocations.map((revocation) => revocation.releaseManifestUrl),
  ])].sort();
  const releasesByUrl = new Map();
  for (const url of urls) {
    releasesByUrl.set(url, await fetchRelease(url, { fetchImpl, timeoutMs, maxResponseBytes }));
  }
  return buildKitRegistryIndex({ entries, releasesByUrl, revocations, generatedAt });
}
