import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCodexSkillInstaller,
} from '../main/src/codex-skill-installer';

const tempRoots: string[] = [];

describe('Codex Skill installer', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => (
      rm(root, { recursive: true, force: true })
    )));
  });

  it('installs the bundled Skill atomically and reports the current version on repeat', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome });

    const installed = await installer.install();

    expect(installed).toMatchObject({
      status: 'installed',
      destination: path.join(codexHome, 'skills', 'notify-user'),
    });
    expect(installed.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(path.join(installed.destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: initial');
    await expect(readFile(path.join(installed.destination, 'scripts', 'notify.mjs'), 'utf8'))
      .resolves.toContain('initial');
    await expect(readMarker(installed.destination)).resolves.toEqual({
      owner: 'itharbors',
      skill: 'notify-user',
      digest: installed.digest,
      version: 1,
    });

    await expect(installer.install()).resolves.toEqual({
      ...installed,
      status: 'current',
    });
    await expect(listInstallerArtifacts(path.join(codexHome, 'skills'))).resolves.toEqual([]);
  });

  it('updates a Harbors-managed Skill when the bundled content changes', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome });
    const initial = await installer.install();
    await writeSkillSource(sourceDir, 'updated');

    const updated = await installer.install();

    expect(updated.status).toBe('updated');
    expect(updated.digest).not.toBe(initial.digest);
    await expect(readFile(path.join(updated.destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: updated');
    await expect(readMarker(updated.destination)).resolves.toMatchObject({ digest: updated.digest });
    await expect(listInstallerArtifacts(path.join(codexHome, 'skills'))).resolves.toEqual([]);
  });

  it('preserves an unmarked same-name Skill as a conflict', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const destination = path.join(codexHome, 'skills', 'notify-user');
    await writeSkillSource(sourceDir, 'bundled');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'SKILL.md'), 'custom user Skill\n', 'utf8');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8'))
      .resolves.toBe('custom user Skill\n');
  });

  it('does not overwrite user modifications inside a managed installation', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome });
    const installed = await installer.install();
    const scriptPath = path.join(installed.destination, 'scripts', 'notify.mjs');
    await writeFile(scriptPath, '// user modification\n', 'utf8');

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(scriptPath, 'utf8')).resolves.toBe('// user modification\n');
  });

  it('rejects symbolic links in the source or at the destination', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'bundled');
    await symlink(path.join(sourceDir, 'SKILL.md'), path.join(sourceDir, 'linked-skill'));
    const sourceLinkInstaller = createCodexSkillInstaller({ sourceDir, codexHome });

    await expect(sourceLinkInstaller.install()).rejects.toMatchObject({
      code: 'SKILL_SOURCE_INVALID',
    });

    await rm(path.join(sourceDir, 'linked-skill'));
    const target = path.join(root, 'outside-target');
    await mkdir(path.join(codexHome, 'skills'), { recursive: true });
    await mkdir(target);
    await symlink(target, path.join(codexHome, 'skills', 'notify-user'));
    const destinationLinkInstaller = createCodexSkillInstaller({ sourceDir, codexHome });

    await expect(destinationLinkInstaller.install()).rejects.toMatchObject({
      code: 'SKILL_UNSAFE_PATH',
    });
  });

  it('reuses one in-flight Promise for concurrent menu clicks', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'concurrent');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome });

    const first = installer.install();
    const second = installer.install();
    const samePromise = second === first;
    const results = await Promise.allSettled([first, second]);

    expect(samePromise).toBe(true);
    expect(results).toEqual([
      { status: 'fulfilled', value: expect.objectContaining({ status: 'installed' }) },
      { status: 'fulfilled', value: expect.objectContaining({ status: 'installed' }) },
    ]);
  });

  it('restores the previous managed Skill when the atomic update cannot be committed', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const initialInstaller = createCodexSkillInstaller({ sourceDir, codexHome });
    const initial = await initialInstaller.install();
    await writeSkillSource(sourceDir, 'updated');
    let renameCalls = 0;
    const failingInstaller = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async rename(from, to) {
        renameCalls += 1;
        if (renameCalls === 2) {
          const error = new Error('simulated update failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await rename(from, to);
      },
    });

    await expect(failingInstaller.install()).rejects.toThrow('simulated update failure');
    await expect(readFile(path.join(initial.destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: initial');
    await expect(readMarker(initial.destination)).resolves.toMatchObject({ digest: initial.digest });
    await expect(listInstallerArtifacts(path.join(codexHome, 'skills'))).resolves.toEqual([]);
  });
});

async function createTempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-skill-installer-'));
  tempRoots.push(root);
  return root;
}

async function writeSkillSource(sourceDir: string, marker: string) {
  await mkdir(path.join(sourceDir, 'agents'), { recursive: true });
  await mkdir(path.join(sourceDir, 'scripts'), { recursive: true });
  await writeFile(
    path.join(sourceDir, 'SKILL.md'),
    `---\nname: notify-user\ndescription: ${marker}\n---\n`,
    'utf8',
  );
  await writeFile(path.join(sourceDir, 'agents', 'openai.yaml'), `display_name: ${marker}\n`, 'utf8');
  await writeFile(path.join(sourceDir, 'scripts', 'notify.mjs'), `// ${marker}\n`, 'utf8');
}

async function readMarker(destination: string) {
  return JSON.parse(await readFile(path.join(destination, '.harbors-skill.json'), 'utf8'));
}

async function listInstallerArtifacts(parent: string) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(parent);
  return entries.filter((entry) => (
    entry.startsWith('.notify-user-install-') || entry.startsWith('.notify-user-backup-')
  ));
}
