import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateCreateTarget } from '../main/src/file-browser';

describe('SQLite create target policy', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-create-target-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes a missing database name without allowing traversal', () => {
    expect(validateCreateTarget({ directory: tempDir, fileName: 'fresh' })).toEqual({
      path: path.join(fs.realpathSync(tempDir), 'fresh.sqlite'),
      existingEmptyFile: false,
    });
    expect(validateCreateTarget({ directory: tempDir, fileName: 'fresh.sqlite3' })).toEqual({
      path: path.join(fs.realpathSync(tempDir), 'fresh.sqlite3'),
      existingEmptyFile: false,
    });
    expect(() => validateCreateTarget({ directory: tempDir, fileName: '../escape' })).toThrow(
      /文件名/,
    );
  });

  it('accepts an existing zero-byte regular file created by a browser save picker', () => {
    const target = path.join(tempDir, 'new.sqlite');
    fs.writeFileSync(target, '');

    expect(validateCreateTarget({ directory: tempDir, fileName: 'new.sqlite' })).toEqual({
      path: fs.realpathSync(target),
      existingEmptyFile: true,
    });
  });

  it('rejects non-empty files, directories, and symbolic links', () => {
    const nonEmpty = path.join(tempDir, 'existing.sqlite');
    const directory = path.join(tempDir, 'directory.sqlite');
    const empty = path.join(tempDir, 'empty.sqlite');
    const symbolicLink = path.join(tempDir, 'linked.sqlite');
    fs.writeFileSync(nonEmpty, 'existing data');
    fs.mkdirSync(directory);
    fs.writeFileSync(empty, '');
    fs.symlinkSync(empty, symbolicLink);

    expect(() => validateCreateTarget({ directory: tempDir, fileName: 'existing.sqlite' }))
      .toThrow(/已经存在/);
    expect(() => validateCreateTarget({ directory: tempDir, fileName: 'directory.sqlite' }))
      .toThrow(/已经存在/);
    expect(() => validateCreateTarget({ directory: tempDir, fileName: 'linked.sqlite' }))
      .toThrow(/已经存在/);
  });

  it('rejects an inaccessible or non-directory parent', () => {
    const fileParent = path.join(tempDir, 'file-parent');
    fs.writeFileSync(fileParent, 'x');

    expect(() => validateCreateTarget({ directory: path.join(tempDir, 'missing'), fileName: 'x' }))
      .toThrow(/无法访问/);
    expect(() => validateCreateTarget({ directory: fileParent, fileName: 'x' }))
      .toThrow(/不是文件夹/);
  });
});
