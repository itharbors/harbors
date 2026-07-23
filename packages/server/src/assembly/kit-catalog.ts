import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PublicKitCatalogEntry } from '@itharbors/plugin-types';
import type { AssemblyConfig } from './config';
import { resolveKit } from '../plugin/resolver';

export interface KitCatalogEntry extends PublicKitCatalogEntry {
  directory: string;
  source: 'builtin' | 'installed' | 'explicit';
}

export async function discoverKitCatalog(assembly: AssemblyConfig): Promise<KitCatalogEntry[]> {
  const directories = new Map<string, KitCatalogEntry['source']>();
  for (const kitsDirectory of new Set([
    path.resolve(assembly.builtinKitsDir),
    path.resolve(assembly.kitsDir),
  ])) {
    let children;
    try {
      children = await readdir(kitsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingDirectory(error)) continue;
      throw error;
    }
    for (const child of children) {
      if (child.isDirectory()) directories.set(path.join(kitsDirectory, child.name), 'builtin');
    }
  }
  for (const installedDirectory of assembly.installedKitDirs) {
    directories.set(path.resolve(installedDirectory), 'installed');
  }

  const selectedDirectory = path.resolve(await resolveKit(assembly.defaultKit, {
    builtinKitsDir: assembly.builtinKitsDir,
    kitsDir: assembly.kitsDir,
    installedKitDirs: assembly.installedKitDirs,
  }));
  if (!directories.has(selectedDirectory)) directories.set(selectedDirectory, 'explicit');

  const entries: KitCatalogEntry[] = [];
  for (const [directory, source] of directories) {
    const entry = await readKitEntry(directory, source);
    if (entry) {
      entries.push(entry);
    } else if (source === 'installed') {
      throw new Error(`Invalid installed Kit manifest at ${directory}`);
    } else if (directory === selectedDirectory) {
      throw new Error(`Invalid Kit manifest for selected Kit "${assembly.defaultKit}"`);
    }
  }
  entries.sort(compareEntries);
  assertUnique(entries, (entry) => entry.name, 'Duplicate Kit package name');
  assertUnique(entries, (entry) => entry.id, 'Duplicate Kit menu root');
  return entries;
}

async function readKitEntry(
  directory: string,
  source: KitCatalogEntry['source'],
): Promise<KitCatalogEntry | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(manifest) || !isNonEmptyString(manifest.name)) return null;
  const editor = manifest['ce-editor'];
  if (!isRecord(editor) || !isRecord(editor.kit)) return null;
  const kit = editor.kit;
  if (!isRecord(kit.menuRoot)) return null;
  if (!isNonEmptyString(kit.menuRoot.id) || !isNonEmptyString(kit.menuRoot.label)) return null;
  if (!isRecord(kit.layouts) || !isNonEmptyString(kit.layouts.default)) return null;
  if (!isRecord(kit.windowEntries)
    || !isNonEmptyString(kit.windowEntries.main)
    || !isNonEmptyString(kit.windowEntries.secondary)) return null;

  return {
    id: kit.menuRoot.id,
    name: manifest.name,
    label: kit.menuRoot.label,
    directory: path.resolve(directory),
    source,
  };
}

function compareEntries(left: KitCatalogEntry, right: KitCatalogEntry): number {
  return left.label.localeCompare(right.label) || left.name.localeCompare(right.name);
}

function assertUnique(
  entries: KitCatalogEntry[],
  select: (entry: KitCatalogEntry) => string,
  message: string,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = select(entry);
    if (seen.has(value)) throw new Error(`${message}: ${value}`);
    seen.add(value);
  }
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
