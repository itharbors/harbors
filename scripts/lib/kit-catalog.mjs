import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function discoverKits({ rootDir, requestedKit } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('rootDir is required');
  }

  const catalog = await discoverRepositoryKits(rootDir);
  assertUniqueCatalog(catalog);

  if (!requestedKit) {
    return catalog;
  }

  const packageMatch = catalog.find((kit) => kit.name === requestedKit);
  if (packageMatch) {
    return [packageMatch];
  }

  const requestedPath = path.resolve(rootDir, requestedKit);
  const pathMatch = catalog.find((kit) => kit.directory === requestedPath);
  if (pathMatch) {
    return [pathMatch];
  }

  const explicitEntry = await readKitEntry(requestedPath);
  if (explicitEntry.status === 'valid') {
    return [explicitEntry.entry];
  }
  if (explicitEntry.status === 'invalid') {
    throw new Error(`Invalid Kit manifest at ${requestedPath}: ${explicitEntry.reason}`);
  }

  throw new Error(`Requested Kit "${requestedKit}" not found`);
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
  const startupPlugins = manifest['ce-editor'].kit.startup?.plugins ?? [];
  return {
    status: 'valid',
    entry: {
      name: manifest.name,
      label: menuRoot.label,
      menuRoot: { id: menuRoot.id, label: menuRoot.label },
      directory: path.resolve(directory),
      manifestPath: path.resolve(manifestPath),
      startupPlugins: [...startupPlugins],
    },
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'manifest must be an object';
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) return 'name is required';
  const kit = manifest['ce-editor']?.kit;
  if (!kit || typeof kit !== 'object') return 'ce-editor.kit is required';
  if (typeof kit.menuRoot?.id !== 'string' || kit.menuRoot.id.trim().length === 0) return 'menuRoot.id is required';
  if (typeof kit.menuRoot?.label !== 'string' || kit.menuRoot.label.trim().length === 0) return 'menuRoot.label is required';
  if (typeof kit.layouts?.default !== 'string' || kit.layouts.default.trim().length === 0) return 'layouts.default is required';
  if (typeof kit.windowEntries?.main !== 'string' || kit.windowEntries.main.trim().length === 0) return 'windowEntries.main is required';
  if (typeof kit.windowEntries?.secondary !== 'string' || kit.windowEntries.secondary.trim().length === 0) return 'windowEntries.secondary is required';
  const ordinaryPluginsReason = validatePluginList(kit.plugin, 'plugin');
  if (ordinaryPluginsReason) return ordinaryPluginsReason;
  if (kit.startup !== undefined && (!kit.startup || typeof kit.startup !== 'object' || Array.isArray(kit.startup))) {
    return 'startup must be an object';
  }
  const startupPluginsReason = validatePluginList(kit.startup?.plugins, 'startup.plugins');
  if (startupPluginsReason) return startupPluginsReason;
  const ordinaryPlugins = new Set(kit.plugin ?? []);
  const overlap = (kit.startup?.plugins ?? []).find((name) => ordinaryPlugins.has(name));
  if (overlap) return `startup plugin "${overlap}" must not also be an ordinary plugin`;
  return null;
}

function validatePluginList(value, field) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${field} must be an array`;
  if (value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return `${field} must contain non-empty strings`;
  }
  if (new Set(value).size !== value.length) return `${field} must not contain duplicates`;
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
