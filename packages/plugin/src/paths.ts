import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';

export interface PluginPathRoots {
  readonly applicationData: string;
  readonly data: string;
  readonly cache: string;
  readonly temp: string;
}

export interface PluginPaths {
  readonly data: string;
  readonly cache: string;
  readonly temp: string;
  readonly legacyData: readonly string[];
}

export interface CreatePluginPathsOptions {
  readonly roots: PluginPathRoots;
  readonly owner: string;
  readonly legacyDataDirectories: readonly string[];
}

export interface PluginPathFileSystem {
  lstat(candidate: string): Promise<Stats>;
  realpath(candidate: string): Promise<string>;
  mkdir(candidate: string, options: { mode: number }): Promise<string | undefined | void>;
  openDirectory(candidate: string): Promise<PluginDirectoryHandle>;
}

export interface PluginDirectoryHandle {
  readonly fd: number;
  stat(): Promise<Stats>;
  fchmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

const defaultFileSystem: PluginPathFileSystem = {
  lstat,
  realpath,
  mkdir,
  async openDirectory(candidate) {
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    return {
      fd: handle.fd,
      stat: () => handle.stat(),
      fchmod: (mode) => handle.chmod(mode),
      close: () => handle.close(),
    };
  },
};

export const PLUGIN_STORAGE_UNAVAILABLE = 'PLUGIN_STORAGE_UNAVAILABLE';

export class PluginStorageUnavailableError extends Error {
  readonly code = PLUGIN_STORAGE_UNAVAILABLE;

  constructor() {
    super('Plugin storage unavailable');
    this.name = 'PluginStorageUnavailableError';
  }
}

export async function createPluginPaths({
  roots,
  owner,
  legacyDataDirectories,
}: CreatePluginPathsOptions, fileSystem: PluginPathFileSystem = defaultFileSystem): Promise<PluginPaths> {
  try {
    const normalizedRoots = normalizeRoots(roots);
    const ownerKey = encodeOwner(owner);
    if (new Set(legacyDataDirectories).size !== legacyDataDirectories.length) {
      throw new PluginStorageUnavailableError();
    }
    const legacyData = legacyDataDirectories.map((directory) => (
      resolveLegacyDirectory(normalizedRoots.applicationData, directory)
    ));

    const applicationIdentity = await observeStableDirectory(
      normalizedRoots.applicationData,
      fileSystem,
    );
    try {
      for (const legacyDirectory of legacyData) {
        const existing = await inspectPath(legacyDirectory, fileSystem);
        if (existing) {
          const legacyIdentity = await observeStableDirectory(
            legacyDirectory,
            fileSystem,
            applicationIdentity.realPath,
          );
          await closeDirectory(legacyIdentity.handle);
        }
      }
    } finally {
      await closeDirectory(applicationIdentity.handle);
    }
    const data = await createPrivateOwnerDirectory(
      normalizedRoots.applicationData, normalizedRoots.data, ownerKey, fileSystem, applicationIdentity.realPath,
    );
    const cache = await createPrivateOwnerDirectory(
      normalizedRoots.applicationData, normalizedRoots.cache, ownerKey, fileSystem, applicationIdentity.realPath,
    );
    const temp = await createPrivateOwnerDirectory(
      normalizedRoots.applicationData, normalizedRoots.temp, ownerKey, fileSystem, applicationIdentity.realPath,
    );
    for (const directory of [data, cache, temp]) {
      const verified = await observeStableDirectory(directory, fileSystem, applicationIdentity.realPath);
      await closeDirectory(verified.handle);
    }

    return Object.freeze({
      data,
      cache,
      temp,
      legacyData: Object.freeze(legacyData),
    });
  } catch (error) {
    if (error instanceof PluginStorageUnavailableError) throw error;
    throw new PluginStorageUnavailableError();
  }
}

function normalizeRoots(roots: PluginPathRoots): PluginPathRoots {
  const applicationData = normalizeAbsolute(roots.applicationData);
  const normalized = {
    applicationData,
    data: normalizeAbsolute(roots.data),
    cache: normalizeAbsolute(roots.cache),
    temp: normalizeAbsolute(roots.temp),
  };
  for (const pluginRoot of [normalized.data, normalized.cache, normalized.temp]) {
    if (!isStrictDescendant(applicationData, pluginRoot)) throw new PluginStorageUnavailableError();
  }
  return normalized;
}

function normalizeAbsolute(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
    throw new PluginStorageUnavailableError();
  }
  return path.resolve(value);
}

function encodeOwner(owner: string): string {
  if (typeof owner !== 'string' || owner.length === 0 || owner.includes('\0')) {
    throw new PluginStorageUnavailableError();
  }
  return createHash('sha256').update(owner, 'utf8').digest('hex');
}

