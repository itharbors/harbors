import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadRepositoryKit } from './repository-kits.mjs';

const POLICY_FILE = 'registry/policy.json';
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

export async function loadKitPolicy({
  repositoryRoot,
  policyFile = path.join(repositoryRoot, POLICY_FILE),
}) {
  const raw = JSON.parse(await readFile(policyFile, 'utf8'));
  const expectedKeys = ['kits', 'repository', 'schemaVersion', 'signerWorkflows', 'workflow'];
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Kit policy contains unexpected fields');
  }
  if (raw.schemaVersion !== 1 || raw.repository !== 'itharbors/harbors') {
    throw new Error('Kit policy identity is invalid');
  }
  if (raw.workflow !== 'itharbors/harbors/.github/workflows/publish-kit.yml') {
    throw new Error('Kit policy workflow is invalid');
  }
  const expectedSigners = [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ];
  if (JSON.stringify(raw.signerWorkflows) !== JSON.stringify(expectedSigners)) {
    throw new Error('Kit policy signer workflows are invalid');
  }
  const slugs = Object.keys(raw.kits ?? {}).sort();
  const ids = new Set();
  const kits = {};
  for (const slug of slugs) {
    const entry = raw.kits[slug];
    if (!SLUG_PATTERN.test(slug) || !entry || typeof entry !== 'object') {
      throw new Error(`Kit policy entry is invalid: ${slug}`);
    }
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['id'])) {
      throw new Error(`Kit policy entry contains unexpected fields: ${slug}`);
    }
    if (entry.id !== `@itharbors/kit-${slug}` || ids.has(entry.id)) {
      throw new Error(`Kit policy id is invalid: ${slug}`);
    }
    ids.add(entry.id);
    kits[slug] = Object.freeze({ id: entry.id });
  }
  return Object.freeze({ ...raw, kits: Object.freeze(kits) });
}

export async function loadTrustedMarketKit({ repositoryRoot, slug }) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Unknown official Kit slug: ${String(slug)}`);
  }
  const policy = await loadKitPolicy({ repositoryRoot });
  const policyEntry = policy.kits[slug];
  if (!policyEntry) {
    throw new Error(`Kit is not trusted for market publication: ${slug}`);
  }
  const descriptor = await loadRepositoryKit({ repositoryRoot, slug });
  if (descriptor.distribution !== 'market') {
    throw new Error(`Kit is not a market distribution: ${slug}`);
  }
  if (descriptor.id !== policyEntry.id) {
    throw new Error(`Kit identity drift for ${slug}: descriptor ${descriptor.id} does not match policy ${policyEntry.id}`);
  }
  const packageLock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const lockedPackage = packageLock.packages?.[`kits/${slug}`];
  if (lockedPackage?.name !== descriptor.id || lockedPackage.version !== descriptor.version) {
    throw new Error(`package-lock identity mismatch: ${slug}`);
  }
  return descriptor;
}
