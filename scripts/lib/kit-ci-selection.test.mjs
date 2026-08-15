import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { selectKitSlugs } from './kit-ci-selection.mjs';
import { loadTrustedMarketKit } from './kit-monorepo.mjs';
import { discoverRepositoryKits } from './repository-kits.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repositoryRoot, 'scripts/select-kit-ci.mjs');

// Derive the authoritative trusted slug set and runner map from the repository
// policy and descriptors at runtime, rather than hard-coding them.
const allDescriptorsFromRepo = Object.freeze(await discoverRepositoryKits({ repositoryRoot }));
const allKits = allDescriptorsFromRepo.map((descriptor) => descriptor.slug).sort();
const allDescriptors = Object.freeze(
  await Promise.all(allKits.map((slug) => loadTrustedMarketKit({ repositoryRoot, slug }))),
);
const runners = Object.freeze(
  Object.fromEntries(
    allDescriptors.map((descriptor) => [descriptor.slug, descriptor.ciRunner]),
  ),
);

const dynamicDescriptors = Object.freeze([
  Object.freeze({ slug: 'zeta', directory: '/fixtures/kits/zeta', ciRunner: 'ubuntu-latest' }),
  Object.freeze({ slug: 'alpha', directory: '/fixtures/kits/alpha', ciRunner: 'macos-14' }),
]);

test('selects only descriptor fixtures without product-specific maps', () => {
  assert.deepEqual(
    selectKitSlugs(['kits/zeta/packages/contracts/src/index.ts'], dynamicDescriptors),
    ['zeta'],
  );
  assert.deepEqual(
    selectKitSlugs(['packages/kit-core/src/model.ts'], dynamicDescriptors),
    ['alpha', 'zeta'],
  );
  assert.throws(
    () => selectKitSlugs(['kits/unknown/a.ts'], dynamicDescriptors),
    /Unknown Kit directory/u,
  );
});

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
  // Copy the root package-lock so loadTrustedMarketKit can verify the Kit
  // lock identity against the descriptor. The lockfile is not committed in
  // root-commit tests but is still readable from the working tree.
  await cp(
    path.join(repositoryRoot, 'package-lock.json'),
    path.join(repository, 'package-lock.json'),
  );
  // Copy the minimum real Task 1 descriptor inputs (kit.json and package.json)
  // for every trusted Kit so loadTrustedMarketKit can resolve ciRunner.
  for (const slug of allKits) {
    await mkdir(path.join(repository, 'kits', slug), { recursive: true });
    await cp(
      path.join(repositoryRoot, 'kits', slug, 'kit.json'),
      path.join(repository, 'kits', slug, 'kit.json'),
    );
    await cp(
      path.join(repositoryRoot, 'kits', slug, 'package.json'),
      path.join(repository, 'kits', slug, 'package.json'),
    );
    const packageJson = JSON.parse(
      await readFile(path.join(repositoryRoot, 'kits', slug, 'package.json'), 'utf8'),
    );
    for (const resource of packageJson.harbors?.resources ?? []) {
      const destination = path.join(repository, 'kits', slug, resource);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(repositoryRoot, 'kits', slug, resource), destination, { recursive: true });
    }
  }
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
  assert.deepEqual(selectKitSlugs(['kits/default/package.json'], allDescriptors), ['default']);
  assert.deepEqual(
    selectKitSlugs(['kits/default/packages/contracts/src/index.ts'], allDescriptors),
    ['default'],
  );
  assert.deepEqual(selectKitSlugs(['kits/default/package.json'], allDescriptors), ['default']);
  assert.deepEqual(selectKitSlugs(['kits/default/packages/contracts/src/index.ts'], allDescriptors), ['default']);
  assert.deepEqual(selectKitSlugs(['kits/default/package.json'], allDescriptors), ['default']);
  assert.deepEqual(selectKitSlugs(['kits/default/packages/contracts/src/index.ts'], allDescriptors), ['default']);
  assert.deepEqual(
    selectKitSlugs(['kits/default/packages/relationship-graph/src/index.ts'], allDescriptors),
    ['default'],
  );
  assert.deepEqual(selectKitSlugs(['kits/default/packages/contracts/src/index.ts'], allDescriptors), ['default']);
  assert.deepEqual(
    selectKitSlugs(['kits/default/packages/relationship-graph/src/index.ts'], allDescriptors),
    ['default'],
  );
  assert.deepEqual(
    selectKitSlugs(['kits/default/packages/contracts/src/index.ts'], allDescriptors),
    ['default'],
  );
  assert.deepEqual(selectKitSlugs(['kits/default/package.json'], allDescriptors), ['default']);
  assert.deepEqual(
    selectKitSlugs(['kits/default/main.html', 'kits/default/layout.json'], allDescriptors),
    ['default'],
  );
  assert.deepEqual(selectKitSlugs(['kits/default', 'kits/default/kit.json'], allDescriptors), ['default']);
});

test('ignores unrelated paths and rejects an undiscovered Kit directory', () => {
  assert.deepEqual(selectKitSlugs(['docs/README.md'], allDescriptors), []);
  assert.throws(() => selectKitSlugs(['kits/unknown/kit.json'], allDescriptors), /Unknown Kit directory/u);
});

test('selects all official Kits for shared build, validation, and workflow paths', () => {
  for (const sharedPath of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'packages/kit-core/src/schema.ts',
    'packages/kit-cli/src/archive.ts',
    'scripts/check-kit.mjs',
    'scripts/lib/kit-check.mjs',
    'scripts/lib/kit-monorepo.mjs',
    'scripts/lib/kit-ci-selection.mjs',
    'scripts/select-kit-ci.mjs',
    '.github/workflows/kit-ci.yml',
  ]) {
    assert.deepEqual(selectKitSlugs([sharedPath], allDescriptors), allKits, sharedPath);
  }
});

