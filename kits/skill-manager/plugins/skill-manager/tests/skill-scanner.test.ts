import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanGlobalRoot, scanSourceRoot } from '../main/src/skill-scanner.ts';

const roots: string[] = [];
const options = {
  limits: { maxFiles: 50, maxFileBytes: 4096, maxTotalBytes: 16_384 },
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('scanSourceRoot', () => {
  it('finds nested Skills while skipping ignored trees', async () => {
    const root = await temporaryRoot('source');
    await createSkill(root, 'collections/alpha', manifest('alpha', 'First'));
    await createSkill(root, 'collections/deeper/beta', manifest('beta', 'Second'), {
      'references/example.md': 'example',
    });
    for (const ignored of ['.git', 'node_modules', '.worktrees', 'skill-manager-store']) {
      await createSkill(root, `${ignored}/hidden`, manifest(`hidden-${ignored.replaceAll('.', '')}`, 'Ignored'));
    }

    const result = await scanSourceRoot(root, options);

    expect(result.truncated).toBe(false);
    expect(result.candidates.map((candidate) => candidate.manifest?.name)).toEqual(['alpha', 'beta']);
    expect(result.candidates[1]).toMatchObject({
      origin: 'source',
      basename: 'beta',
      protected: false,
      diagnostics: [],
    });
    expect(result.candidates[1].digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps malformed candidates and duplicate manifest names diagnosable', async () => {
    const root = await temporaryRoot('source-invalid');
    await createSkill(root, 'first', manifest('shared', 'One'));
    await createSkill(root, 'second', manifest('shared', 'Two'));
    await createSkill(root, 'broken', '---\nname: Broken_Name\ndescription: no\n---\n');

    const result = await scanSourceRoot(root, options);

    expect(result.candidates.filter((candidate) => candidate.manifest?.name === 'shared')).toHaveLength(2);
    expect(result.candidates.find((candidate) => candidate.basename === 'broken')).toMatchObject({
      manifest: null,
      digest: null,
      diagnostics: [expect.objectContaining({ code: 'INVALID_SKILL' })],
    });
  });

  it('marks overlapping Skill directories without dropping either candidate', async () => {
    const root = await temporaryRoot('source-overlap');
    await createSkill(root, 'outer', manifest('outer', 'Outer'));
    await createSkill(root, 'outer/references/inner', manifest('inner', 'Inner'));

    const result = await scanSourceRoot(root, options);

    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.diagnostics).toContainEqual(expect.objectContaining({
        code: 'OVERLAPPING_SKILL',
      }));
    }
  });

  it('does not follow a linked directory and reports a linked SKILL.md', async () => {
    const root = await temporaryRoot('source-links');
    const outside = await temporaryRoot('source-outside');
    await createSkill(outside, 'external', manifest('external', 'External'));
    await symlink(path.join(outside, 'external'), path.join(root, 'linked-directory'));
    const linkedSkill = path.join(root, 'linked-file');
    await mkdir(linkedSkill);
    await symlink(path.join(outside, 'external', 'SKILL.md'), path.join(linkedSkill, 'SKILL.md'));

    const result = await scanSourceRoot(root, options);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      basename: 'linked-file',
      manifest: null,
      diagnostics: [expect.objectContaining({ code: 'UNSAFE_PATH' })],
    });
  });

  it('throws a stable cancellation error', async () => {
    const root = await temporaryRoot('source-cancelled');
    const controller = new AbortController();
    controller.abort();

    await expect(scanSourceRoot(root, { ...options, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'SCAN_CANCELLED' });
  });

  it.runIf(process.platform !== 'win32')('continues with a scan-level diagnostic after a permission error', async () => {
    const root = await temporaryRoot('source-permission');
    await createSkill(root, 'readable', manifest('readable', 'Readable'));
    const blocked = path.join(root, 'blocked');
    await mkdir(blocked);
    await chmod(blocked, 0o000);
    try {
      const result = await scanSourceRoot(root, options);
      expect(result.candidates.map((candidate) => candidate.manifest?.name)).toEqual(['readable']);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'INVALID_SKILL',
        relativePath: 'blocked',
      }));
    } finally {
      await chmod(blocked, 0o700);
    }
  });
});

describe('scanGlobalRoot', () => {
  it('scans direct global children and protected .system children only', async () => {
    const root = await temporaryRoot('global');
    await createSkill(root, 'regular', manifest('regular', 'Regular'));
    await createSkill(root, 'regular/nested', manifest('nested', 'Must not be separately discovered'));
    await createSkill(root, '.system/builtin', manifest('builtin', 'Built in'));
    await createSkill(root, '.system/builtin/nested', manifest('nested-system', 'Must not be discovered'));

    const result = await scanGlobalRoot(root, options);

    expect(result.candidates.map((candidate) => candidate.manifest?.name)).toEqual(['builtin', 'regular']);
    expect(result.candidates[0]).toMatchObject({ origin: 'system', protected: true });
    expect(result.candidates[1]).toMatchObject({ origin: 'global', protected: false });
  });

  it('keeps a direct child without a regular SKILL.md as invalid', async () => {
    const root = await temporaryRoot('global-invalid');
    await mkdir(path.join(root, 'missing'));

    const result = await scanGlobalRoot(root, options);

    expect(result.candidates).toEqual([
      expect.objectContaining({
        basename: 'missing',
        manifest: null,
        diagnostics: [expect.objectContaining({ code: 'INVALID_SKILL' })],
      }),
    ]);
  });
});

function manifest(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `skill-manager-${label}-`));
  roots.push(root);
  return root;
}

async function createSkill(
  root: string,
  folder: string,
  skillManifest: string,
  files: Record<string, unknown> = {},
): Promise<string> {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), skillManifest);
  for (const [name, value] of Object.entries(files)) {
    const filename = path.join(directory, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, String(value));
  }
  return directory;
}
