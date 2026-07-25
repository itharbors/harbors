import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertTemporarySpace,
  listDirectory,
  validateSourcePath,
} from '../main/src/file-policy.js';

describe('CSV source file policy', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-file-policy-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts regular files independently of their extension and normalizes the path', async () => {
    const source = path.join(directory, 'records.data');
    fs.writeFileSync(source, 'a,b\n1,2\n');

    const result = await validateSourcePath(path.join(directory, '.', 'records.data'));

    expect(result.path).toBe(path.resolve(source));
    expect(result.size).toBe(8);
  });

  it('rejects directories and symbolic links', async () => {
    const source = path.join(directory, 'records.csv');
    const link = path.join(directory, 'records-link.csv');
    fs.writeFileSync(source, 'a,b\n');
    fs.symlinkSync(source, link);

    await expect(validateSourcePath(directory)).rejects.toMatchObject({ code: 'NOT_REGULAR_FILE' });
    await expect(validateSourcePath(link)).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' });
  });

  it('rejects files larger than 2 GiB through an injected lstat adapter', async () => {
    await expect(validateSourcePath('/virtual/large.csv', {
      lstat: async () => ({
        isSymbolicLink: () => false,
        isFile: () => true,
        size: (2 * 1024 * 1024 * 1024) + 1,
        mtime: new Date(0),
      }),
    })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rejects indexing when temporary free space cannot cover the source and margin', async () => {
    await expect(assertTemporarySpace(directory, 1024, {
      statfs: async () => ({ bavail: 1, bsize: 1024 }),
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_TEMP_SPACE' });
  });

  it('lists directories and CSV candidates without following symlink entries', async () => {
    fs.mkdirSync(path.join(directory, 'nested'));
    fs.writeFileSync(path.join(directory, 'records.csv'), '');
    fs.writeFileSync(path.join(directory, 'notes.md'), '');
    fs.symlinkSync(path.join(directory, 'records.csv'), path.join(directory, 'linked.csv'));

    const listing = await listDirectory({ path: directory });

    expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['nested', 'directory'],
      ['records.csv', 'file'],
    ]);
  });
});
