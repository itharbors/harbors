import { afterEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPluginPaths } from '@itharbors/plugin';

const temporaryRoots: string[] = [];

async function makeRoots() {
  const applicationData = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-paths-'));
  temporaryRoots.push(applicationData);
  return {
    applicationData,
    data: path.join(applicationData, 'plugins', 'data'),
    cache: path.join(applicationData, 'plugins', 'cache'),
    temp: path.join(applicationData, 'plugins', 'temp'),
  };
}

function openFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
}

async function openDirectory(candidate: string) {
  const handle = await open(candidate, openFlags());
  return {
    fd: handle.fd,
    stat: () => handle.stat(),
    fchmod: (mode: number) => handle.chmod(mode),
    close: () => handle.close(),
  };
}

describe('createPluginPaths', () => {
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('creates stable private directories keyed by the exact plugin owner', async () => {
    const roots = await makeRoots();

    const first = await createPluginPaths({
      roots,
      owner: '@itharbors/agent-guard-background',
      legacyDataDirectories: ['agent-guard'],
    });
    const repeated = await createPluginPaths({
      roots,
      owner: '@itharbors/agent-guard-background',
      legacyDataDirectories: ['agent-guard'],
    });
    const second = await createPluginPaths({
      roots,
      owner: '@itharbors/scheduler-service',
      legacyDataDirectories: [],
    });

    expect(first).toEqual(repeated);
    expect(path.basename(first.data)).toBe('42dc4fbdc4904f7871ce76c21caa6c7a903e45e221ca028c41d0793a286e1027');
    expect(path.basename(second.data)).toBe('b5f30c4c99b41f9e660664fa62a68a431bbfe5ab2d9c29ec6d1ee10ca509b29a');
    expect(first.data).not.toBe(second.data);
    expect(first.cache).not.toBe(second.cache);
    expect(first.temp).not.toBe(second.temp);
    expect(first.legacyData).toEqual([path.join(roots.applicationData, 'agent-guard')]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.legacyData)).toBe(true);

    for (const directory of [first.data, first.cache, first.temp]) {
      expect((await lstat(directory)).isDirectory()).toBe(true);
      expect((await lstat(directory)).isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') {
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      }
    }
    await expect(lstat(first.legacyData[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never exposes a raw scoped owner as path traversal', async () => {
    const roots = await makeRoots();
    const result = await createPluginPaths({
      roots,
      owner: '@scope/../../foreign-plugin',
      legacyDataDirectories: [],
    });

    for (const [root, directory] of [
      [roots.data, result.data],
      [roots.cache, result.cache],
      [roots.temp, result.temp],
    ]) {
      expect(path.relative(root, directory).startsWith('..')).toBe(false);
      expect(directory).not.toContain('@scope');
    }
  });

  it('rejects symlinked roots before creating owner directories', async () => {
    const roots = await makeRoots();
    const actualData = path.join(roots.applicationData, 'actual-data');
    await mkdir(actualData);
    await mkdir(path.dirname(roots.data), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(actualData, roots.data, 'dir');

    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: [],
    })).rejects.toThrow(/plugin storage unavailable/iu);
    expect(await lstat(actualData)).toMatchObject({});
  });

  it('rejects existing legacy symlinks and non-directory entries', async () => {
    const roots = await makeRoots();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-legacy-outside-'));
    temporaryRoots.push(outside);
    await symlink(outside, path.join(roots.applicationData, 'legacy-link'), 'dir');
    await writeFile(path.join(roots.applicationData, 'legacy-file'), 'not a directory');

    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: ['legacy-link'],
    })).rejects.toThrow(/plugin storage unavailable/iu);
    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: ['legacy-file'],
    })).rejects.toThrow(/plugin storage unavailable/iu);
  });

  it('fails closed when a newly created path component is swapped with a symlink', async () => {
    const roots = await makeRoots();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-swap-outside-'));
    temporaryRoots.push(outside);
    let swapped = false;
    let postSwapMkdirCount = 0;
    let postSwapChmodCount = 0;
    const fileSystem = {
      lstat,
      openDirectory,
      async mkdir(candidate: string, options: Parameters<typeof mkdir>[1]) {
        if (swapped) postSwapMkdirCount += 1;
        await mkdir(candidate, options);
        const plugins = path.join(roots.applicationData, 'plugins');
        if (!swapped && candidate === plugins) {
          swapped = true;
          await rename(plugins, `${plugins}-original`);
          await symlink(outside, plugins, 'dir');
        }
      },
      async chmod(candidate: string, mode: number) {
        if (swapped) postSwapChmodCount += 1;
        await chmod(candidate, mode);
      },
      realpath: (candidate: string) => import('node:fs/promises').then((fs) => fs.realpath(candidate)),
    };

    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: [],
    }, fileSystem)).rejects.toThrow(/plugin storage unavailable/iu);
    expect(swapped).toBe(true);
    expect(postSwapMkdirCount).toBe(0);
    expect(postSwapChmodCount).toBe(0);
    await expect(lstat(path.join(outside, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects a parent-path swap during data mkdir without attempting pathname cleanup', async () => {
    const roots = await makeRoots();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-mkdir-race-'));
    temporaryRoots.push(outside);
    await mkdir(path.join(roots.applicationData, 'plugins'), { mode: 0o700 });
    let swapped = false;
    const fileSystem = {
      lstat,
      realpath,
      openDirectory,
      chmod,
      async mkdir(candidate: string, options: { mode: number }) {
        if (!swapped && path.basename(candidate) === 'data') {
          swapped = true;
          const plugins = path.join(roots.applicationData, 'plugins');
          await rename(plugins, `${plugins}-original`);
          await symlink(outside, plugins, 'dir');
        }
        await mkdir(candidate, options);
      },
    };

    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: [],
    }, fileSystem)).rejects.toThrow(/plugin storage unavailable/iu);
    expect(swapped).toBe(true);
    expect((await lstat(path.join(outside, 'data'))).isDirectory()).toBe(true);
  });

  it('fchmods the opened directory inode when its normal path is swapped', async () => {
    const roots = await makeRoots();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-chmod-race-'));
    temporaryRoots.push(outside);
    await chmod(outside, 0o755);
    let swapped = false;
    const fileSystem = {
      lstat,
      realpath,
      mkdir,
      chmod,
      async openDirectory(candidate: string) {
        const handle = await openDirectory(candidate);
        return {
          ...handle,
          async fchmod(mode: number) {
            if (!swapped && path.basename(candidate) === 'data') {
              swapped = true;
              const data = path.join(roots.applicationData, 'plugins', 'data');
              await rename(data, `${data}-original`);
              await symlink(outside, data, 'dir');
            }
            await handle.fchmod(mode);
          },
        };
      },
    };

    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: [],
    }, fileSystem)).rejects.toThrow(/plugin storage unavailable/iu);
    expect(swapped).toBe(true);
    expect((await stat(outside)).mode & 0o777).toBe(0o755);
  });

  it('rejects unsafe or non-absolute inputs without leaking another root', async () => {
    const roots = await makeRoots();

    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: ['../foreign'],
    })).rejects.toThrow(/plugin storage unavailable/iu);
    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: ['foreign\\directory'],
    })).rejects.toThrow(/plugin storage unavailable/iu);
    await expect(createPluginPaths({
      roots,
      owner: '@itharbors/plugin',
      legacyDataDirectories: ['duplicate', 'duplicate'],
    })).rejects.toThrow(/plugin storage unavailable/iu);
    await expect(createPluginPaths({
      roots: { ...roots, cache: 'relative/cache' },
      owner: '@itharbors/plugin',
      legacyDataDirectories: [],
    })).rejects.toThrow(/plugin storage unavailable/iu);
  });
});
