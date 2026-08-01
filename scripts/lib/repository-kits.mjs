import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseKitPackageManifest, parseRepositoryKitPackage } from '@itharbors/kit-core';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

function assertCanonicalSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid canonical Kit slug: ${String(slug)}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return Object.freeze(value);
}

async function validateResource(kitDirectory, resource, index) {
  const segments = resource.split('/');
  let current = kitDirectory;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let entryStat;
    try {
      entryStat = await lstat(current);
    } catch {
      throw new Error(`harbors.resources[${index}] does not exist: ${resource}`);
    }
    if (entryStat.isSymbolicLink()) {
      throw new Error(`harbors.resources[${index}] must not be a symlink: ${resource}`);
    }
    const isLast = i === segments.length - 1;
    if (isLast) {
      if (!entryStat.isFile() && !entryStat.isDirectory()) {
        throw new Error(
          `harbors.resources[${index}] must be a regular file or directory: ${resource}`,
        );
      }
    } else if (!entryStat.isDirectory()) {
      throw new Error(
        `harbors.resources[${index}] intermediate component is not a directory: ${resource}`,
      );
    }
  }
}

function extractLabel(packageJson) {
  const ceEditor = packageJson['ce-editor'];
  if (ceEditor === null || typeof ceEditor !== 'object') {
    throw new Error('package.json is missing ce-editor configuration');
  }
  const kit = ceEditor.kit;
  if (kit === null || typeof kit !== 'object') {
    throw new Error('package.json ce-editor is missing kit configuration');
  }
  const menuRoot = kit.menuRoot;
  if (menuRoot === null || typeof menuRoot !== 'object') {
    throw new Error('package.json ce-editor.kit is missing menuRoot');
  }
  const label = menuRoot.label;
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('package.json ce-editor.kit.menuRoot.label must be a non-empty string');
  }
  return label;
}

async function loadKitDescriptor(repositoryRoot, slug) {
  assertCanonicalSlug(slug);

  const kitsRoot = path.join(repositoryRoot, 'kits');
  const directory = path.join(kitsRoot, slug);

  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Kit directory is not a real directory: ${slug}`);
  }

  const realDirectory = await realpath(directory);
  const realKitsRoot = await realpath(kitsRoot);
  const relative = path.relative(realKitsRoot, realDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Kit directory escapes the kits root: ${slug}`);
  }

  const kitJsonPath = path.join(directory, 'kit.json');
  const packageJsonPath = path.join(directory, 'package.json');

  const manifest = parseKitPackageManifest(JSON.parse(await readFile(kitJsonPath, 'utf8')));
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

  if (packageJson.name !== manifest.id) {
    throw new Error(`Kit identity mismatch for ${slug}: package.json.name ${packageJson.name} does not match kit.json.id ${manifest.id}`);
  }
  if (packageJson.version !== manifest.version) {
    throw new Error(`Kit version mismatch for ${slug}: package.json.version ${packageJson.version} does not match kit.json.version ${manifest.version}`);
  }

  const harbors = packageJson.harbors;
  if (harbors === undefined) {
    throw new Error(`package.json is missing harbors metadata: ${slug}`);
  }
  const metadata = parseRepositoryKitPackage(harbors);

  for (let i = 0; i < metadata.resources.length; i += 1) {
    await validateResource(realDirectory, metadata.resources[i], i);
  }

  const label = extractLabel(packageJson);

  const frozenManifest = deepFreeze(JSON.parse(JSON.stringify(manifest)));
  const frozenPackageJson = deepFreeze(JSON.parse(JSON.stringify(packageJson)));

  return Object.freeze({
    slug,
    directory: realDirectory,
    id: manifest.id,
    version: manifest.version,
    label,
    distribution: metadata.distribution,
    target: Object.freeze({ ...manifest.target }),
    permissions: Object.freeze([...manifest.permissions]),
    ciRunner: metadata.ciRunner,
    summary: metadata.summary,
    scripts: metadata.scripts,
    resources: metadata.resources,
    legacyDataDirectories: metadata.legacyDataDirectories,
    manifest: frozenManifest,
    packageJson: frozenPackageJson,
  });
}

export async function discoverRepositoryKits({ repositoryRoot }) {
  const kitsRoot = path.join(repositoryRoot, 'kits');
  const entries = await readdir(kitsRoot, { withFileTypes: true });

  const slugs = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => SLUG_PATTERN.test(name))
    .sort();

  const descriptors = [];
  const seenIds = new Set();
  for (const slug of slugs) {
    const descriptor = await loadKitDescriptor(repositoryRoot, slug);
    if (seenIds.has(descriptor.id)) {
      throw new Error(`duplicate Kit id discovered: ${descriptor.id}`);
    }
    seenIds.add(descriptor.id);
    descriptors.push(descriptor);
  }

  return Object.freeze(descriptors);
}

export async function loadRepositoryKit({ repositoryRoot, slug }) {
  return loadKitDescriptor(repositoryRoot, slug);
}
