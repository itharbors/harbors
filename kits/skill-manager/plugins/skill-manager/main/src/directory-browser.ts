import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  assertDirectoryIdentity,
  canonicalDirectory,
  isPathWithin,
  type DirectoryIdentity,
} from './safe-path.ts';
import { SkillManagerError } from './types.ts';

export type DirectoryPage = {
  current: { id: string; label: string };
  parentId?: string;
  children: Array<{ id: string; name: string }>;
};

export type DirectorySelection = {
  directory: string;
  displayPath: string;
};

export type DirectoryBrowser = {
  open(id?: string): Promise<DirectoryPage>;
  resolveSelection(id: string): Promise<DirectorySelection>;
};

type Capability = {
  id: string;
  directory: string;
  identity: DirectoryIdentity;
};

export async function createDirectoryBrowser(options: {
  homeDirectory: string;
  filesystemRoots: string[];
}): Promise<DirectoryBrowser> {
  if (!Array.isArray(options.filesystemRoots) || options.filesystemRoots.length === 0) {
    throw new TypeError('filesystemRoots must contain at least one directory');
  }

  const roots = await Promise.all(options.filesystemRoots.map(async (root) => (
    (await canonicalDirectory(root)).directory
  )));
  const home = await canonicalDirectory(options.homeDirectory);
  if (!roots.some((root) => isPathWithin(root, home.directory))) {
    throw new SkillManagerError('UNSAFE_PATH', 'Home directory is outside configured filesystem roots');
  }

  const capabilities = new Map<string, Capability>();
  const currentIdByPath = new Map<string, string>();
  const homeCapability = issueCapability(home.directory, home.identity);

  return Object.freeze({
    async open(id?: string): Promise<DirectoryPage> {
      const current = await resolveCapability(id ?? homeCapability.id);
      const entries = await readDirectoryEntries(current.directory);
      const children: Array<{ id: string; name: string }> = [];
      for (const entry of entries) {
        const childPath = path.join(current.directory, entry.name);
        let stat;
        try {
          stat = await lstat(childPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const child = issueCapability(childPath, { dev: stat.dev, ino: stat.ino });
        children.push({ id: child.id, name: entry.name });
      }
      await assertDirectoryIdentity(current.directory, current.identity);

      const parent = await parentCapability(current.directory);
      return {
        current: { id: current.id, label: displayPath(current.directory) },
        ...(parent ? { parentId: parent.id } : {}),
        children,
      };
    },

    async resolveSelection(id: string): Promise<DirectorySelection> {
      const capability = await resolveCapability(id);
      return {
        directory: capability.directory,
        displayPath: displayPath(capability.directory),
      };
    },
  });

  function issueCapability(directory: string, identity: DirectoryIdentity): Capability {
    const existingId = currentIdByPath.get(directory);
    const existing = existingId ? capabilities.get(existingId) : undefined;
    if (
      existing
      && existing.identity.dev === identity.dev
      && existing.identity.ino === identity.ino
    ) return existing;

    let id = randomUUID();
    while (capabilities.has(id)) id = randomUUID();
    const capability = Object.freeze({ id, directory, identity: Object.freeze({ ...identity }) });
    capabilities.set(id, capability);
    currentIdByPath.set(directory, id);
    return capability;
  }

  async function resolveCapability(id: string): Promise<Capability> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SkillManagerError('UNSAFE_PATH', 'Directory capability is required');
    }
    const capability = capabilities.get(id);
    if (!capability) {
      throw new SkillManagerError('UNSAFE_PATH', 'Directory capability is unknown or expired');
    }
    await assertDirectoryIdentity(capability.directory, capability.identity);
    return capability;
  }

  async function parentCapability(directory: string): Promise<Capability | undefined> {
    if (roots.some((root) => root === directory)) return undefined;
    const parent = path.dirname(directory);
    if (parent === directory || !roots.some((root) => isPathWithin(root, parent))) return undefined;
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      return issueCapability(parent, { dev: stat.dev, ino: stat.ino });
    } catch {
      return undefined;
    }
  }

  function displayPath(directory: string): string {
    if (directory === home.directory) return '~';
    if (isPathWithin(home.directory, directory)) {
      const relative = path.relative(home.directory, directory).split(path.sep).join('/');
      return `~/${relative}`;
    }
    return directory;
  }
}

async function readDirectoryEntries(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.sort((left, right) => compareText(left.name, right.name));
  } catch (caught) {
    throw new SkillManagerError('UNSAFE_PATH', 'Directory cannot be listed', { cause: caught });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
