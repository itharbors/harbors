import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_EXTENSION = /\.(?:js|mjs|cjs)$/i;

export type ScriptDirectoryEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
};

export type ScriptDirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  entries: ScriptDirectoryEntry[];
};

export async function listScriptDirectory(input?: unknown): Promise<ScriptDirectoryListing> {
  if (input !== undefined && (typeof input !== 'string' || !input.trim())) {
    throw new TypeError('Script directory must be a non-empty absolute path');
  }
  const requestedPath = typeof input === 'string' ? input.trim() : os.homedir();
  if (!path.isAbsolute(requestedPath)) {
    throw new TypeError('Script directory must be an absolute path');
  }

  const currentPath = await realpath(requestedPath);
  const metadata = await stat(currentPath);
  if (!metadata.isDirectory()) throw new TypeError('Script browser target must be a directory');

  const entries = (await readdir(currentPath, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && (
      entry.isDirectory() || (entry.isFile() && SCRIPT_EXTENSION.test(entry.name))
    ))
    .map<ScriptDirectoryEntry>((entry) => ({
      name: entry.name,
      path: path.join(currentPath, entry.name),
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });

  const parentPath = path.dirname(currentPath);
  return {
    currentPath,
    parentPath: parentPath === currentPath ? null : parentPath,
    entries,
  };
}
