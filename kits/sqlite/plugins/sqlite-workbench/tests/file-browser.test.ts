import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectory, validateCreateTarget } from '../main/src/file-browser';

describe('SQLite controlled file browser', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-browser-'));
    fs.mkdirSync(path.join(tempDir, 'A-folder'));
    fs.mkdirSync(path.join(tempDir, 'z-folder'));
    fs.writeFileSync(path.join(tempDir, 'data.db'), 'db');
    fs.writeFileSync(path.join(tempDir, 'records.sqlite'), 'sqlite');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'notes');
    fs.symlinkSync(path.join(tempDir, 'data.db'), path.join(tempDir, 'alias.sqlite'));
    fs.symlinkSync(path.join(tempDir, 'missing.sqlite'), path.join(tempDir, 'broken.sqlite'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists directories before SQLite files and hides unrelated files by default', () => {
    const listing = listDirectory({ path: tempDir });

    expect(listing.currentPath).toBe(fs.realpathSync(tempDir));
    expect(listing.parentPath).toBe(fs.realpathSync(path.dirname(tempDir)));
    expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['A-folder', 'directory'],
      ['z-folder', 'directory'],
      ['alias.sqlite', 'file'],
      ['data.db', 'file'],
      ['records.sqlite', 'file'],
    ]);
    expect(listing.entries.find((entry) => entry.name === 'data.db')).toMatchObject({
      path: path.join(fs.realpathSync(tempDir), 'data.db'),
      sqliteCandidate: true,
      size: 2,
    });
    expect(listing.entries.find((entry) => entry.name === 'data.db')?.modifiedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('shows ordinary files on request and omits broken symbolic links', () => {
    const names = listDirectory({ path: tempDir, showAll: true }).entries.map((entry) => entry.name);

    expect(names).toContain('notes.txt');
    expect(names).not.toContain('broken.sqlite');
  });

  it('rejects a path that is not a directory', () => {
    expect(() => listDirectory({ path: path.join(tempDir, 'data.db') })).toThrow(
      /不是文件夹/,
    );
  });

  it('normalizes new database names without allowing overwrite or traversal', () => {
    expect(validateCreateTarget({ directory: tempDir, fileName: 'fresh' })).toBe(
      path.join(fs.realpathSync(tempDir), 'fresh.sqlite'),
    );
    expect(validateCreateTarget({ directory: tempDir, fileName: 'fresh.sqlite3' })).toBe(
      path.join(fs.realpathSync(tempDir), 'fresh.sqlite3'),
    );
    expect(() => validateCreateTarget({ directory: tempDir, fileName: 'data.db' })).toThrow(
      /已经存在/,
    );
    expect(() => validateCreateTarget({ directory: tempDir, fileName: '../escape' })).toThrow(
      /文件名/,
    );
  });
});
