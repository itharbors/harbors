import {
  readFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

import {
  parseKitRegistryIndex,
  parseReleaseManifest,
} from '@itharbors/kit-core';

import { loadKitPolicy } from '../kit-monorepo.mjs';
import { deriveArtifactName } from './metadata.mjs';
import {
  discoverTrustedKitReleases,
  fetchTrustedReleaseManifest,
} from './release-source.mjs';

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

function validateReleaseEvidence(release, { repository, tag, context }) {
  const expectedWorkflow = `${repository}/.github/workflows/publish-kit.yml@refs/tags/${tag}`;
  if (release.source.workflow !== expectedWorkflow) {
    throw new Error(`Release workflow does not match ${context}`);
  }
  if (!PUBLISH_SIGNER_WORKFLOWS.has(release.source.signerWorkflow)) {
    throw new Error(`Release signer workflow does not match ${context}`);
  }
  if (release.assets.length !== 1) {
    throw new Error('Release manifest must contain exactly one attested Kit asset');
  }
  const [asset] = release.assets;
  const expectedAssetName = deriveArtifactName(asset.manifest);
  if (asset.name !== expectedAssetName) {
    throw new Error(`Release asset name does not match manifest ${context}`);
  }
  if (asset.url !== exactReleaseUrl(repository, tag, expectedAssetName)) {
    throw new Error(`Release asset URL does not match ${context}`);
  }
  const expectedAttestation = `https://api.github.com/repos/${repository}/attestations/sha256:${asset.sha256}`;
  if (release.source.attestationUrl !== expectedAttestation) {
    throw new Error(`Release attestation URL does not match asset ${expectedAssetName}`);
  }
  return asset;
}

export function validateRegistryRelease(entry, rawRelease) {
  const release = parseReleaseManifest(rawRelease);
  if (
    release.id !== entry.id
    || release.version !== entry.version
    || release.channel !== entry.channel
    || release.publisher !== entry.publisher
    || release.source.repository !== entry.source.repository
  ) throw new Error(`Release identity does not match Registry entry ${entry.id}@${entry.version}`);

  const asset = validateReleaseEvidence(release, {
    repository: entry.source.repository,
    tag: entry.source.tag,
    context: `Registry entry ${entry.id}@${entry.version}`,
  });
  if (!sameStrings(asset.manifest.permissions, entry.permissions)) {
    throw new Error(`Release permissions do not match Registry entry ${entry.id}@${entry.version}`);
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
    throw new Error('Revocation evidence must be an immutable GitHub Release manifest');
  }
  validateReleaseEvidence(release, {
    repository: release.source.repository,
    tag,
    context: `revocation evidence ${revocation.id}@${revocation.version}`,
  });
  return release;
}

export function buildKitRegistryIndex({ entries, releasesByUrl, revocations, generatedAt }) {
  if (!Array.isArray(entries) || !(releasesByUrl instanceof Map) || !Array.isArray(revocations)) {
    throw new TypeError('entries, releasesByUrl, and revocations are required');
  }
  const parsedEntries = entries.map(parseRegistryEntry);
  const tuples = new Set();
  const sourceTags = new Set();
  const releaseUrls = new Set();
  for (const entry of parsedEntries) {
    const tuple = `${entry.id}\0${entry.version}\0${entry.channel}`;
    if (tuples.has(tuple)) throw new Error(`Duplicate Registry entry ${entry.id} ${entry.version} ${entry.channel}`);
    tuples.add(tuple);
    const sourceTag = `${entry.source.repository}\0${entry.source.tag}`;
    if (sourceTags.has(sourceTag)) throw new Error(`Duplicate Registry source Tag ${entry.source.tag}`);
    sourceTags.add(sourceTag);
    if (releaseUrls.has(entry.releaseManifestUrl)) {
      throw new Error(`Duplicate Registry Release manifest URL ${entry.releaseManifestUrl}`);
    }
    releaseUrls.add(entry.releaseManifestUrl);
  }

  const kits = new Map();
  const candidates = [];
  for (const entry of parsedEntries) {
    const rawRelease = releasesByUrl.get(entry.releaseManifestUrl);
    if (rawRelease === undefined) throw new Error(`Missing Release manifest ${entry.releaseManifestUrl}`);
    const release = validateRegistryRelease(entry, rawRelease);
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
    kits.set(entry.id, kit);
    candidates.push({ entry, release });
  }

  const verifiedRevocations = revocations.map((revocation) => {
    const rawRelease = releasesByUrl.get(revocation.releaseManifestUrl);
    if (rawRelease === undefined) {
      throw new Error(`Missing revocation Release manifest ${revocation.releaseManifestUrl}`);
    }
    validateRevocation(revocation, rawRelease);
    const { releaseManifestUrl: _evidence, ...publicValue } = revocation;
    return publicValue;
  });
  const revokedArtifacts = new Set(verifiedRevocations.map((revocation) => (
    `${revocation.id}\0${revocation.version}\0${revocation.sha256}`
  )));
  const channels = new Map();
  for (const candidate of candidates) {
    const artifact = candidate.release.assets[0];
    const revocationKey = `${candidate.entry.id}\0${candidate.entry.version}\0${artifact.sha256}`;
    if (revokedArtifacts.has(revocationKey)) continue;
    const key = `${candidate.entry.id}\0${candidate.entry.channel}`;
    const values = channels.get(key) ?? [];
    values.push(candidate);
    channels.set(key, values);
  }
  for (const values of channels.values()) {
    values.sort((left, right) => semver.rcompare(left.entry.version, right.entry.version));
    const { entry } = values[0];
    kits.get(entry.id).channels[entry.channel] = {
      version: entry.version,
      releaseManifestUrl: entry.releaseManifestUrl,
      permissions: [...entry.permissions],
    };
  }
  const publicRevocations = verifiedRevocations;
  const index = parseKitRegistryIndex({
    schemaVersion: 1,
    generatedAt,
    kits: [...kits.values()]
      .filter((kit) => Object.keys(kit.channels).length > 0)
      .sort((left, right) => left.id.localeCompare(right.id)),
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

export async function aggregateKitRegistry({
  repositoryRoot,
  repository,
  policyFile,
  revocationsFile,
  generatedAt,
  githubToken,
  fetchImpl = globalThis.fetch,
  provenanceVerifier,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const policy = await loadKitPolicy({ repositoryRoot, policyFile });
  const discovered = await discoverTrustedKitReleases({
    policy,
    repository,
    githubToken,
    fetchImpl,
    provenanceVerifier,
    requestTimeoutMs,
  });
  const revocationDocument = await readJson(
    path.resolve(revocationsFile),
    'Registry revocations',
  );
  const revocations = parseInternalRevocations(revocationDocument);
  const releasesByUrl = new Map(discovered.releasesByUrl);
  for (const revocation of revocations) {
    if (releasesByUrl.has(revocation.releaseManifestUrl)) continue;
    releasesByUrl.set(revocation.releaseManifestUrl, await fetchTrustedReleaseManifest({
      repository,
      releaseManifestUrl: revocation.releaseManifestUrl,
      githubToken,
      fetchImpl,
      requestTimeoutMs,
    }));
  }
  return buildKitRegistryIndex({ entries: discovered.entries, releasesByUrl, revocations, generatedAt });
}
