import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
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

function extractMenuRoot(packageJson) {
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
  const id = menuRoot.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('package.json ce-editor.kit.menuRoot.id must be a non-empty string');
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('package.json ce-editor.kit.menuRoot.label must be a non-empty string');
  }
  return Object.freeze({ id, label });
}

async function loadKitDescriptor(repositoryRoot, slug) {
  assertCanonicalSlug(slug);

  const kitsRoot = path.join(repositoryRoot, 'kits');
  const directory = path.join(kitsRoot, slug);

  const directoryStat = await lstat(directory);
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

  const menuRoot = extractMenuRoot(packageJson);

  const frozenManifest = deepFreeze(JSON.parse(JSON.stringify(manifest)));
  const frozenPackageJson = deepFreeze(JSON.parse(JSON.stringify(packageJson)));

  return Object.freeze({
    slug,
    directory: realDirectory,
    id: manifest.id,
    version: manifest.version,
    label: menuRoot.label,
    menuRoot,
    distribution: metadata.distribution,
    isDefault: metadata.isDefault,
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

async function listRepositoryKitSlugs(repositoryRoot) {
  const kitsRoot = path.join(repositoryRoot, 'kits');
  const entries = await readdir(kitsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => SLUG_PATTERN.test(name))
    .sort();
}

function assertUniqueDescriptors(descriptors) {
  const seenIds = new Set();
  const seenMenuRootIds = new Set();
  for (const descriptor of descriptors) {
    if (seenIds.has(descriptor.id)) {
      throw new Error(`duplicate Kit id discovered: ${descriptor.id}`);
    }
    seenIds.add(descriptor.id);
    if (seenMenuRootIds.has(descriptor.menuRoot.id)) {
      throw new Error(`duplicate Kit menu root id discovered: ${descriptor.menuRoot.id}`);
    }
    seenMenuRootIds.add(descriptor.menuRoot.id);
  }
}

function assertExactlyOneDefaultBuiltin(descriptors, { allowNoBuiltin = false } = {}) {
  const builtin = descriptors.filter((descriptor) => descriptor.distribution === 'builtin');
  if ((builtin.length > 0 || !allowNoBuiltin)
    && builtin.filter((descriptor) => descriptor.isDefault).length !== 1) {
    throw new Error('builtin Kits must declare exactly one default');
  }
}

export async function discoverRepositoryKits({ repositoryRoot }) {
  const slugs = await listRepositoryKitSlugs(repositoryRoot);
  const descriptors = [];
  for (const slug of slugs) {
    descriptors.push(await loadKitDescriptor(repositoryRoot, slug));
  }

  assertUniqueDescriptors(descriptors);
  assertExactlyOneDefaultBuiltin(descriptors, { allowNoBuiltin: true });

  return Object.freeze(descriptors);
}

export async function discoverRepositoryBuiltinKits({ repositoryRoot }) {
  const descriptors = [];
  for (const slug of await listRepositoryKitSlugs(repositoryRoot)) {
    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(
        path.join(repositoryRoot, 'kits', slug, 'package.json'),
        'utf8',
      ));
    } catch {
      // Unknown or malformed non-builtin candidates belong to Catalog diagnostics.
      continue;
    }
    if (packageJson?.harbors?.distribution !== 'builtin') continue;
    descriptors.push(await loadKitDescriptor(repositoryRoot, slug));
  }

  assertUniqueDescriptors(descriptors);
  assertExactlyOneDefaultBuiltin(descriptors);
  return Object.freeze(descriptors);
}

export async function loadRepositoryKit({ repositoryRoot, slug }) {
  return loadKitDescriptor(repositoryRoot, slug);
}
