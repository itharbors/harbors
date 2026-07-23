import {
  parseReleaseManifest,
  selectCompatibleAsset,
} from '@itharbors/kit-core';

import { fetchGitHubReleaseAsset } from './github-release-fetch.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const resolvedAssets = new WeakSet();

export class KitRegistryResolutionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'KitRegistryResolutionError';
    this.code = code;
  }
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${context} must be a positive integer`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizePolicies(policies) {
  if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) {
    throw new TypeError('publisherPolicies must be an object');
  }
  const normalized = Object.create(null);
  for (const [publisher, policy] of Object.entries(policies)) {
    if (
      !policy
      || !Array.isArray(policy.repositories)
      || !Array.isArray(policy.workflows)
      || !Array.isArray(policy.signerWorkflows)
    ) {
      throw new TypeError(
        `Publisher policy ${publisher} must define repositories, workflows, and signerWorkflows`,
      );
    }
    for (const value of [
      ...policy.repositories,
      ...policy.workflows,
      ...policy.signerWorkflows,
    ]) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Publisher policy ${publisher} contains an invalid identity`);
      }
    }
    normalized[publisher] = {
      repositories: [...new Set(policy.repositories)],
      workflows: [...new Set(policy.workflows)],
      signerWorkflows: [...new Set(policy.signerWorkflows)],
    };
  }
  return deepFreeze(normalized);
}

async function readLimitedResponse(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new KitRegistryResolutionError(
        'RELEASE_TOO_LARGE',
        `Release manifest exceeds ${maxBytes} bytes`,
      );
    }
  }
  if (!response.body) {
    throw new KitRegistryResolutionError('RELEASE_INVALID', 'Release manifest body is empty');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new KitRegistryResolutionError(
          'RELEASE_TOO_LARGE',
          `Release manifest exceeds ${maxBytes} bytes`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    throw new KitRegistryResolutionError(
      'RELEASE_INVALID',
      'Release manifest is not valid JSON',
      { cause: error },
    );
  }
}

function assertIdentity(release, kit, reference, channel) {
  if (
    release.id !== kit.id
    || release.version !== reference.version
    || release.channel !== channel
    || release.publisher !== kit.publisher
  ) {
    throw new KitRegistryResolutionError(
      'RELEASE_IDENTITY_MISMATCH',
      `Release identity does not match Registry entry ${kit.id}@${reference.version}`,
    );
  }
}

function assertPolicy(release, policies) {
  const policy = Object.hasOwn(policies, release.publisher)
    ? policies[release.publisher]
    : undefined;
  if (
    !policy
    || !policy.repositories.includes(release.source.repository)
    || !policy.workflows.some((workflow) => (
      release.source.workflow === workflow
      || (!workflow.includes('@') && release.source.workflow.startsWith(`${workflow}@refs/`))
    ))
    || !policy.signerWorkflows.includes(release.source.signerWorkflow)
  ) {
    throw new KitRegistryResolutionError(
      'SOURCE_NOT_TRUSTED',
      `Release source is not trusted for publisher ${release.publisher}`,
    );
  }
}

function assertProvenance(claims, expected) {
  if (
    claims?.verified !== true
    || claims.subjectName !== expected.subjectName
    || claims.subjectSha256 !== expected.subjectSha256
    || claims.repository !== expected.repository
    || claims.commit !== expected.commit
    || claims.workflow !== expected.workflow
    || claims.signerWorkflow !== expected.signerWorkflow
  ) {
    throw new KitRegistryResolutionError(
      'PROVENANCE_FAILED',
      'Artifact attestation does not match the selected Kit asset and source',
    );
  }
}

export function assertResolvedRegistryAsset(value) {
  if (!value || typeof value !== 'object' || !resolvedAssets.has(value)) {
    throw new TypeError('Kit asset was not produced by the trusted resolver');
  }
  return value;
}

export class KitReleaseResolver {
  #snapshotProvider;
  #fetch;
  #provenanceVerifier;
  #publisherPolicies;
  #timeoutMs;
  #maxResponseBytes;

