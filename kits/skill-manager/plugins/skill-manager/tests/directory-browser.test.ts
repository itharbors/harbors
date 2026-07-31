import { mkdir, mkdtemp, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDirectoryBrowser } from '../main/src/directory-browser.ts';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createDirectoryBrowser', () => {
  it('opens home with sorted directory-only children and capability navigation', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    await mkdir(path.join(home, 'zeta'), { recursive: true });
    await mkdir(path.join(home, 'alpha'));
    await writeFile(path.join(home, 'note.txt'), 'not a directory');
    const browser = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });

    const page = await browser.open();

    expect(page.current.label).toBe('~');
    expect(page.children.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
    expect(page).not.toHaveProperty('directory');
    expect(JSON.stringify(page)).not.toContain(home);

    const child = await browser.open(page.children[0].id);
    expect(child.current.label).toBe('~/alpha');
    expect(child.parentId).toBe(page.current.id);
    await expect(browser.open(child.parentId)).resolves.toMatchObject({
      current: { id: page.current.id, label: '~' },
    });

    const selection = await browser.resolveSelection(page.children[0].id);
    expect(selection).toEqual({
      directory: await realpath(path.join(home, 'alpha')),
      displayPath: '~/alpha',
    });
  });

  it('rejects forged and cross-instance directory IDs', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    await mkdir(home);
    const first = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });
    const second = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });
    const firstPage = await first.open();

    await expect(first.open('forged-directory-id')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(second.open(firstPage.current.id)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(second.resolveSelection(firstPage.current.id)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });

  it('excludes symlinked directories from issued capabilities', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside');
    await mkdir(home);
    await mkdir(outside);
    await symlink(outside, path.join(home, 'linked'));
    const browser = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });

    const page = await browser.open();

    expect(page.children).toEqual([]);
  });

  it('rejects a capability after its directory inode is replaced', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    const selected = path.join(home, 'selected');
    await mkdir(selected, { recursive: true });
    const browser = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });
    const page = await browser.open();
    const selectedId = page.children[0].id;

    await rename(selected, path.join(home, 'original'));
    await mkdir(selected);

    await expect(browser.open(selectedId)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(browser.resolveSelection(selectedId)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects a preserved child inode reached through a replaced symlink ancestor', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    await mkdir(path.join(home, 'selected'), { recursive: true });
    const browser = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });
    const selectedId = (await browser.open()).children[0].id;

    const movedHome = path.join(root, 'moved-home');
    await rename(home, movedHome);
    await symlink(movedHome, home);

    await expect(browser.resolveSelection(selectedId)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('does not issue parent navigation above configured filesystem roots', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    await mkdir(home);
    const browser = await createDirectoryBrowser({ homeDirectory: home, filesystemRoots: [root] });

    const homePage = await browser.open();
    const rootPage = await browser.open(homePage.parentId);

    expect(rootPage.current.label).toBe(await realpath(root));
    expect(rootPage.parentId).toBeUndefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'skill-manager-browser-'));
  roots.push(root);
  return root;
}
