import {
  parseKitPackageManifest,
  parseKitRegistryIndex,
  parseReleaseManifest,
} from '@itharbors/kit-core';
import semver from 'semver';

const REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const KIT_ID_PATTERN = /^@([a-z0-9][a-z0-9._-]*)\/(kit-([a-z0-9][a-z0-9-]*))$/u;
const PUBLISH_SIGNER_WORKFLOW = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedText(value, name, maxLength) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be printable text no longer than ${maxLength} characters`);
  }
  return value;
}

function publicationIdentity(manifest) {
  const match = KIT_ID_PATTERN.exec(manifest.id);
  if (!match) throw new Error('Kit id must use @publisher/kit-<name>');
  const [, scope, packageName, slug] = match;
  if (scope !== manifest.publisher) {
    throw new Error('Kit id scope must match publisher');
  }
  return { packageName, publisher: manifest.publisher, slug };
}

function validateRepository(repository, publisher) {
  if (typeof repository !== 'string' || !REPOSITORY_PATTERN.test(repository)) {
    throw new TypeError('repository must be a canonical lowercase owner/repository');
  }
  if (repository.split('/')[0] !== publisher) {
    throw new Error('repository owner must match publisher');
  }
  return repository;
}

function validateSource({ commit, repository, workflow, ref }) {
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new TypeError('commit must be a lowercase 40-character SHA');
  }
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    throw new TypeError('ref must be a fully qualified Git ref');
  }
  const expectedWorkflow = `${repository}/.github/workflows/publish-kit.yml@${ref}`;
  if (workflow !== expectedWorkflow) {
    throw new Error(`workflow must equal ${expectedWorkflow}`);
  }
}

function validateTag({ channel, ref, slug, tag, version }) {
  const expectedTag = `kit/${slug}/v${version}`;
  if (tag !== expectedTag || ref !== `refs/tags/${expectedTag}`) {
    throw new Error(`Kit publication requires Tag ${expectedTag}`);
  }
  const prerelease = semver.prerelease(version);
  if (channel === 'stable' && prerelease !== null) {
    throw new Error('Stable publication requires a version without a prerelease segment');
  }
  if (channel === 'preview' && prerelease === null) {
    throw new Error('Preview publication requires a SemVer prerelease segment');
  }
}

function encodedReleaseUrl(repository, tag, file) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;
}

export function deriveArtifactName(rawManifest) {
  const manifest = parseKitPackageManifest(rawManifest);
  const { packageName } = publicationIdentity(manifest);
  const abi = manifest.target.nodeAbi === undefined ? '' : `-abi${manifest.target.nodeAbi}`;
  return `${packageName}-${manifest.version}-${manifest.target.platform}-${manifest.target.arch}${abi}.hkit`;
}

export function createKitPublicationMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('publication input is required');
  }
  const manifest = parseKitPackageManifest(input.manifest);
  const { publisher, slug } = publicationIdentity(manifest);
  const repository = validateRepository(input.repository, publisher);
  validateSource({
    commit: input.commit,
    repository,
    workflow: input.workflow,
    ref: input.ref,
  });
  if (input.signerWorkflow !== PUBLISH_SIGNER_WORKFLOW) {
    throw new Error(`signerWorkflow must equal ${PUBLISH_SIGNER_WORKFLOW}`);
  }
  validateTag({
    channel: manifest.channel,
    ref: input.ref,
    slug,
    tag: input.tag,
    version: manifest.version,
  });
  if (typeof input.sha256 !== 'string' || !SHA256_PATTERN.test(input.sha256)) {
    throw new TypeError('sha256 must be a lowercase 64-character digest');
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new TypeError('size must be a positive integer');
  }
  const label = boundedText(input.label, 'label', 80);
  const summary = boundedText(input.summary, 'summary', 280);
  const artifactName = deriveArtifactName(manifest);
  const releaseManifestUrl = encodedReleaseUrl(repository, input.tag, 'release.json');
  const release = parseReleaseManifest({
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    channel: manifest.channel,
    publisher,
    source: {
      repository,
      commit: input.commit,
      workflow: input.workflow,
      signerWorkflow: input.signerWorkflow,
      attestationUrl: `https://api.github.com/repos/${repository}/attestations/sha256:${input.sha256}`,
    },
    assets: [{
      name: artifactName,
      url: encodedReleaseUrl(repository, input.tag, artifactName),
      sha256: input.sha256,
      size: input.size,
      manifest,
    }],
  });
  const registryEntry = {
    schemaVersion: 1,
    id: manifest.id,
    label,
    publisher,
    summary,
    channel: manifest.channel,
    version: manifest.version,
    releaseManifestUrl,
    permissions: [...manifest.permissions],
    source: { repository, tag: input.tag },
  };

  // Reuse the public Registry parser for every field that reaches clients.
  parseKitRegistryIndex({
    schemaVersion: 1,
    generatedAt: '1980-01-01T00:00:00.000Z',
    kits: [{
      id: registryEntry.id,
      label: registryEntry.label,
      publisher: registryEntry.publisher,
      summary: registryEntry.summary,
      channels: {
        [registryEntry.channel]: {
          version: registryEntry.version,
          releaseManifestUrl: registryEntry.releaseManifestUrl,
          permissions: registryEntry.permissions,
        },
      },
    }],
    revocations: [],
  });

  return deepFreeze({ artifactName, release, registryEntry });
}
