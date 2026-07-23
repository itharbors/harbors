import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { selectKitSlugs } from './kit-ci-selection.mjs';

const allKits = ['mysql', 'notifications', 'sqlite'];
const runners = Object.freeze({
  mysql: 'ubuntu-latest',
  notifications: 'ubuntu-latest',
  sqlite: 'macos-14',
});
const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repositoryRoot, 'scripts/select-kit-ci.mjs');

async function git(repository, ...args) {
  return (await execFileAsync('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();
}

async function initializeRepository({ seedRoot = true } = {}) {
  const repository = await mkdtemp(path.join(tmpdir(), 'kit-ci-selection-'));
  await git(repository, 'init', '-q');
  await git(repository, 'config', 'user.name', 'Kit CI Test');
  await git(repository, 'config', 'user.email', 'kit-ci@example.test');
  if (seedRoot) {
    await writeFile(path.join(repository, '.root'), 'root\n');
    await commitAll(repository, 'root');
  }
  await mkdir(path.join(repository, 'registry'), { recursive: true });
  await writeFile(
    path.join(repository, 'registry/policy.json'),
    await readFile(path.join(repositoryRoot, 'registry/policy.json')),
  );
  return repository;
}

async function commitAll(repository, message) {
  await git(repository, 'add', '-A');
  await git(repository, 'commit', '-qm', message);
  return git(repository, 'rev-parse', 'HEAD');
}

async function runCli(repository, args) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: repository,
      encoding: 'utf8',
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function expectedCliOutput(slugs) {
  return `MATRIX_JSON=${JSON.stringify({
    include: slugs.map((kit) => ({ kit, runner: runners[kit] })),
  })}\nHAS_KITS=${slugs.length > 0}\n`;
}

test('selects only changed official Kits in deterministic order', () => {
  assert.deepEqual(selectKitSlugs(['kits/mysql/package.json']), ['mysql']);
  assert.deepEqual(
    selectKitSlugs(['kits/sqlite/main.html', 'kits/notifications/layout.json']),
    ['notifications', 'sqlite'],
  );
  assert.deepEqual(selectKitSlugs(['kits/sqlite', 'kits/sqlite/kit.json']), ['sqlite']);
});

test('ignores unrelated paths and the non-official default fixture', () => {
  assert.deepEqual(selectKitSlugs(['docs/README.md']), []);
  assert.deepEqual(selectKitSlugs(['kits/default/kit.json']), []);
});

test('selects all official Kits for shared build, validation, Registry, and workflow paths', () => {
  for (const sharedPath of [
    'package.json',
    'package-lock.json',
    'registry/policy.json',
    'registry/revocations.json',
    'packages/kit-core/src/schema.ts',
    'packages/kit-cli/src/archive.ts',
    'scripts/check-kit.mjs',
    'scripts/lib/kit-check.mjs',
    'scripts/lib/kit-monorepo.mjs',
    'scripts/lib/kit-ci-selection.mjs',
    'scripts/lib/kit-registry/audit.mjs',
    'scripts/kit-publish.mjs',
    'scripts/select-kit-ci.mjs',
    'scripts/lib/kit-publish/metadata.mjs',
    '.github/workflows/kit-ci.yml',
    '.github/workflows/publish-kit.yml',
    '.github/workflows/publish-kit-reusable.yml',
    '.github/workflows/publish-kit-registry.yml',
  ]) {
    assert.deepEqual(selectKitSlugs([sharedPath]), allKits, sharedPath);
  }
});

test('maps direct Kit-check dependency surfaces to only their affected Kits', () => {
  const cases = [
    ['packages/mysql-contracts/src/index.ts', ['mysql']],
    ['packages/sqlite-contracts/src/index.ts', ['sqlite']],
    ['packages/relationship-graph/src/index.ts', ['mysql', 'sqlite']],
    ['scripts/prepare-notification-skill-resource.mjs', ['notifications']],
    ['scripts/lib/codex-skill-resource.mjs', ['notifications']],
    ['.agents/skills/notify-user/SKILL.md', ['notifications']],
    ['scripts/ce-plugin.mjs', allKits],
    ['scripts/lib/plugin-build/validate.mjs', allKits],
  ];
  for (const [changedPath, expected] of cases) {
    assert.deepEqual(selectKitSlugs([changedPath]), expected, changedPath);
  }
});

test('rejects unknown Kit directories', () => {
  assert.throws(
    () => selectKitSlugs(['kits/unknown/package.json']),
    /unknown Kit directory/i,
  );
  assert.throws(() => selectKitSlugs(['kits/unknown']), /unknown Kit directory/i);
});

test('rejects non-canonical repository paths instead of ambiguously classifying them', () => {
  for (const changedPath of [
    '',
    '/kits/sqlite/package.json',
    'C:/kits/sqlite/package.json',
    '../kits/sqlite/package.json',
    './kits/sqlite/package.json',
    'kits/./sqlite/package.json',
    'kits/sqlite/../mysql/package.json',
    'kits//sqlite/package.json',
    'kits/sqlite/',
    'kits\\sqlite\\package.json',
    'kits/sqlite/bad\0name',
    'kits/sqlite/bad\nname',
    'kits/sqlite/bad\u0085name',
  ]) {
    assert.throws(
      () => selectKitSlugs([changedPath]),
      /canonical repository path/i,
      JSON.stringify(changedPath),
    );
  }
  assert.throws(() => selectKitSlugs('kits/sqlite/package.json'), /paths must be an array/i);
  assert.throws(() => selectKitSlugs([null]), /canonical repository path/i);
});

test('CLI selects policy-owned runners from a real NUL-delimited Git diff', async () => {
  const repository = await initializeRepository();
  try {
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    const base = await commitAll(repository, 'initial');
    await mkdir(path.join(repository, 'kits/sqlite'), { recursive: true });
    await writeFile(path.join(repository, 'kits/sqlite/main.html'), '<main></main>\n');
    const head = await commitAll(repository, 'sqlite');

    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      'MATRIX_JSON={"include":[{"kit":"sqlite","runner":"macos-14"}]}\nHAS_KITS=true\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI includes current root-commit paths when the comparison base is the root', async () => {
  const repository = await initializeRepository({ seedRoot: false });
  try {
    await mkdir(path.join(repository, 'kits/mysql'), { recursive: true });
    await writeFile(path.join(repository, 'kits/mysql/package.json'), '{}\n');
    await git(repository, 'add', 'kits/mysql/package.json');
    await git(repository, 'commit', '-qm', 'root Kit');
    const rootCommit = await git(repository, 'rev-parse', 'HEAD');

    const result = await runCli(repository, [rootCommit, rootCommit]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'MATRIX_JSON={"include":[{"kit":"mysql","runner":"ubuntu-latest"}]}\nHAS_KITS=true\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI includes deletions and both sides of renames in Kit selection', async (t) => {
  const cases = [
    {
      name: 'deleted Kit file',
      source: 'kits/mysql/removed.txt',
      destination: null,
      expected: ['mysql'],
    },
    {
      name: 'deleted shared file',
      source: 'scripts/check-kit.mjs',
      destination: null,
      expected: allKits,
    },
    {
      name: 'Kit file renamed to docs',
      source: 'kits/mysql/moved.txt',
      destination: 'docs/moved.txt',
      expected: ['mysql'],
    },
    {
      name: 'docs file renamed into a Kit',
      source: 'docs/moved.txt',
      destination: 'kits/sqlite/moved.txt',
      expected: ['sqlite'],
    },
    {
      name: 'file renamed between Kits',
      source: 'kits/mysql/moved.txt',
      destination: 'kits/sqlite/moved.txt',
      expected: ['mysql', 'sqlite'],
    },
    {
      name: 'shared file renamed to docs',
      source: 'scripts/check-kit.mjs',
      destination: 'docs/check-kit.mjs',
      expected: allKits,
    },
  ];

  for (const { name, source, destination, expected } of cases) {
    await t.test(name, async () => {
      const repository = await initializeRepository();
      try {
        await mkdir(path.dirname(path.join(repository, source)), { recursive: true });
        await writeFile(path.join(repository, source), 'changed\n');
        const base = await commitAll(repository, 'base');
        if (destination === null) {
          await rm(path.join(repository, source));
        } else {
          await mkdir(path.dirname(path.join(repository, destination)), { recursive: true });
          await git(repository, 'mv', source, destination);
        }
        const head = await commitAll(repository, 'change');

        const result = await runCli(repository, [base, head]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, expectedCliOutput(expected));
      } finally {
        await rm(repository, { recursive: true, force: true });
      }
    });
  }
});

test('CLI reports no Kits for an unrelated Git diff', async () => {
  const repository = await initializeRepository();
  try {
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    const base = await commitAll(repository, 'initial');
    await mkdir(path.join(repository, 'docs'), { recursive: true });
    await writeFile(path.join(repository, 'docs/README.md'), 'docs\n');
    const head = await commitAll(repository, 'docs');

    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'MATRIX_JSON={"include":[]}\nHAS_KITS=false\n');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI rejects control-bearing Git paths without newline-based misclassification', async () => {
  const repository = await initializeRepository();
  try {
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    const base = await commitAll(repository, 'initial');
    await mkdir(path.join(repository, 'kits/sqlite'), { recursive: true });
    await writeFile(path.join(repository, 'kits/sqlite/bad\nname'), 'unsafe\n');
    const head = await commitAll(repository, 'unsafe filename');

    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^ERROR=Changed path must be a canonical repository path\n$/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI loads runner metadata through the strict Kit policy loader', async () => {
  const repository = await initializeRepository();
  try {
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    const base = await commitAll(repository, 'initial');
    await mkdir(path.join(repository, 'kits/mysql'), { recursive: true });
    await writeFile(path.join(repository, 'kits/mysql/package.json'), '{}\n');
    const head = await commitAll(repository, 'mysql');
    const policy = JSON.parse(await readFile(path.join(repository, 'registry/policy.json'), 'utf8'));
    policy.untrusted = true;
    await writeFile(path.join(repository, 'registry/policy.json'), JSON.stringify(policy));

    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^ERROR=Kit policy contains unexpected fields\n$/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI rejects invalid arguments before invoking Git', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'kit-ci-selection-'));
  try {
    for (const args of [[], ['a'.repeat(40)], ['A'.repeat(40), 'b'.repeat(40)], ['a'.repeat(40), 'b'.repeat(40), 'extra']]) {
      const result = await runCli(repository, args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Usage: node scripts/select-kit-ci.mjs <base-sha> <head-sha>\n');
    }
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI reports Git failures on one sanitized line', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'kit-ci-selection-'));
  try {
    const result = await runCli(repository, ['a'.repeat(40), 'b'.repeat(40)]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'ERROR=Git diff failed\n');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
