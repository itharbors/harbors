import {
  cp,
  copyFile,
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
    const failingInstaller = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async copyFile(from, to, mode) {
        if (String(from).endsWith(path.join('scripts', 'notify.mjs'))) {
          const error = new Error('simulated update failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await copyFile(from, to, mode);
      },
    });

    await expect(failingInstaller.install()).rejects.toThrow('simulated update failure');
    await expect(readFile(path.join(initial.destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: initial');
    await expect(readMarker(initial.destination)).resolves.toMatchObject({ digest: initial.digest });
    await expect(listInstallerArtifacts(path.join(codexHome, 'skills'))).resolves.toEqual([]);
  });

  it('rejects a CODEX_HOME or skills directory that is a symbolic link', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const outside = path.join(root, 'outside');
    await writeSkillSource(sourceDir, 'bundled');
    await mkdir(outside);
    const linkedHome = path.join(root, 'linked-codex-home');
    await symlink(outside, linkedHome);

    await expect(createCodexSkillInstaller({ sourceDir, codexHome: linkedHome }).install())
      .rejects.toMatchObject({ code: 'SKILL_UNSAFE_PATH' });

    const codexHome = path.join(root, 'codex-home');
    await mkdir(codexHome);
    await symlink(outside, path.join(codexHome, 'skills'));
    await expect(createCodexSkillInstaller({ sourceDir, codexHome }).install())
      .rejects.toMatchObject({ code: 'SKILL_UNSAFE_PATH' });
    await expect(readFile(path.join(outside, 'notify-user', 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('revalidates the staged copy before committing it', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async cp(from, to, options) {
        await cp(from, to, options);
        await rm(path.join(String(to), 'scripts', 'notify.mjs'));
        await symlink(
          path.join(String(to), 'SKILL.md'),
          path.join(String(to), 'scripts', 'notify.mjs'),
        );
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_SOURCE_INVALID' });
    await expect(readFile(path.join(codexHome, 'skills', 'notify-user', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates the exact managed directory moved to backup before replacing it', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const initialInstaller = createCodexSkillInstaller({ sourceDir, codexHome });
    const initial = await initialInstaller.install();
    await writeSkillSource(sourceDir, 'updated');
    let renameCalls = 0;
    const lateModification = '// modified immediately before update\n';
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async rename(from, to) {
        renameCalls += 1;
        if (renameCalls === 1) {
          await writeFile(path.join(String(from), 'scripts', 'notify.mjs'), lateModification);
        }
        await rename(from, to);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(initial.destination, 'scripts', 'notify.mjs'), 'utf8'))
      .resolves.toBe(lateModification);
    await expect(listInstallerArtifacts(path.join(codexHome, 'skills'))).resolves.toEqual([]);
  });

  it('keeps the committed update when backup cleanup partially fails', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const initialInstaller = createCodexSkillInstaller({ sourceDir, codexHome });
    const initial = await initialInstaller.install();
    await writeSkillSource(sourceDir, 'updated');
    const failingInstaller = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async rm(target, options) {
        if (path.basename(String(target)).startsWith('.notify-user-backup-')) {
          await rm(path.join(String(target), 'SKILL.md'));
          const error = new Error('simulated backup cleanup failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await rm(target, options);
      },
    });

    await expect(failingInstaller.install()).resolves.toMatchObject({ status: 'updated' });
    await expect(readFile(path.join(initial.destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: updated');
  });

  it('does not replace an unmanaged directory that appears during first install', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const destination = path.join(codexHome, 'skills', 'notify-user');
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async mkdir(target, options) {
        if (String(target) === destination) await mkdir(destination);
        await mkdir(target, options);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace an unmanaged directory that appears during update', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const initial = await createCodexSkillInstaller({ sourceDir, codexHome }).install();
    await writeSkillSource(sourceDir, 'updated');
    let renameCalls = 0;
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async rename(from, to) {
        renameCalls += 1;
        await rename(from, to);
        if (renameCalls === 1) await mkdir(initial.destination);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(initial.destination, 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const artifacts = await listInstallerArtifacts(path.join(codexHome, 'skills'));
    expect(artifacts.some((entry) => entry.startsWith('.notify-user-backup-'))).toBe(true);
  });

  it('revalidates the skills parent after staging before any destination write', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const skillsDir = path.join(codexHome, 'skills');
    const movedSkillsDir = path.join(codexHome, 'moved-skills');
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async cp(from, to, options) {
        await cp(from, to, options);
        await rename(skillsDir, movedSkillsDir);
        await symlink(movedSkillsDir, skillsDir);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_UNSAFE_PATH' });
    await expect(readFile(path.join(movedSkillsDir, 'notify-user', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates the skills parent after exclusively creating the destination', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const skillsDir = path.join(codexHome, 'skills');
    const movedSkillsDir = path.join(codexHome, 'moved-skills');
    const destination = path.join(skillsDir, 'notify-user');
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async mkdir(target, options) {
        if (String(target) === destination) {
          await rename(skillsDir, movedSkillsDir);
          await symlink(movedSkillsDir, skillsDir);
        }
        await mkdir(target, options);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_UNSAFE_PATH' });
    await expect(readFile(path.join(movedSkillsDir, 'notify-user', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink inserted into staging at the final copy boundary', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    let insertedLink = false;
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async copyFile(from, to, mode) {
        if (!insertedLink && String(from).endsWith(path.join('scripts', 'notify.mjs'))) {
          insertedLink = true;
          await rm(from);
          await symlink(path.join(String(from), '..', '..', 'SKILL.md'), from);
        }
        await copyFile(from, to, mode);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_SOURCE_INVALID' });
    await expect(readFile(path.join(codexHome, 'skills', 'notify-user', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies published bytes when a staging symlink is inserted and restored during copy', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    let replacedSource = false;
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async copyFile(from, to, mode) {
        if (!replacedSource && String(from).endsWith(path.join('scripts', 'notify.mjs'))) {
          replacedSource = true;
          const original = await readFile(from);
          await rm(from);
          await symlink(path.join(String(from), '..', '..', 'SKILL.md'), from);
          await copyFile(from, to, mode);
          await rm(from);
          await writeFile(from, original);
          return;
        }
        await copyFile(from, to, mode);
      },
    });

    await expect(installer.install()).rejects.toMatchObject({ code: 'SKILL_SOURCE_INVALID' });
    await expect(readFile(path.join(codexHome, 'skills', 'notify-user', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects publication when the skills parent is replaced and restored during copy', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const skillsDir = path.join(codexHome, 'skills');
    const movedSkillsDir = path.join(codexHome, 'moved-skills');
    const outsideSkillsDir = path.join(root, 'outside-skills');
    let replacedParent = false;
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async copyFile(from, to, mode) {
        if (!replacedParent && String(from).endsWith(path.join('agents', 'openai.yaml'))) {
          replacedParent = true;
          await rename(skillsDir, movedSkillsDir);
          await mkdir(path.join(outsideSkillsDir, 'notify-user', 'agents'), { recursive: true });
          await symlink(outsideSkillsDir, skillsDir);
          await copyFile(from, to, mode);
          await rm(skillsDir);
          await rename(movedSkillsDir, skillsDir);
          return;
        }
        await copyFile(from, to, mode);
      },
    });

    await expect(installer.install()).rejects.toThrow();
    await expect(readFile(path.join(skillsDir, 'notify-user', 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('quarantines a partial update and restores the previous version when cleanup fails', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir, 'initial');
    const initial = await createCodexSkillInstaller({ sourceDir, codexHome }).install();
    await writeSkillSource(sourceDir, 'updated');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async copyFile(from, to, mode) {
        if (String(from).endsWith(path.join('scripts', 'notify.mjs'))) {
          const error = new Error('simulated publish failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await copyFile(from, to, mode);
      },
      async rm(target, options) {
        if (String(target) === initial.destination) {
          const error = new Error('simulated partial cleanup failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await rm(target, options);
      },
    });

    await expect(installer.install()).rejects.toThrow('simulated publish failure');
    await expect(readFile(path.join(initial.destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: initial');
    const entries = await listAllEntries(path.join(codexHome, 'skills'));
    expect(entries.some((entry) => entry.startsWith('.notify-user-partial-'))).toBe(true);
  });

  it('quarantines a partial first install so a later retry is not blocked', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const destination = path.join(codexHome, 'skills', 'notify-user');
    await writeSkillSource(sourceDir, 'bundled');
    const installer = createCodexSkillInstaller({ sourceDir, codexHome }, {
      async copyFile(from, to, mode) {
        if (String(from).endsWith(path.join('scripts', 'notify.mjs'))) {
          const error = new Error('simulated first publish failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        await copyFile(from, to, mode);
      },
      async rm(target, options) {
        if (String(target) === destination) {
          const error = new Error('simulated first cleanup failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await rm(target, options);
      },
    });

    await expect(installer.install()).rejects.toThrow('simulated first publish failure');
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await listAllEntries(path.join(codexHome, 'skills'));
    expect(entries.some((entry) => entry.startsWith('.notify-user-partial-'))).toBe(true);
  });

  it('recovers an interrupted first install before retrying', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const skillsDir = path.join(codexHome, 'skills');
    const destination = path.join(skillsDir, 'notify-user');
    await writeSkillSource(sourceDir, 'bundled');
    await mkdir(path.join(destination, 'scripts'), { recursive: true });
    await writeFile(path.join(destination, 'scripts', 'partial.mjs'), '// interrupted\n');
    await writeInterruptedJournal(skillsDir, null);

    const result = await createCodexSkillInstaller({ sourceDir, codexHome }).install();

    expect(result.status).toBe('installed');
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: bundled');
    await expect(readFile(path.join(skillsDir, '.notify-user-installing.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await listAllEntries(skillsDir);
    expect(entries.some((entry) => entry.startsWith('.notify-user-partial-'))).toBe(true);
  });

  it('restores the previous version after an interrupted update before retrying', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const skillsDir = path.join(codexHome, 'skills');
    const destination = path.join(skillsDir, 'notify-user');
    const backupDir = path.join(skillsDir, '.notify-user-backup-interrupted');
    await writeSkillSource(sourceDir, 'initial');
    await createCodexSkillInstaller({ sourceDir, codexHome }).install();
    await rename(destination, backupDir);
    await mkdir(destination);
    await writeFile(path.join(destination, 'partial.txt'), 'interrupted\n');
    await writeInterruptedJournal(skillsDir, backupDir);
    await writeSkillSource(sourceDir, 'updated');

    const result = await createCodexSkillInstaller({ sourceDir, codexHome }).install();

    expect(result.status).toBe('updated');
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: updated');
    await expect(readFile(path.join(skillsDir, '.notify-user-installing.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not recover over an installation owned by a live process', async () => {
    const root = await createTempRoot();
    const sourceDir = path.join(root, 'bundled', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const skillsDir = path.join(codexHome, 'skills');
    await writeSkillSource(sourceDir, 'bundled');
    await createCodexSkillInstaller({ sourceDir, codexHome }).install();
    await writeFile(
      path.join(skillsDir, '.notify-user-installing.json'),
      `${JSON.stringify({
        owner: 'itharbors',
        skill: 'notify-user',
        version: 1,
        token: 'active-test',
        pid: process.pid,
        createdAt: Date.now(),
        backupDir: null,
      })}\n`,
    );

    await expect(createCodexSkillInstaller({ sourceDir, codexHome }).install())
      .rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(skillsDir, 'notify-user', 'SKILL.md'), 'utf8'))
      .resolves.toContain('description: bundled');
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
  const entries = await listAllEntries(parent);
  return entries.filter((entry) => (
    entry.startsWith('.notify-user-install-') || entry.startsWith('.notify-user-backup-')
  ));
}

async function listAllEntries(parent: string) {
  const { readdir } = await import('node:fs/promises');
  return readdir(parent);
}

async function writeInterruptedJournal(skillsDir: string, backupDir: string | null) {
  await writeFile(
    path.join(skillsDir, '.notify-user-installing.json'),
    `${JSON.stringify({
      owner: 'itharbors',
      skill: 'notify-user',
      version: 1,
      token: 'interrupted-test',
      pid: process.pid,
      createdAt: 0,
      backupDir,
    })}\n`,
  );
}
