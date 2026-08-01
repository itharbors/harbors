import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { runCheckKitBoundaryCli } from '../check-kit-boundary.mjs';
import {
  parseDiffNameStatus,
  parseLsFilesStageOutput,
  readChangedPathRecords,
  readIndexModes,
  validateKitChange,
  validateKitChangePaths,
} from './kit-boundary.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../check-kit-boundary.mjs', import.meta.url));
const objectName = 'a'.repeat(40);

function nulRecords(values) {
  return Buffer.from(`${values.join(String.fromCharCode(0))}${String.fromCharCode(0)}`);
}

test('accepts in-boundary add, modify, delete, rename, and copy records', () => {
  assert.deepEqual(validateKitChangePaths({
    slug: 'sqlite',
    records: [
      { status: 'A', paths: ['kits/sqlite/new.ts'] },
      { status: 'M', paths: ['kits/sqlite/package.json'] },
      { status: 'D', paths: ['kits/sqlite/old.ts'] },
      { status: 'R100', paths: ['kits/sqlite/from.ts', 'kits/sqlite/to.ts'] },
      { status: 'C075', paths: ['kits/sqlite/source.ts', 'kits/sqlite/copy.ts'] },
    ],
  }), {
    paths: [
      'kits/sqlite/new.ts',
      'kits/sqlite/package.json',
      'kits/sqlite/old.ts',
      'kits/sqlite/from.ts',
      'kits/sqlite/to.ts',
      'kits/sqlite/source.ts',
      'kits/sqlite/copy.ts',
    ],
  });
});

test('accepts spaces inside the exact Kit boundary', () => {
  assert.deepEqual(validateKitChangePaths({
    slug: 'sqlite',
    records: [{ status: 'A', paths: ['kits/sqlite/with space.txt'] }],
  }), { paths: ['kits/sqlite/with space.txt'] });
});

test('rejects either side of a rename outside the exact Kit boundary', () => {
  for (const paths of [
    ['kits/sqlite/a.ts', 'scripts/a.ts'],
    ['kits/mysql/a.ts', 'kits/sqlite/a.ts'],
  ]) {
    assert.throws(
      () => validateKitChangePaths({ slug: 'sqlite', records: [{ status: 'R100', paths }] }),
      /outside kits\/sqlite/u,
    );
  }
});

test('rejects other Kits, root files, and deceptive path forms', () => {
  const newline = String.fromCharCode(10);
  const nul = String.fromCharCode(0);
  for (const changedPath of [
    'kits/mysql/package.json',
    'package-lock.json',
    '/kits/sqlite/a.ts',
    'C:/kits/sqlite/a.ts',
    'kits\\sqlite\\a.ts',
    'kits/sqlite/../mysql/a.ts',
    'kits/sqlite//a.ts',
    `kits/sqlite/bad${newline}name.ts`,
    `kits/sqlite/bad${nul}name.ts`,
  ]) {
    assert.throws(
      () => validateKitChangePaths({
        slug: 'sqlite',
        records: [{ status: 'M', paths: [changedPath] }],
      }),
      /outside kits\/sqlite|unsafe path/u,
      JSON.stringify(changedPath),
    );
  }
});

test('rejects invalid slugs, records, statuses, and path counts', () => {
  for (const slug of ['', 'SQLite', '-sqlite', 'sqlite-', 'sql--ite', '../sqlite', null]) {
    assert.throws(
      () => validateKitChangePaths({ slug, records: [] }),
      /invalid Kit slug/u,
    );
  }
  assert.throws(
    () => validateKitChangePaths({ slug: 'sqlite', records: null }),
    /records must be an array/u,
  );
  for (const status of ['X', 'R101', 'R99', 'C999', 'MM']) {
    assert.throws(
      () => validateKitChangePaths({
        slug: 'sqlite',
        records: [{ status, paths: ['kits/sqlite/a.ts'] }],
      }),
      /invalid change status/u,
    );
  }
  assert.throws(
    () => validateKitChangePaths({
      slug: 'sqlite',
      records: [{ status: 'R100', paths: ['kits/sqlite/a.ts'] }],
    }),
    /must have 2 path/u,
  );
});

