import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanGlobalRoot, recoveryEntriesToCandidates } from '../main/src/skill-scanner.ts';
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

describe('createSkillStore', () => {
  it.each([
    ['disabled', 'disabled'],
    ['trash', 'trash'],
  ] as const)('moves a global Skill into the %s recovery area with an exact record', async (action, origin) => {
    const fixture = await createFixture('move');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });

    const entry = await store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action,
      expectedDigest: candidate.digest!,
    });

    expect(store.root).toBe(path.join(await import('node:fs/promises').then(({ realpath }) => realpath(fixture.codexHome)), 'skill-manager-store', 'v1'));
    expect(entry).toMatchObject({
      id: expect.any(String),
      action,
      skillName: 'sample',
      originalBasename: 'sample',
      digest: candidate.digest,
      valid: true,
    });
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(entry.directory, 'SKILL.md'), 'utf8')).resolves.toContain('name: sample');
    expect((await stat(path.dirname(entry.directory))).mode & 0o777).toBe(0o700);

    const record = JSON.parse(await readFile(path.join(store.root, 'records', `${entry.id}.json`), 'utf8'));
    expect(record).toEqual({
      schemaVersion: 1,
      id: entry.id,
      action,
      skillName: 'sample',
      originalBasename: 'sample',
      digest: candidate.digest,
      createdAt: expect.any(String),
    });
    const listed = await store.list();
    expect(listed).toEqual([expect.objectContaining({ id: entry.id, valid: true })]);
    expect(recoveryEntriesToCandidates(listed)).toEqual([
      expect.objectContaining({ origin, manifest: { name: 'sample', description: 'Sample Skill' } }),
    ]);
  });

  it('restores stored content and removes its recovery record', async () => {
    const fixture = await createFixture('restore');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });
    const entry = await store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'disabled',
      expectedDigest: candidate.digest!,
    });

    await store.restore({
      globalRoot: fixture.globalRoot,
      id: entry.id,
      expectedDigest: entry.digest,
    });

    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8')).resolves.toContain('name: sample');
    await expect(store.list()).resolves.toEqual([]);
  });

  it('refuses an occupied restore target without changing stored content', async () => {
    const fixture = await createFixture('occupied');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });
    const entry = await store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'trash',
      expectedDigest: candidate.digest!,
    });
    await createSkill(fixture.globalRoot, 'sample', 'Replacement');

    await expect(store.restore({
      globalRoot: fixture.globalRoot,
      id: entry.id,
      expectedDigest: entry.digest,
    })).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    await expect(readFile(path.join(entry.directory, 'SKILL.md'), 'utf8')).resolves.toContain('Sample Skill');
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8')).resolves.toContain('Replacement');
  });

  it('marks tampered stored content invalid and refuses to restore it', async () => {
    const fixture = await createFixture('tampered');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });
    const entry = await store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'disabled',
      expectedDigest: candidate.digest!,
    });
    await writeFile(path.join(entry.directory, 'extra.txt'), 'tampered');

    const listed = await store.list();

    expect(listed).toEqual([expect.objectContaining({
      id: entry.id,
      valid: false,
      diagnostics: [expect.objectContaining({ code: 'INVALID_SKILL' })],
    })]);
    expect(recoveryEntriesToCandidates(listed)[0]).toMatchObject({
      manifest: null,
      digest: null,
    });
    await expect(store.restore({
      globalRoot: fixture.globalRoot,
      id: entry.id,
      expectedDigest: entry.digest,
    })).rejects.toMatchObject({ code: 'INVALID_SKILL' });
  });

  it('projects a malformed recovery record as a read-only invalid entry', async () => {
    const fixture = await createFixture('malformed-record');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });
    const entry = await store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'disabled',
      expectedDigest: candidate.digest!,
    });
    await writeFile(path.join(store.root, 'records', `${entry.id}.json`), '{"schemaVersion":99}\n');

    const listed = await store.list();

    expect(listed).toEqual([expect.objectContaining({
      id: entry.id,
      valid: false,
      diagnostics: [expect.objectContaining({ code: 'INVALID_SKILL' })],
    })]);
    expect(recoveryEntriesToCandidates(listed)[0]).toMatchObject({
      manifest: null,
      digest: null,
      diagnostics: [expect.objectContaining({ code: 'INVALID_SKILL' })],
    });
  });

  it('refuses a missing record while preserving orphaned recovery content', async () => {
    const fixture = await createFixture('missing-record');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });
    const entry = await store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'trash',
      expectedDigest: candidate.digest!,
    });
    await unlink(path.join(store.root, 'records', `${entry.id}.json`));

    await expect(store.restore({
      globalRoot: fixture.globalRoot,
      id: entry.id,
      expectedDigest: entry.digest,
    })).rejects.toMatchObject({ code: 'INVALID_SKILL' });
    await expect(readFile(path.join(entry.directory, 'SKILL.md'), 'utf8')).resolves.toContain('name: sample');
  });

  it('rolls the Skill back when atomic record publication fails', async () => {
    const fixture = await createFixture('rollback');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({
      codexHome: fixture.codexHome,
      renameEntry: async (from, to) => {
        if (path.dirname(to).endsWith(path.join('v1', 'records')) && to.endsWith('.json')) {
          throw new Error('injected record publication failure');
        }
        await rename(from, to);
      },
    });

    await expect(store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'disabled',
      expectedDigest: candidate.digest!,
    })).rejects.toThrow('injected record publication failure');
    await expect(readFile(path.join(fixture.globalRoot, 'sample', 'SKILL.md'), 'utf8')).resolves.toContain('name: sample');
    await expect(store.list()).resolves.toEqual([]);
  });

  it('retains a journal and stored content when record publication and rollback both fail', async () => {
    const fixture = await createFixture('rollback-journal');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    let renameCount = 0;
    const store = await createSkillStore({
      codexHome: fixture.codexHome,
      renameEntry: async (from, to) => {
        renameCount += 1;
        if (renameCount > 1) throw new Error(`injected rename failure ${renameCount}`);
        await rename(from, to);
      },
    });

    await expect(store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'trash',
      expectedDigest: candidate.digest!,
    })).rejects.toBeInstanceOf(AggregateError);

    const journals = await import('node:fs/promises').then(({ readdir }) => readdir(path.join(store.root, 'journals')));
    expect(journals).toHaveLength(1);
    const journal = JSON.parse(await readFile(path.join(store.root, 'journals', journals[0]), 'utf8'));
    expect(journal).toMatchObject({ schemaVersion: 1, operation: 'move' });
    await expect(readFile(path.join(journal.storedDirectory, 'SKILL.md'), 'utf8')).resolves.toContain('name: sample');
  });

  it('refuses protected system Skills', async () => {
    const fixture = await createFixture('system');
    await createSkill(path.join(fixture.globalRoot, '.system'), 'builtin', 'Built in');
    const result = await scanGlobalRoot(fixture.globalRoot, scanOptions);
    const candidate = result.candidates.find((item) => item.manifest?.name === 'builtin')!;
    const store = await createSkillStore({ codexHome: fixture.codexHome });

    await expect(store.moveFromGlobal({
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'disabled',
      expectedDigest: candidate.digest!,
    })).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
  });

  it('serializes concurrent moves for the same global directory', async () => {
    const fixture = await createFixture('concurrent');
    const candidate = await globalCandidate(fixture.globalRoot, 'sample');
    const store = await createSkillStore({ codexHome: fixture.codexHome });
    const input = {
      globalRoot: fixture.globalRoot,
      candidate,
      action: 'disabled' as const,
      expectedDigest: candidate.digest!,
    };

    const results = await Promise.allSettled([
      store.moveFromGlobal(input),
      store.moveFromGlobal(input),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(store.list()).resolves.toHaveLength(1);
  });
});

async function createFixture(label: string) {
  const root = await mkdtemp(path.join(tmpdir(), `skill-manager-store-${label}-`));
  roots.push(root);
  const codexHome = path.join(root, 'codex-home');
  const globalRoot = path.join(codexHome, 'skills');
  await mkdir(globalRoot, { recursive: true });
  await createSkill(globalRoot, 'sample', 'Sample Skill');
  return { codexHome, globalRoot };
}

async function createSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

async function globalCandidate(globalRoot: string, name: string): Promise<SkillCandidate> {
  const result = await scanGlobalRoot(globalRoot, scanOptions);
  const candidate = result.candidates.find((item) => item.manifest?.name === name);
  if (!candidate) throw new Error(`Missing candidate ${name}`);
  return candidate;
}
