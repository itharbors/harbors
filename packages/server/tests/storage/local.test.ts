import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocalStorageBackend } from '../../src/storage/local';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('LocalStorageBackend', () => {
  let backend: LocalStorageBackend;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = path.join(os.tmpdir(), `editor-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    backend = new LocalStorageBackend();
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads a file', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    const content = Buffer.from('hello world');

    await backend.write(filePath, content);
    const result = await backend.read(filePath);

    expect(result.toString()).toBe('hello world');
  });

  it('lists directory entries', async () => {
    const subDir = path.join(tmpDir, 'sub');
    await fs.mkdir(subDir);
    await backend.write(path.join(tmpDir, 'a.txt'), Buffer.from('a'));
    await backend.write(path.join(tmpDir, 'b.txt'), Buffer.from('b'));

    const entries = await backend.list(tmpDir);

    expect(entries.some(e => e.name === 'sub' && e.isDirectory)).toBe(true);
    expect(entries.some(e => e.name === 'a.txt' && !e.isDirectory)).toBe(true);
    expect(entries.some(e => e.name === 'b.txt' && !e.isDirectory)).toBe(true);
  });

  it('stats a file', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');

    const stat = await backend.stat(filePath);

    expect(stat.size).toBe(11);
    expect(stat.isDirectory).toBe(false);
  });

  it('deletes a file', async () => {
    const filePath = path.join(tmpDir, 'delete-me.txt');
    await backend.write(filePath, Buffer.from('tmp'));

    await backend.delete(filePath);

    await expect(fs.access(filePath)).rejects.toThrow();
  });
});