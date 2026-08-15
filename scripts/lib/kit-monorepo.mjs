import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseKitPackageManifest, parseRepositoryKitPackage } from '@itharbors/kit-core';
import { parse as parseYaml } from 'yaml';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

function assertCanonicalSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid canonical Kit slug: ${String(slug)}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

export async function loadTrustedMarketKit({ repositoryRoot, slug }) {
  assertCanonicalSlug(slug);
  const kitsRoot = path.join(repositoryRoot, 'kits');
  const directory = path.join(kitsRoot, slug);

  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`Unknown Kit slug: ${slug}`);
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Kit directory is not a real directory: ${slug}`);
  }

  const realDirectory = await realpath(directory);
  const realKitsRoot = await realpath(kitsRoot);
  if (realDirectory !== path.join(realKitsRoot, slug)) {
    throw new Error(`Kit directory is not the canonical physical directory for slug: ${slug}`);
  }
  const relative = path.relative(realKitsRoot, realDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Kit directory escapes the kits root: ${slug}`);
  }

  const manifest = parseKitPackageManifest(JSON.parse(await readFile(path.join(directory, 'kit.json'), 'utf8')));
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (packageJson.name !== manifest.id) {
    throw new Error(`Kit identity mismatch for ${slug}: package.json.name ${packageJson.name} does not match kit.json.id ${manifest.id}`);
  }
  if (packageJson.version !== manifest.version) {
    throw new Error(`Kit version mismatch for ${slug}: package.json.version ${packageJson.version} does not match kit.json.version ${manifest.version}`);
  }
  if (packageJson.harbors === undefined) {
    throw new Error(`package.json is missing harbors metadata: ${slug}`);
  }

  const metadata = parseRepositoryKitPackage(packageJson.harbors);
  const pnpmLock = parseYaml(await readFile(path.join(directory, 'pnpm-lock.yaml'), 'utf8'));
  const rootImporter = pnpmLock?.importers?.['.'];
  if (rootImporter === null || typeof rootImporter !== 'object' || Array.isArray(rootImporter)) {
    throw new Error(`pnpm-lock identity mismatch for ${slug}: lock is missing the root importer`);
  }
  const lockName = rootImporter.name ?? manifest.id;
  const lockVersion = rootImporter.version ?? manifest.version;
  if (lockName !== manifest.id || lockVersion !== manifest.version) {
    throw new Error(`pnpm-lock identity mismatch for ${slug}: lock name ${lockName}@${lockVersion} does not match descriptor ${manifest.id}@${manifest.version}`);
  }

  return Object.freeze({
    slug,
    directory: realDirectory,
    id: manifest.id,
    version: manifest.version,
    distribution: metadata.distribution,
    isDefault: metadata.isDefault,
    target: Object.freeze({ ...manifest.target }),
    permissions: Object.freeze([...manifest.permissions]),
    ciRunner: metadata.ciRunner,
    summary: metadata.summary,
    scripts: metadata.scripts,
    resources: metadata.resources,
    legacyDataDirectories: metadata.legacyDataDirectories,
    manifest: deepFreeze(JSON.parse(JSON.stringify(manifest))),
    packageJson: deepFreeze(JSON.parse(JSON.stringify(packageJson))),
  });
}

export async function loadOfficialKit({ repositoryRoot, slug }) {
  const descriptor = await loadTrustedMarketKit({ repositoryRoot, slug });
  return Object.freeze({ ...descriptor, runner: descriptor.ciRunner });
}
