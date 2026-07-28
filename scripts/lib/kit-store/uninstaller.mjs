import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { encodeKitId } from '@itharbors/kit-core';

async function optionalStat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function requireDirectoryIdentity(actual, expected) {
  if (path.resolve(actual) !== expected) {
    throw new Error('Installed Kit directory identity does not match its version');
  }
}

export class KitArtifactUninstaller {
  constructor({ storeRoot, store }) {
    if (typeof storeRoot !== 'string' || storeRoot.length === 0) {
      throw new TypeError('Kit Store root is required');
    }
    if (!store || typeof store.pendingUninstallDirectories !== 'function') {
      throw new TypeError('Installed Kit Store is required');
    }
    this.storeRoot = path.resolve(storeRoot);
    this.store = store;
  }

  async removeStaged(id) {
    const entries = await this.store.pendingUninstallDirectories(id);
    const kitRoot = path.join(this.storeRoot, 'kits', encodeKitId(id));
    const kitRootInfo = await optionalStat(kitRoot);
    if (kitRootInfo?.isSymbolicLink()) throw new Error('Installed Kit root cannot be a symbolic link');
    if (kitRootInfo && !kitRootInfo.isDirectory()) {
      throw new Error('Installed Kit root must be a directory');
    }

    const validated = [];
    const targets = new Set();
    for (const entry of entries) {
      if (entry?.id !== id || typeof entry.version !== 'string' || typeof entry.directory !== 'string') {
        throw new Error('Installed Kit uninstall record has an invalid identity');
      }
      const expected = path.join(kitRoot, entry.version);
      requireDirectoryIdentity(entry.directory, expected);
      if (targets.has(expected)) throw new Error('Installed Kit uninstall record repeats a directory identity');
      targets.add(expected);
      const info = await optionalStat(expected);
      if (info?.isSymbolicLink()) throw new Error('Installed Kit version cannot be a symbolic link');
      if (info && !info.isDirectory()) throw new Error('Installed Kit version must be a directory');
      validated.push({ version: entry.version, target: expected, exists: Boolean(info) });
    }

    for (const entry of validated) {
      if (entry.exists) await rm(entry.target, { recursive: true });
    }
    if (await optionalStat(kitRoot)) {
      if ((await readdir(kitRoot)).length === 0) await rmdir(kitRoot);
    }
    return { id, removedVersions: validated.map((entry) => entry.version) };
  }
}