  constructor({
    snapshotProvider,
    fetchImpl = globalThis.fetch,
    provenanceVerifier,
    publisherPolicies,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }) {
    if (!snapshotProvider || typeof snapshotProvider.snapshot !== 'function') {
      throw new TypeError('Registry snapshot provider is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (!provenanceVerifier || typeof provenanceVerifier.verify !== 'function') {
      throw new TypeError('provenanceVerifier is required');
    }
    this.#snapshotProvider = snapshotProvider;
    this.#fetch = fetchImpl;
    this.#provenanceVerifier = provenanceVerifier;
    this.#publisherPolicies = normalizePolicies(publisherPolicies);
    this.#timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.#maxResponseBytes = positiveInteger(maxResponseBytes, 'maxResponseBytes');
  }

  async #fetchRelease(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error('Release manifest request timed out'));
    }, this.#timeoutMs);
    try {
      const response = await fetchGitHubReleaseAsset(this.#fetch, url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new KitRegistryResolutionError(
          'RELEASE_FETCH_FAILED',
          `Release manifest request failed with HTTP ${response.status}`,
        );
      }
      return await readLimitedResponse(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof KitRegistryResolutionError) throw error;
      throw new KitRegistryResolutionError(
        'RELEASE_FETCH_FAILED',
        'Release manifest request failed',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolve({ id, version, channel, runtime }) {
    const snapshot = await this.#snapshotProvider.snapshot();
    if (!snapshot?.index) {
      throw new KitRegistryResolutionError('MARKET_UNAVAILABLE', 'No verified Registry is available');
    }
    const kit = snapshot.index.kits.find((candidate) => candidate.id === id);
    if (!kit) throw new KitRegistryResolutionError('KIT_NOT_FOUND', `Kit ${id} is not listed`);
    const reference = kit.channels[channel];
    if (!reference || reference.version !== version) {
      throw new KitRegistryResolutionError(
        'VERSION_NOT_LISTED',
        `Kit ${id}@${version} is not listed in ${String(channel)}`,
      );
    }

    const rawRelease = await this.#fetchRelease(reference.releaseManifestUrl);
    let release;
    try {
      release = parseReleaseManifest(rawRelease);
    } catch (error) {
      throw new KitRegistryResolutionError(
        'RELEASE_INVALID',
        'Release manifest failed schema validation',
        { cause: error },
      );
    }
    assertIdentity(release, kit, reference, channel);
    assertPolicy(release, this.#publisherPolicies);

    let asset;
    try {
      asset = selectCompatibleAsset(release, runtime);
    } catch (error) {
      throw new KitRegistryResolutionError(
        'INCOMPATIBLE_ASSET',
        `Release ${release.id}@${release.version} has no unique compatible asset`,
        { cause: error },
      );
    }
    const listedPermissions = [...reference.permissions].sort();
    const releasedPermissions = [...asset.manifest.permissions].sort();
    if (
      listedPermissions.length !== releasedPermissions.length
      || listedPermissions.some((permission, index) => permission !== releasedPermissions[index])
    ) {
      throw new KitRegistryResolutionError(
        'PERMISSIONS_MISMATCH',
        'Registry permissions do not match the selected Kit asset',
      );
    }
    if (
      releasedPermissions.includes('application-startup')
      && release.publisher !== 'itharbors'
    ) {
      throw new KitRegistryResolutionError(
        'PERMISSION_NOT_ALLOWED',
        'Only the official itharbors publisher may request application-startup',
      );
    }
    const revocation = snapshot.index.revocations.find((candidate) => (
      candidate.id === release.id
      && candidate.version === release.version
      && candidate.sha256 === asset.sha256
    ));
    if (revocation) {
      throw new KitRegistryResolutionError(
        'REVOKED',
        `Kit asset was revoked: ${revocation.reason}`,
      );
    }

    const expectedClaims = {
      attestationUrl: release.source.attestationUrl,
      subjectName: asset.name,
      subjectSha256: asset.sha256,
      repository: release.source.repository,
      commit: release.source.commit,
      workflow: release.source.workflow,
      signerWorkflow: release.source.signerWorkflow,
    };
    let claims;
    try {
      claims = await this.#provenanceVerifier.verify(expectedClaims);
    } catch (error) {
      throw new KitRegistryResolutionError(
        'PROVENANCE_FAILED',
        'Artifact attestation verification failed',
        { cause: error },
      );
    }
    assertProvenance(claims, expectedClaims);

    const resolved = deepFreeze({
      id: release.id,
      version: release.version,
      channel: release.channel,
      publisher: release.publisher,
      name: asset.name,
      url: asset.url,
      sha256: asset.sha256,
      size: asset.size,
      manifest: asset.manifest,
      source: release.source,
      releaseManifestUrl: reference.releaseManifestUrl,
      provenance: { verified: true },
    });
    resolvedAssets.add(resolved);
    return resolved;
  }
}