test('parses NUL-delimited name-status output including both rename paths', () => {
  assert.deepEqual(parseDiffNameStatus(nulRecords([
    'A', 'kits/sqlite/a.ts',
    'M', 'kits/sqlite/package.json',
    'D', 'kits/sqlite/old.ts',
    'R100', 'kits/sqlite/from.ts', 'kits/sqlite/to.ts',
  ])), [
    { status: 'A', paths: ['kits/sqlite/a.ts'] },
    { status: 'M', paths: ['kits/sqlite/package.json'] },
    { status: 'D', paths: ['kits/sqlite/old.ts'] },
    { status: 'R100', paths: ['kits/sqlite/from.ts', 'kits/sqlite/to.ts'] },
  ]);
  assert.deepEqual(parseDiffNameStatus(Buffer.alloc(0)), []);
});

test('rejects malformed or non-UTF-8 name-status output', () => {
  assert.throws(
    () => parseDiffNameStatus(Buffer.from('M\0kits/sqlite/a.ts', 'utf8')),
    /not NUL terminated/u,
  );
  assert.throws(
    () => parseDiffNameStatus(nulRecords(['R100', 'kits/sqlite/from.ts'])),
    /unexpected end/u,
  );
  assert.throws(
    () => parseDiffNameStatus(Buffer.from([0xff, 0x00])),
    /not valid UTF-8/u,
  );
});

test('parses only regular NUL-delimited stage-zero index entries', () => {
  const modes = parseLsFilesStageOutput(nulRecords([
    `100644 ${objectName} 0\tkits/sqlite/package.json`,
    `100755 ${objectName} 0\tkits/sqlite/run.sh`,
  ]));
  assert.deepEqual([...modes], [
    ['kits/sqlite/package.json', '100644'],
    ['kits/sqlite/run.sh', '100755'],
  ]);
});

test('rejects malformed, duplicate, unmerged, symlink, and gitlink index entries', () => {
  for (const [entry, pattern] of [
    [`100644 ${objectName} 1\tkits/sqlite/a.ts`, /unmerged/u],
    [`120000 ${objectName} 0\tkits/sqlite/link`, /disallowed file mode/u],
    [`160000 ${objectName} 0\tkits/sqlite/submodule`, /disallowed file mode/u],
    [`100644 short 0\tkits/sqlite/a.ts`, /malformed object name/u],
    [`100644 ${objectName} 0 kits/sqlite/a.ts`, /missing path separator/u],
  ]) {
    assert.throws(() => parseLsFilesStageOutput(nulRecords([entry])), pattern);
  }
  const duplicate = `100644 ${objectName} 0\tkits/sqlite/a.ts`;
  assert.throws(
    () => parseLsFilesStageOutput(nulRecords([duplicate, duplicate])),
    /duplicate index entry/u,
  );
});

async function git(repositoryRoot, ...args) {
  return (await execFileAsync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })).stdout.trim();
}

async function commitAll(repositoryRoot, message) {
  await git(repositoryRoot, 'add', '-A');
  await git(repositoryRoot, 'commit', '-qm', message);
  return git(repositoryRoot, 'rev-parse', 'HEAD');
}

async function withRepository(action) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'kit-boundary-'));
  try {
    await git(repositoryRoot, 'init', '-q');
    await git(repositoryRoot, 'config', 'user.name', 'Kit Boundary Test');
    await git(repositoryRoot, 'config', 'user.email', 'kit-boundary@example.test');
    await mkdir(path.join(repositoryRoot, 'kits', 'sqlite'), { recursive: true });
    await writeFile(path.join(repositoryRoot, 'kits', 'sqlite', 'package.json'), '{}\n');
    const base = await commitAll(repositoryRoot, 'initial');
    await action({ base, repositoryRoot });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test('reads and validates a real in-boundary modification', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'kits', 'sqlite', 'package.json'), '{"v":1}\n');
    const head = await commitAll(repositoryRoot, 'modify');
    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{ status: 'M', paths: ['kits/sqlite/package.json'] }],
    );
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'sqlite', base, head }),
      { paths: ['kits/sqlite/package.json'] },
    );
  });
});

