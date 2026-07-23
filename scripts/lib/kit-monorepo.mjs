import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseKitPackageManifest } from '@itharbors/kit-core';

const POLICY_FILE = 'registry/policy.json';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ALLOWED_RUNNERS = new Set(['ubuntu-latest', 'macos-14']);

export const OFFICIAL_KIT_SLUGS = Object.freeze(['mysql', 'notifications', 'sqlite']);

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
  if (JSON.stringify(slugs) !== JSON.stringify(OFFICIAL_KIT_SLUGS)) {
    throw new Error('Kit policy official slug set is invalid');
  }
  const ids = new Set();
  for (const slug of slugs) {
    const entry = raw.kits[slug];
    if (!SLUG_PATTERN.test(slug) || !entry || typeof entry !== 'object') {
      throw new Error(`Kit policy entry is invalid: ${slug}`);
    }
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['id', 'label', 'runner', 'summary'])) {
      throw new Error(`Kit policy entry contains unexpected fields: ${slug}`);
    }
    if (entry.id !== `@itharbors/kit-${slug}` || ids.has(entry.id)) {
      throw new Error(`Kit policy id is invalid: ${slug}`);
    }
    if (!ALLOWED_RUNNERS.has(entry.runner) || !entry.label || !entry.summary) {
      throw new Error(`Kit policy metadata is invalid: ${slug}`);
    }
    ids.add(entry.id);
  }
  return Object.freeze(raw);
}

export async function loadOfficialKit({ repositoryRoot, slug }) {
  if (!OFFICIAL_KIT_SLUGS.includes(slug)) {
    throw new Error(`Unknown official Kit slug: ${String(slug)}`);
  }
  const policy = await loadKitPolicy({ repositoryRoot });
  const directory = await realpath(path.join(repositoryRoot, 'kits', slug));
  const manifest = parseKitPackageManifest(JSON.parse(
    await readFile(path.join(directory, 'kit.json'), 'utf8'),
  ));
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const metadata = policy.kits[slug];
  if (manifest.id !== metadata.id || packageJson.name !== metadata.id) {
    throw new Error(`Kit identity mismatch: ${slug}`);
  }
  if (manifest.version !== packageJson.version) {
    throw new Error(`Kit version mismatch: ${slug}`);
  }
  const lockedPackage = packageLock.packages?.[`kits/${slug}`];
  if (lockedPackage?.name !== packageJson.name || lockedPackage.version !== packageJson.version) {
    throw new Error(`package-lock identity mismatch: ${slug}`);
  }
  return Object.freeze({ slug, directory, ...metadata, manifest, packageJson });
}
