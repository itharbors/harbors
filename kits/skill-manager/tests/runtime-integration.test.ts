import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSkillService } from '../plugins/skill-manager/main/src/skill-service.ts';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Skill Manager runtime acceptance', () => {
  it('installs, updates, disables, and restores through isolated source and global roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skill-manager-acceptance-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const sourceRoot = path.join(home, 'source');
    const codexHome = path.join(root, 'codex-home');
    const globalRoot = path.join(codexHome, 'skills');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await createSkill(sourceRoot, 'alpha', 'Source alpha');
    await createSkill(sourceRoot, 'beta', 'Source beta');
    await createSkill(globalRoot, 'beta', 'Global beta');
    const service = await createSkillService({
      codexHome,
      homeDirectory: home,
      broadcast: () => undefined,
    });
    const sourceDirectoryId = (await service.browseDirectory({})).children
      .find((entry) => entry.name === 'source')!.id;

    let snapshot = await service.selectSource({ directoryId: sourceDirectoryId });
    expect(status(snapshot, 'alpha')).toBe('source-only');
    expect(status(snapshot, 'beta')).toBe('update-available');

    const alpha = find(snapshot, 'alpha');
    snapshot = (await service.performAction({
      action: 'install',
      skillId: alpha.id,
      revision: snapshot.revision,
      expectedDigest: alpha.sourceDigest,
    })).snapshot;
    expect(status(snapshot, 'alpha')).toBe('current');
    await expect(readFile(path.join(globalRoot, 'alpha', 'SKILL.md'), 'utf8')).resolves.toContain('Source alpha');

    const beta = find(snapshot, 'beta');
    snapshot = (await service.performAction({
      action: 'update',
      skillId: beta.id,
      revision: snapshot.revision,
      expectedDigest: beta.globalDigest,
    })).snapshot;
    expect(status(snapshot, 'beta')).toBe('current');
    await expect(readFile(path.join(globalRoot, 'beta', 'SKILL.md'), 'utf8')).resolves.toContain('Source beta');

    snapshot = await service.clearSource();
    const globalAlpha = find(snapshot, 'alpha');
    snapshot = (await service.performAction({
      action: 'disable',
      skillId: globalAlpha.id,
      revision: snapshot.revision,
      expectedDigest: globalAlpha.globalDigest,
    })).snapshot;
    expect(status(snapshot, 'alpha')).toBe('disabled');

    const disabledAlpha = find(snapshot, 'alpha');
    snapshot = (await service.performAction({
      action: 'restore',
      skillId: disabledAlpha.id,
      revision: snapshot.revision,
      expectedDigest: disabledAlpha.recoveryDigest,
    })).snapshot;
    expect(status(snapshot, 'alpha')).toBe('global-only');
    await expect(readFile(path.join(globalRoot, 'alpha', 'SKILL.md'), 'utf8')).resolves.toContain('Source alpha');
  });
});

async function createSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}

function find(snapshot: any, name: string) {
  const item = snapshot.items.find((value: any) => value.name === name);
  if (!item) throw new Error(`Missing item ${name}`);
  return item;
}

function status(snapshot: any, name: string) {
  return find(snapshot, name).status;
}
