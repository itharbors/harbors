import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function discoverKits({ rootDir, requestedKit } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('rootDir is required');
  }

  const catalog = await discoverRepositoryKits(rootDir);
  catalog.sort(compareKits);
  assertUniqueCatalog(catalog);

  if (!requestedKit) {
    return catalog;
  }

  const packageMatch = catalog.find((kit) => kit.name === requestedKit);
  if (packageMatch) {
    return catalog;
  }

  const requestedPath = path.resolve(rootDir, requestedKit);
  const pathMatch = catalog.find((kit) => kit.directory === requestedPath);
  if (pathMatch) {
    return catalog;
  }

  const explicitEntry = await readKitEntry(requestedPath);
  if (explicitEntry.status === 'valid') {
    const combined = [...catalog, explicitEntry.entry].sort(compareKits);
    assertUniqueCatalog(combined);
    return combined;
  }
  if (explicitEntry.status === 'invalid') {
    throw new Error(`Invalid Kit manifest at ${requestedPath}: ${explicitEntry.reason}`);
  }

  throw new Error(`Requested Kit "${requestedKit}" not found`);
}

export function resolveRequestedKitName(catalog, requestedKit, rootDir) {
  if (!requestedKit) return null;
  const requestedPath = path.resolve(rootDir, requestedKit);
  const match = catalog.find((kit) => (
    kit.name === requestedKit || kit.directory === requestedPath
  ));
  if (!match) {
    throw new Error(`Requested Kit "${requestedKit}" not found in Catalog`);
  }
  return match.name;
}

function compareKits(left, right) {
  return left.label.localeCompare(right.label) || left.name.localeCompare(right.name);
}

async function discoverRepositoryKits(rootDir) {
  const kitsDir = path.join(rootDir, 'kits');
  let entries;
  try {
    entries = await readdir(kitsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const catalog = [];
  for (const directory of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const result = await readKitEntry(path.join(kitsDir, directory.name));
    if (result.status === 'valid') {
      catalog.push(result.entry);
    }
  }
  return catalog;
}

async function readKitEntry(directory) {
  const manifestPath = path.join(directory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 'missing' };
    }
    return { status: 'invalid', reason: 'package.json is not valid JSON' };
  }

  const reason = validateManifest(manifest);
  if (reason) {
    return { status: 'invalid', reason };
  }

  const menuRoot = manifest['ce-editor'].kit.menuRoot;
  return {
    status: 'valid',
    entry: {
      name: manifest.name,
      label: menuRoot.label,
      menuRoot: { id: menuRoot.id, label: menuRoot.label },
      directory: path.resolve(directory),
      manifestPath: path.resolve(manifestPath),
    },
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'manifest must be an object';
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return 'name is required';
  const kit = manifest['ce-editor']?.kit;
  if (!kit || typeof kit !== 'object') return 'ce-editor.kit is required';
  if (typeof kit.menuRoot?.id !== 'string' || kit.menuRoot.id.length === 0) return 'menuRoot.id is required';
  if (typeof kit.menuRoot?.label !== 'string' || kit.menuRoot.label.length === 0) return 'menuRoot.label is required';
  if (typeof kit.layouts?.default !== 'string' || kit.layouts.default.length === 0) return 'layouts.default is required';
  if (typeof kit.windowEntries?.main !== 'string' || kit.windowEntries.main.length === 0) return 'windowEntries.main is required';
  if (typeof kit.windowEntries?.secondary !== 'string' || kit.windowEntries.secondary.length === 0) return 'windowEntries.secondary is required';
  return null;
}

function assertUniqueCatalog(catalog) {
  assertUnique(catalog, (kit) => kit.name, 'Duplicate Kit package name');
  assertUnique(catalog, (kit) => kit.menuRoot.id, 'Duplicate Kit menu root');
}

function assertUnique(catalog, select, message) {
  const seen = new Set();
  for (const kit of catalog) {
    const value = select(kit);
    if (seen.has(value)) {
      throw new Error(`${message}: ${value}`);
    }
    seen.add(value);
  }
}