test('allows a real deletion and an in-boundary rename with absent source modes', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'kits', 'sqlite', 'old.ts'), 'old\n');
    const withOld = await commitAll(repositoryRoot, 'add old');
    await git(repositoryRoot, 'mv', 'kits/sqlite/old.ts', 'kits/sqlite/new.ts');
    const renamed = await commitAll(repositoryRoot, 'rename');
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'sqlite', base: withOld, head: renamed }),
      { paths: ['kits/sqlite/old.ts', 'kits/sqlite/new.ts'] },
    );
    await rm(path.join(repositoryRoot, 'kits', 'sqlite', 'new.ts'));
    const deleted = await commitAll(repositoryRoot, 'delete');
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'sqlite', base: renamed, head: deleted }),
      { paths: ['kits/sqlite/new.ts'] },
    );
    assert.match(base, /^[0-9a-f]{40}$/u);
  });
});

test('rejects a real out-of-boundary commit', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'package-lock.json'), '{}\n');
    const head = await commitAll(repositoryRoot, 'root change');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'sqlite', base, head }),
      /outside kits\/sqlite/u,
    );
  });
});

test('rejects real symlink and gitlink modes inside a Kit', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await symlink('package.json', path.join(repositoryRoot, 'kits', 'sqlite', 'link'));
    const symlinkHead = await commitAll(repositoryRoot, 'symlink');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'sqlite', base, head: symlinkHead }),
      /disallowed file mode.*120000/u,
    );
  });
  await withRepository(async ({ base, repositoryRoot }) => {
    await git(
      repositoryRoot,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${base},kits/sqlite/submodule`,
    );
    await git(repositoryRoot, 'commit', '-qm', 'gitlink');
    const head = await git(repositoryRoot, 'rev-parse', 'HEAD');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'sqlite', base, head }),
      /disallowed file mode.*160000/u,
    );
  });
});

test('rejects invalid revisions without treating them as Git options', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    for (const revision of ['', '--no-index', `HEAD${String.fromCharCode(10)}--help`]) {
      await assert.rejects(
        readChangedPathRecords({ repositoryRoot, base: revision, head: base }),
        /invalid Git revision/u,
      );
    }
  });
});

test('returns no index modes for an empty path collection', async () => {
  assert.equal((await readIndexModes({ repositoryRoot: process.cwd(), paths: [] })).size, 0);
});

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

test('CLI emits exact success output and passes its repository root', async () => {
  const capture = captureIo();
  const calls = [];
  const status = await runCheckKitBoundaryCli(
    ['sqlite', '--base', 'base', '--head', 'head'],
    capture.io,
    {
      repositoryRoot: '/repository',
      validateKitChange: async (input) => {
        calls.push(input);
        return { paths: ['kits/sqlite/a.ts', 'kits/sqlite/b.ts'] };
      },
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(calls, [{
    repositoryRoot: '/repository',
    slug: 'sqlite',
    base: 'base',
    head: 'head',
  }]);
  assert.deepEqual(capture.output(), {
    stdout: 'BOUNDARY_KIT=sqlite\nBOUNDARY_FILES=2\n',
    stderr: '',
  });
});

test('CLI rejects usage before validation and sanitizes operational errors', async () => {
  let calls = 0;
  for (const args of [[], ['SQLite', '--base', 'a', '--head', 'b'], ['sqlite', '--head', 'a', '--base', 'b']]) {
    const capture = captureIo();
    const status = await runCheckKitBoundaryCli(args, capture.io, {
      repositoryRoot: '/repository',
      validateKitChange: async () => { calls += 1; },
    });
    assert.equal(status, 2);
    assert.match(capture.output().stderr, /^Usage:/u);
  }
  assert.equal(calls, 0);

  const capture = captureIo();
  const status = await runCheckKitBoundaryCli(
    ['sqlite', '--base', 'a', '--head', 'b'],
    capture.io,
    {
      repositoryRoot: '/repository',
      validateKitChange: async () => {
        throw new Error(`bad${String.fromCharCode(0)}${String.fromCharCode(10)}message`);
      },
    },
  );
  assert.equal(status, 1);
  assert.deepEqual(capture.output(), { stdout: '', stderr: 'ERROR=bad message\n' });
});

test('real CLI validates process.cwd and emits deterministic output', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'kits', 'sqlite', 'package.json'), '{"v":1}\n');
    const head = await commitAll(repositoryRoot, 'change');
    const result = await execFileAsync(
      process.execPath,
      [cli, 'sqlite', '--base', base, '--head', head],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(result.stdout, 'BOUNDARY_KIT=sqlite\nBOUNDARY_FILES=1\n');
    assert.equal(result.stderr, '');
  });
});
