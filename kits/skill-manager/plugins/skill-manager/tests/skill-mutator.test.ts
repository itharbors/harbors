import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSkillMutator } from '../main/src/skill-mutator.ts';
import { scanGlobalRoot, scanSourceRoot } from '../main/src/skill-scanner.ts';
import { createSkillStore } from '../main/src/skill-store.ts';
import type { SkillCandidate } from '../main/src/types.ts';

const roots: string[] = [];
const scanOptions = {
  limits: { maxFiles: 50, maxFileBytes: 4096, maxTotalBytes: 16_384 },
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createSkillMutator', () => {
  it('installs a staged source Skill into an exclusive global target', async () => {
    const fixture = await createFixture('install');
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const mutator = await createMutator(fixture);

    const receipt = await mutator.install({ revision: 1, source, expectedDigest: source.digest! });

    expect(receipt).toMatchObject({
      action: 'install',
      status: 'completed',
      basename: 'sample',
      digest: source.digest,
      revision: 1,
    });
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Source version');
    expect((await readdir(fixture.globalRoot)).some((name) => name.startsWith('.skill-manager-stage-'))).toBe(false);
  });

  it('refuses a destination that appears after staging without deleting it', async () => {
    const fixture = await createFixture('destination-race');
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const mutator = await createMutator(fixture, {
      afterStage: async () => {
        await createSkill(fixture.globalRoot, 'sample', 'Competing version');
      },
    });

    await expect(mutator.install({ revision: 1, source, expectedDigest: source.digest! }))
      .rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Competing version');
  });

  it('detects source changes after staging and publishes nothing', async () => {
    const fixture = await createFixture('source-race');
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const mutator = await createMutator(fixture, {
      afterStage: async () => {
        await writeFile(path.join(source.directory, 'changed.txt'), 'late change');
      },
    });

    await expect(mutator.install({ revision: 1, source, expectedDigest: source.digest! }))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    await expect(access(path.join(fixture.globalRoot, 'sample'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('updates through a journaled backup and removes transaction artifacts', async () => {
    const fixture = await createFixture('update', true);
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const global = await globalCandidate(fixture.globalRoot, 'sample');
    const mutator = await createMutator(fixture);

    const receipt = await mutator.update({
      revision: 2,
      source,
      global,
      expectedDigest: global.digest!,
    });

    expect(receipt).toMatchObject({ action: 'update', status: 'completed', digest: source.digest });
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Source version');
    expect((await readdir(fixture.globalRoot)).filter((name) => name.startsWith('.skill-manager-'))).toEqual([]);
    expect(await readdir(path.join(fixture.store.root, 'journals'))).toEqual([]);
  });

  it('restores the old version when update publication fails', async () => {
    const fixture = await createFixture('update-rollback', true);
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const global = await globalCandidate(fixture.globalRoot, 'sample');
    const mutator = await createMutator(fixture, undefined, async (from, to) => {
      if (path.basename(from).startsWith('.skill-manager-stage-') && path.basename(to) === 'sample') {
        throw new Error('injected publish failure');
      }
      await rename(from, to);
    });

    await expect(mutator.update({ revision: 2, source, global, expectedDigest: global.digest! }))
      .rejects.toThrow('injected publish failure');
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Global version');
  });

  it('returns a recovery receipt and retains backup plus journal when rollback fails', async () => {
    const fixture = await createFixture('update-recovery', true);
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const global = await globalCandidate(fixture.globalRoot, 'sample');
    const mutator = await createMutator(fixture, undefined, async (from, to) => {
      if (
        (path.basename(from).startsWith('.skill-manager-stage-') && path.basename(to) === 'sample')
        || (path.basename(from).startsWith('.skill-manager-backup-') && path.basename(to) === 'sample')
      ) throw new Error('injected publication or rollback failure');
      await rename(from, to);
    });

    const receipt = await mutator.update({ revision: 2, source, global, expectedDigest: global.digest! });

    expect(receipt).toMatchObject({
      action: 'update',
      status: 'recovery-required',
      recoveryId: expect.any(String),
    });
    const backup = (await readdir(fixture.globalRoot)).find((name) => name.startsWith('.skill-manager-backup-'))!;
    await expect(readFile(path.join(fixture.globalRoot, backup, 'SKILL.md'), 'utf8'))
      .resolves.toContain('Global version');
    await expect(readFile(path.join(fixture.store.root, 'journals', `${receipt.recoveryId}.json`), 'utf8'))
      .resolves.toContain('update');
  });

  it('rejects stale digests and symlinked source content', async () => {
    const fixture = await createFixture('invalid-source');
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const mutator = await createMutator(fixture);

    await expect(mutator.install({ revision: 1, source, expectedDigest: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });

    await writeFile(path.join(source.directory, 'regular.txt'), 'regular');
    await symlink(path.join(source.directory, 'regular.txt'), path.join(source.directory, 'linked.txt'));
    await expect(mutator.install({ revision: 1, source, expectedDigest: source.digest! }))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('surfaces a cross-device backup rename without changing the old target', async () => {
    const fixture = await createFixture('cross-device', true);
    const source = await sourceCandidate(fixture.sourceRoot, 'sample');
    const global = await globalCandidate(fixture.globalRoot, 'sample');
    const mutator = await createMutator(fixture, undefined, async (from, to) => {
      if (path.basename(from) === 'sample' && path.basename(to).startsWith('.skill-manager-backup-')) {
        throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
      }
      await rename(from, to);
    });

    await expect(mutator.update({ revision: 2, source, global, expectedDigest: global.digest! }))
      .rejects.toMatchObject({ code: 'EXDEV' });
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Global version');
  });

  it('delegates disable, restore, and uninstall through recoverable store actions', async () => {
    const fixture = await createFixture('delegated-actions', true);
    const global = await globalCandidate(fixture.globalRoot, 'sample');
    const mutator = await createMutator(fixture);

    const disabled = await mutator.disable({
      revision: 3,
      global,
      expectedDigest: global.digest!,
    });
    expect(disabled).toMatchObject({ action: 'disable', recoveryId: expect.any(String) });
    await mutator.restore({
      revision: 4,
      recoveryId: disabled.recoveryId,
      expectedDigest: disabled.digest,
    });
    const restored = await globalCandidate(fixture.globalRoot, 'sample');
    const uninstalled = await mutator.uninstall({
      revision: 5,
      global: restored,
      expectedDigest: restored.digest!,
    });
    expect(uninstalled).toMatchObject({ action: 'uninstall', recoveryId: expect.any(String) });
    await expect(access(path.join(fixture.globalRoot, 'sample'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fixture.store.list()).resolves.toEqual([
      expect.objectContaining({ id: uninstalled.recoveryId, action: 'trash', valid: true }),
    ]);
  });

  it('serializes the same target while allowing different targets to stage concurrently', async () => {
    const fixture = await createFixture('concurrency');
    await createSkill(fixture.sourceRoot, 'other', 'Other source');
    const sample = await sourceCandidate(fixture.sourceRoot, 'sample');
    const other = await sourceCandidate(fixture.sourceRoot, 'other');
    let active = 0;
    let maximum = 0;
    const waiters: Array<() => void> = [];
    const afterStage = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active === 2) waiters.splice(0).forEach((resolve) => resolve());
      else await new Promise<void>((resolve) => waiters.push(resolve));
      active -= 1;
    };
    const mutator = await createMutator(fixture, { afterStage });

    await Promise.all([
      mutator.install({ revision: 1, source: sample, expectedDigest: sample.digest! }),
      mutator.install({ revision: 1, source: other, expectedDigest: other.digest! }),
    ]);
    expect(maximum).toBe(2);

    const sameFixture = await createFixture('same-target');
    const sameSource = await sourceCandidate(sameFixture.sourceRoot, 'sample');
    let sameTargetActive = 0;
    let sameTargetMaximum = 0;
    const serialized = await createMutator(sameFixture, {
      afterStage: async () => {
        sameTargetActive += 1;
        sameTargetMaximum = Math.max(sameTargetMaximum, sameTargetActive);
        await Promise.resolve();
        sameTargetActive -= 1;
      },
    });
    const results = await Promise.allSettled([
      serialized.install({ revision: 2, source: sameSource, expectedDigest: sameSource.digest! }),
      serialized.install({ revision: 2, source: sameSource, expectedDigest: sameSource.digest! }),
    ]);
    expect(sameTargetMaximum).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});

async function createFixture(label: string, withGlobal = false) {
  const root = await mkdtemp(path.join(tmpdir(), `skill-manager-mutator-${label}-`));
  roots.push(root);
  const codexHome = path.join(root, 'codex-home');
  const globalRoot = path.join(codexHome, 'skills');
  const sourceRoot = path.join(root, 'source');
  await mkdir(globalRoot, { recursive: true });
  await mkdir(sourceRoot);
  await createSkill(sourceRoot, 'sample', 'Source version');
  if (withGlobal) await createSkill(globalRoot, 'sample', 'Global version');
  const store = await createSkillStore({ codexHome });
  return { root, codexHome, globalRoot, sourceRoot, store };
}

async function createMutator(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  hooks?: { afterStage?: () => Promise<void> },
  renameEntry?: (from: string, to: string) => Promise<void>,
) {
  return createSkillMutator({
    globalRoot: fixture.globalRoot,
    store: fixture.store,
    hooks,
    renameEntry,
    limits: scanOptions.limits,
  });
}

async function createSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}

async function sourceCandidate(root: string, name: string): Promise<SkillCandidate> {
  const result = await scanSourceRoot(root, scanOptions);
  return requiredCandidate(result.candidates, name);
}

async function globalCandidate(root: string, name: string): Promise<SkillCandidate> {
  const result = await scanGlobalRoot(root, scanOptions);
  return requiredCandidate(result.candidates, name);
}

function requiredCandidate(candidates: SkillCandidate[], name: string): SkillCandidate {
  const candidate = candidates.find((item) => item.manifest?.name === name);
  if (!candidate) throw new Error(`Missing candidate ${name}`);
  return candidate;
}