function resolveLegacyDirectory(applicationData: string, directory: string): string {
  if (typeof directory !== 'string'
    || directory.length === 0
    || directory.includes('/')
    || directory.includes('\\')
    || directory.includes('\0')
    || directory === '.'
    || directory === '..'
    || path.isAbsolute(directory)
    || path.basename(directory) !== directory) {
    throw new PluginStorageUnavailableError();
  }
  const resolved = path.resolve(applicationData, directory);
  if (!isStrictDescendant(applicationData, resolved)) throw new PluginStorageUnavailableError();
  return resolved;
}

async function createPrivateOwnerDirectory(
  applicationData: string,
  pluginRoot: string,
  ownerKey: string,
  fileSystem: PluginPathFileSystem,
  applicationRealPath: string,
): Promise<string> {
  await ensurePrivateDirectoryChain(
    applicationData,
    pluginRoot,
    fileSystem,
    applicationRealPath,
  );
  const ownerDirectory = path.join(pluginRoot, ownerKey);
  await ensurePrivateDirectoryChain(
    applicationData,
    ownerDirectory,
    fileSystem,
    applicationRealPath,
  );
  return ownerDirectory;
}

async function ensurePrivateDirectoryChain(
  applicationData: string,
  target: string,
  fileSystem: PluginPathFileSystem,
  applicationRealPath: string,
): Promise<void> {
  const relative = path.relative(applicationData, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PluginStorageUnavailableError();
  }
  let current = applicationData;
  let parentIdentity = await observeStableDirectory(current, fileSystem, applicationRealPath);
  try {
    for (const part of relative.split(path.sep)) {
      const parent = current;
      current = path.join(current, part);
      const entry = await inspectPath(current, fileSystem);
      if (!entry) {
        await assertPathStillReferences(parent, parentIdentity, fileSystem, applicationRealPath);
        const parentBefore = await parentIdentity.handle.stat();
        // Node has no mkdirat API (and Darwin cannot traverse directory FDs via /dev/fd).
        // Keep the parent handle open, detect replacement immediately, and never path-clean on failure.
        await fileSystem.mkdir(current, { mode: 0o700 });
        const parentAfter = await parentIdentity.handle.stat();
        assertSameIdentity(parentBefore, parentAfter);
        await assertPathStillReferences(parent, parentIdentity, fileSystem, applicationRealPath);
      }
      const childIdentity = await observeStableDirectory(current, fileSystem, applicationRealPath);
      try {
        if (process.platform !== 'win32') {
          const beforeChmod = await childIdentity.handle.stat();
          await childIdentity.handle.fchmod(0o700);
          const afterChmod = await childIdentity.handle.stat();
          assertSameIdentity(beforeChmod, afterChmod);
        }
        await closeDirectory(parentIdentity.handle);
        parentIdentity = childIdentity;
      } catch (error) {
        await closeDirectory(childIdentity.handle);
        throw error;
      }
    }
  } finally {
    await closeDirectory(parentIdentity.handle);
  }
}

interface DirectoryIdentity {
  stats: Stats;
  realPath: string;
  handle: PluginDirectoryHandle;
}

async function observeStableDirectory(
  candidate: string,
  fileSystem: PluginPathFileSystem,
  applicationRealPath?: string,
): Promise<DirectoryIdentity> {
  const before = await fileSystem.lstat(candidate);
  assertDirectory(before);
  const handle = await fileSystem.openDirectory(candidate);
  try {
    const opened = await handle.stat();
    assertDirectory(opened);
    assertSameIdentity(before, opened);
    const realPath = await fileSystem.realpath(candidate);
    if (applicationRealPath && !isWithin(applicationRealPath, realPath)) {
      throw new PluginStorageUnavailableError();
    }
    const after = await fileSystem.lstat(candidate);
    assertDirectory(after);
    assertSameIdentity(before, after);
    const openedAfter = await handle.stat();
    assertSameIdentity(opened, openedAfter);
    return { stats: after, realPath, handle };
  } catch (error) {
    await closeDirectory(handle);
    throw error;
  }
}

async function assertPathStillReferences(
  candidate: string,
  expected: DirectoryIdentity,
  fileSystem: PluginPathFileSystem,
  applicationRealPath: string,
): Promise<void> {
  const observed = await observeStableDirectory(candidate, fileSystem, applicationRealPath);
  try {
    assertSameIdentity(expected.stats, observed.stats);
  } finally {
    await closeDirectory(observed.handle);
  }
}

async function closeDirectory(handle: PluginDirectoryHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The storage operation already fails closed; cleanup must not redirect it to a pathname fallback.
  }
}

function assertDirectory(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new PluginStorageUnavailableError();
}

function assertSameIdentity(before: Stats, after: Stats): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new PluginStorageUnavailableError();
  }
}

async function inspectPath(candidate: string, fileSystem: PluginPathFileSystem) {
  try {
    return await fileSystem.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}
