import { KitRegistryManager } from './kit-registry/manager.mjs';
import { KitRegistryCache } from './kit-registry/cache.mjs';
import { KitRegistryClient } from './kit-registry/client.mjs';
import { KitReleaseResolver } from './kit-registry/resolver.mjs';
import { GitHubArtifactAttestationVerifier } from './kit-registry/github-attestation.mjs';
import { KitArtifactDownloader } from './kit-registry/downloader.mjs';
import { KitAuditLog } from './kit-registry/audit.mjs';
import { InstalledKitStore } from './kit-store/state.mjs';
import { KitArtifactInstaller } from './kit-store/installer.mjs';

export const DEFAULT_KIT_REGISTRY_URL = 'https://itharbors.github.io/harbors/index.v1.json';
export const DEFAULT_KIT_PUBLISHER_POLICIES = Object.freeze({
  itharbors: Object.freeze({
    repositories: Object.freeze(['itharbors/harbors']),
    workflows: Object.freeze(['itharbors/harbors/.github/workflows/publish-kit.yml']),
    signerWorkflows: Object.freeze([
      'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
      'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
    ]),
  }),
});

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const WORKFLOW_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml(?:@refs\/[A-Za-z0-9._\/-]+)?$/;

function clone(value) {
  return structuredClone(value);
}

function parseRegistryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Kit Registry URL must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Kit Registry URL must use HTTPS without credentials or fragments');
  }
  return url.href;
}

function parseStringArray(value, pattern, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }
  if (value.some((item) => typeof item !== 'string' || !pattern.test(item))) {
    throw new Error(`${context} contains an invalid identity`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${context} contains duplicates`);
  return [...value];
}

function parsePublisherPolicies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Kit publisher policy must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error('Kit publisher policy must not be empty');
  const result = {};
  for (const [publisher, policy] of entries) {
    if (publisher === 'itharbors') {
      throw new Error('Kit publisher policy itharbors is reserved and cannot be overridden');
    }
    if (!NAME_PATTERN.test(publisher) || !policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('Kit publisher policy contains an invalid publisher');
    }
    const keys = Object.keys(policy);
    if (
      keys.length !== 3
      || !keys.includes('repositories')
      || !keys.includes('workflows')
      || !keys.includes('signerWorkflows')
    ) {
      throw new Error(
        `Kit publisher policy ${publisher} must contain only repositories, workflows, and signerWorkflows`,
      );
    }
    result[publisher] = {
      repositories: parseStringArray(
        policy.repositories,
        REPOSITORY_PATTERN,
        `Kit publisher policy ${publisher} repositories`,
      ),
      workflows: parseStringArray(
        policy.workflows,
        WORKFLOW_PATTERN,
        `Kit publisher policy ${publisher} workflows`,
      ),
      signerWorkflows: parseStringArray(
        policy.signerWorkflows,
        WORKFLOW_PATTERN,
        `Kit publisher policy ${publisher} signer workflows`,
      ),
    };
  }
  return result;
}

function parseAutoUpdatePublishers(value, policies) {
  const publishers = value === undefined
    ? ['itharbors']
    : value.split(',').map((item) => item.trim());
  if (
    publishers.some((item) => !NAME_PATTERN.test(item) || !Object.hasOwn(policies, item))
    || new Set(publishers).size !== publishers.length
  ) {
    throw new Error('Kit auto-update publishers must be unique trusted publisher names');
  }
  return publishers;
}

export function resolveKitManagerConfig(env = process.env) {
  if (!env || typeof env !== 'object') throw new TypeError('Kit Manager environment is required');
  const registryUrl = parseRegistryUrl(
    env.HARBORS_KIT_REGISTRY_URL ?? DEFAULT_KIT_REGISTRY_URL,
  );
  let publisherPolicies = clone(DEFAULT_KIT_PUBLISHER_POLICIES);
  if (env.HARBORS_KIT_PUBLISHER_POLICIES_JSON !== undefined) {
    try {
      publisherPolicies = {
        ...clone(DEFAULT_KIT_PUBLISHER_POLICIES),
        ...parsePublisherPolicies(JSON.parse(env.HARBORS_KIT_PUBLISHER_POLICIES_JSON)),
      };
    } catch (error) {
      throw new Error('Kit publisher policy configuration is invalid', { cause: error });
    }
  }
  return {
    registryUrl,
    publisherPolicies,
    autoUpdatePublishers: parseAutoUpdatePublishers(
      env.HARBORS_KIT_AUTO_UPDATE_PUBLISHERS,
      publisherPolicies,
    ),
  };
}

export function createKitManagerService({
  storeRoot,
  runtime,
  store: providedStore,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof storeRoot !== 'string' || storeRoot.length === 0) {
    throw new TypeError('Kit Store root is required');
  }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new TypeError('Kit runtime is required');
  }
  const config = resolveKitManagerConfig(env);
  const store = providedStore ?? new InstalledKitStore(storeRoot);
  const cache = new KitRegistryCache(storeRoot);
  const client = new KitRegistryClient({
    registryUrl: config.registryUrl,
    cache,
    fetchImpl,
    now,
  });
  const provenanceVerifier = new GitHubArtifactAttestationVerifier({ fetchImpl });
  const resolver = new KitReleaseResolver({
    snapshotProvider: client,
    fetchImpl,
    provenanceVerifier,
    publisherPolicies: config.publisherPolicies,
  });
  const downloader = new KitArtifactDownloader({ storeRoot, fetchImpl });
  const installer = new KitArtifactInstaller({ storeRoot, store, runtime });
  const audit = new KitAuditLog(storeRoot);
  const manager = new KitRegistryManager({
    client,
    resolver,
    downloader,
    installer,
    store,
    audit,
    runtime,
    autoUpdatePublishers: config.autoUpdatePublishers,
  });
  return {
    manager,
    store,
    audit,
    client,
    provenanceVerifier,
    config: clone(config),
  };
}
