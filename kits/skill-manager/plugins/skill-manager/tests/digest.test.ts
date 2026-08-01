import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { digestSkillDirectory } from '../main/src/digest.ts';

const roots: string[] = [];
const limits = { maxFiles: 20, maxFileBytes: 1024, maxTotalBytes: 4096 };

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }));
});

describe('digestSkillDirectory', () => {
  it('hashes sorted relative paths and bytes deterministically', async () => {
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    await writeTree(first, [['b.txt', 'two'], ['nested/a.txt', 'one']]);
    await writeTree(second, [['nested/a.txt', 'one'], ['b.txt', 'two']]);

    const left = await digestSkillDirectory(first, limits);
    const right = await digestSkillDirectory(second, limits);

    expect(left).toEqual(right);
    expect(left.files).toEqual(['b.txt', 'nested/a.txt']);
    expect(left.totalBytes).toBe(6);
    expect(left.value).toMatch(/^[a-f0-9]{64}$/u);

    await writeFile(path.join(second, 'b.txt'), 'changed');
    await expect(digestSkillDirectory(second, limits)).resolves.not.toEqual(left);
  });

  it('rejects symlinks anywhere inside a candidate', async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'regular.txt'), 'safe');
    await symlink(path.join(root, 'regular.txt'), path.join(root, 'linked.txt'));

    await expect(digestSkillDirectory(root, limits)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });

  it.runIf(process.platform !== 'win32')('rejects special files inside a candidate', async () => {
    const root = await temporaryRoot();
    const socketPath = path.join(root, 'local.socket');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(digestSkillDirectory(root, limits)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it.each([
    ['file count', { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 4096 }],
    ['single file bytes', { maxFiles: 20, maxFileBytes: 2, maxTotalBytes: 4096 }],
    ['total bytes', { maxFiles: 20, maxFileBytes: 1024, maxTotalBytes: 5 }],
  ])('enforces the %s limit', async (_label, bounded) => {
    const root = await temporaryRoot();
    await writeTree(root, [['one.txt', 'one'], ['two.txt', 'two']]);

    await expect(digestSkillDirectory(root, bounded)).rejects.toMatchObject({
      code: 'SCAN_LIMIT',
    });
  });

  it('honors cancellation before reading the directory', async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(digestSkillDirectory(root, limits, controller.signal)).rejects.toMatchObject({
      code: 'SCAN_CANCELLED',
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'skill-manager-digest-'));
  roots.push(root);
  return root;
}

async function writeTree(root: string, entries: Array<[string, string]>): Promise<void> {
  for (const [name, value] of entries) {
    const filename = path.join(root, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, value);
  }
}
