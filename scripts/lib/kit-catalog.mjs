import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseKitPackageManifest } from '@itharbors/kit-core';

export async function discoverKits({ rootDir, requestedKit, installedKits = [] } = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('rootDir is required');
  }

  const catalog = await discoverRepositoryKits(rootDir);
  for (const installedKit of installedKits) {
    const result = await readKitEntry(installedKit?.directory, 'installed', installedKit);
    if (result.status !== 'valid') {
      throw new Error(`Installed Kit ${installedKit?.id ?? '<unknown>'} is ${result.status}: ${result.reason ?? installedKit?.directory ?? '<unknown>'}`);
    }
    catalog.push(result.entry);
  }
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

  const explicitEntry = await readKitEntry(requestedPath, 'explicit');
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
    const result = await readKitEntry(path.join(kitsDir, directory.name), 'builtin');
    if (result.status === 'valid') {
      catalog.push(result.entry);
    }
  }
  return catalog;
}

async function readKitEntry(directory, source, installedSource) {
  if (typeof directory !== 'string' || directory.length === 0) {
    return { status: 'missing', reason: 'directory is required' };
  }
  const manifestPath = path.join(directory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 'missing', reason: `directory does not exist: ${directory}` };
    }
    return { status: 'invalid', reason: 'package.json is not valid JSON' };
  }

  const reason = validateManifest(manifest);
  if (reason) {
    return { status: 'invalid', reason };
  }

  let version = manifest.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    return { status: 'invalid', reason: 'version is required' };
  }
  if (source === 'installed') {
    if (!installedSource || installedSource.source !== 'installed' || !/^[a-f0-9]{64}$/u.test(installedSource.digest ?? '')) {
      return { status: 'invalid', reason: 'installed source metadata is invalid' };
    }
    let publication;
    try {
      publication = parseKitPackageManifest(JSON.parse(
        await readFile(path.join(directory, 'kit.json'), 'utf8'),
      ));
    } catch (error) {
      return { status: 'invalid', reason: `kit.json is invalid: ${error.message}` };
    }
    if (publication.id !== installedSource.id
      || publication.version !== installedSource.version
      || manifest.name !== installedSource.id
      || manifest.version !== installedSource.version) {
      return { status: 'invalid', reason: 'installed Kit identity does not match active source metadata' };
    }
    version = publication.version;
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
      source,
      version,
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