test('selects every descriptor for shared framework and workflow surfaces', () => {
  const cases = [
    ['scripts/ce-plugin.mjs', allKits],
    ['scripts/lib/plugin-build/validate.mjs', allKits],
  ];
  for (const [changedPath, expected] of cases) {
    assert.deepEqual(selectKitSlugs([changedPath], allDescriptors), expected, changedPath);
  }
});

test('rejects unknown Kit directories', () => {
  assert.throws(
    () => selectKitSlugs(['kits/unknown/package.json'], allDescriptors),
    /unknown Kit directory/i,
  );
  assert.throws(() => selectKitSlugs(['kits/unknown'], allDescriptors), /unknown Kit directory/i);
});

test('rejects non-canonical repository paths instead of ambiguously classifying them', () => {
  for (const changedPath of [
    '',
    '/kits/default/package.json',
    'C:/kits/default/package.json',
    '../kits/default/package.json',
    './kits/default/package.json',
    'kits/./default/package.json',
    'kits/default/../default/package.json',
    'kits//default/package.json',
    'kits/default/',
    'kits\\default\\package.json',
    'kits/default/bad\0name',
    'kits/default/bad\nname',
    'kits/default/bad\u0085name',
  ]) {
    assert.throws(
      () => selectKitSlugs([changedPath], allDescriptors),
      /canonical repository path/i,
      JSON.stringify(changedPath),
    );
  }
  assert.throws(() => selectKitSlugs('kits/default/package.json', allDescriptors), /paths must be an array/i);
  assert.throws(() => selectKitSlugs([null], allDescriptors), /canonical repository path/i);
});

test('rejects invalid descriptor collections', () => {
  assert.throws(
    () => selectKitSlugs([], 'default'),
    /descriptors must be an array/u,
  );
  for (const descriptors of [
    ['default', 'default'],
    ['../default'],
    ['SQLite'],
    ['default-'],
    ['default--next'],
    [null],
  ]) {
    assert.throws(
      () => selectKitSlugs([], descriptors),
      /descriptors/u,
      JSON.stringify(descriptors),
    );
  }
});

test('CLI selects descriptor-derived runners from a real NUL-delimited Git diff', async () => {
  const repository = await initializeRepository();
  try {
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    const base = await commitAll(repository, 'initial');
    await mkdir(path.join(repository, 'kits/default'), { recursive: true });
    await writeFile(path.join(repository, 'kits/default/main.html'), '<main></main>\n');
    const head = await commitAll(repository, 'default');

    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      'MATRIX_JSON={"include":[{"kit":"default","runner":"ubuntu-latest"}]}\nHAS_KITS=true\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI includes current root-commit paths when the comparison base is the root', async () => {
  const repository = await initializeRepository({ seedRoot: false });
  try {
    // initializeRepository copied every trusted Kit descriptor; stage only the
    // default descriptor paths so the root diff selects default alone.
    await git(repository, 'add', 'kits/default/kit.json', 'kits/default/package.json');
    await git(repository, 'commit', '-qm', 'root Kit');
    const rootCommit = await git(repository, 'rev-parse', 'HEAD');

    const result = await runCli(repository, [rootCommit, rootCommit]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'MATRIX_JSON={"include":[{"kit":"default","runner":"ubuntu-latest"}]}\nHAS_KITS=true\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI includes deletions and both sides of renames in Kit selection', async (t) => {
  const cases = [
    {
      name: 'deleted Kit file',
      source: 'kits/default/removed.txt',
      destination: null,
      expected: ['default'],
    },
    {
      name: 'deleted shared file',
      source: 'scripts/check-kit.mjs',
      destination: null,
      expected: allKits,
    },
    {
      name: 'Kit file renamed to docs',
      source: 'kits/default/moved.txt',
      destination: 'docs/moved.txt',
      expected: ['default'],
    },
    {
      name: 'docs file renamed into a Kit',
      source: 'docs/moved.txt',
      destination: 'kits/default/moved.txt',
      expected: ['default'],
    },
    {
      name: 'file renamed within Kit',
      source: 'kits/default/moved.txt',
      destination: 'kits/default/renamed.txt',
      expected: ['default'],
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
    await mkdir(path.join(repository, 'kits/default'), { recursive: true });
    await writeFile(path.join(repository, 'kits/default/bad\nname'), 'unsafe\n');
    const head = await commitAll(repository, 'unsafe filename');

    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^ERROR=Changed path must be a canonical repository path\n$/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('CLI validates descriptor files instead of reading policy metadata', async () => {
  const repository = await initializeRepository();
  try {
    await writeFile(path.join(repository, 'README.md'), 'initial\n');
    const base = await commitAll(repository, 'initial');
    await mkdir(path.join(repository, 'kits/default'), { recursive: true });
    await writeFile(path.join(repository, 'kits/default/package.json'), '{}\n');
    const head = await commitAll(repository, 'default');
    const result = await runCli(repository, [base, head]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^ERROR=Kit identity mismatch for default/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('descriptors are discovered directly from kits/ with matching slug and identity', async () => {
  const descriptors = await discoverRepositoryKits({ repositoryRoot });
  for (const descriptor of descriptors) {
    assert.equal(descriptor.slug, descriptor.id, descriptor.slug);
    assert.equal(typeof descriptor.ciRunner, 'string', descriptor.slug);
    assert.ok(descriptor.directory.endsWith(path.join('kits', descriptor.slug)), descriptor.slug);
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
