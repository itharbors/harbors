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
const taskId = '2026-08-05-finish-case';

function nulRecords(values) {
  return Buffer.from(`${values.join(String.fromCharCode(0))}${String.fromCharCode(0)}`);
}

test('accepts in-boundary add, modify, delete, rename, and copy records', () => {
  assert.deepEqual(validateKitChangePaths({
    slug: 'default',
    taskId,
    records: [
      { status: 'A', paths: ['kits/default/new.ts'] },
      { status: 'M', paths: ['kits/default/package.json'] },
      { status: 'D', paths: ['kits/default/old.ts'] },
      { status: 'R100', paths: ['kits/default/from.ts', 'kits/default/to.ts'] },
      { status: 'C075', paths: ['kits/default/source.ts', 'kits/default/copy.ts'] },
      { status: 'A', paths: [`docs/tasks/${taskId}/task.md`] },
      { status: 'M', paths: [`docs/tasks/${taskId}/status.json`] },
      { status: 'A', paths: [`docs/tasks/${taskId}/summary.md`] },
    ],
  }), {
    paths: [
      'kits/default/new.ts',
      'kits/default/package.json',
      'kits/default/old.ts',
      'kits/default/from.ts',
      'kits/default/to.ts',
      'kits/default/source.ts',
      'kits/default/copy.ts',
      `docs/tasks/${taskId}/task.md`,
      `docs/tasks/${taskId}/status.json`,
      `docs/tasks/${taskId}/summary.md`,
    ],
  });
});

test('accepts spaces inside the exact Kit boundary', () => {
  assert.deepEqual(validateKitChangePaths({
    slug: 'default',
    taskId,
    records: [{ status: 'A', paths: ['kits/default/with space.txt'] }],
  }), { paths: ['kits/default/with space.txt'] });
});

test('rejects either side of a rename outside the exact Kit boundary', () => {
  for (const paths of [
    ['kits/default/a.ts', 'scripts/a.ts'],
  ]) {
    assert.throws(
      () => validateKitChangePaths({ slug: 'default', taskId, records: [{ status: 'R100', paths }] }),
      /outside kits\/default/u,
    );
  }
});

test('rejects other Kits, root files, and deceptive path forms', () => {
  const newline = String.fromCharCode(10);
  const nul = String.fromCharCode(0);
  for (const changedPath of [
    'package-lock.json',
    '/kits/default/a.ts',
    'C:/kits/default/a.ts',
    'kits\\default\\a.ts',
    'kits/default/../default/a.ts',
    'kits/default//a.ts',
    `kits/default/bad${newline}name.ts`,
    `kits/default/bad${nul}name.ts`,
  ]) {
    assert.throws(
      () => validateKitChangePaths({
        slug: 'default',
        taskId,
        records: [{ status: 'M', paths: [changedPath] }],
      }),
      /outside kits\/default|unsafe path/u,
      JSON.stringify(changedPath),
    );
  }
});

test('rejects invalid slugs, Task IDs, records, statuses, and path counts', () => {
  for (const slug of ['', 'SQLite', '-default', 'default-', 'sql--ite', '../default', null]) {
    assert.throws(
      () => validateKitChangePaths({ slug, taskId, records: [] }),
      /invalid Kit slug/u,
    );
  }
  assert.deepEqual(
    validateKitChangePaths({ slug: 'default', taskId: '0001-01-01-valid-task', records: [] }),
    { paths: [] },
  );
  for (const invalidTaskId of ['', 'finish-case', '0000-01-01-finish-case', '2026-8-05-finish-case', '2026-02-31-finish-case', '2026-08-05', '2026-08-05-finish/case', '.', '..', null]) {
    assert.throws(
      () => validateKitChangePaths({ slug: 'default', taskId: invalidTaskId, records: [] }),
      /invalid Task ID/u,
    );
  }
  assert.throws(
    () => validateKitChangePaths({ slug: 'default', taskId, records: null }),
    /records must be an array/u,
  );
  for (const status of ['X', 'R101', 'R99', 'C999', 'MM']) {
    assert.throws(
      () => validateKitChangePaths({
        slug: 'default',
        taskId,
        records: [{ status, paths: ['kits/default/a.ts'] }],
      }),
      /invalid change status/u,
    );
  }
  assert.throws(
    () => validateKitChangePaths({
      slug: 'default',
      taskId,
      records: [{ status: 'R100', paths: ['kits/default/a.ts'] }],
    }),
    /must have 2 path/u,
  );
});

test('rejects every non-exact Task path and cross-boundary rename or copy', () => {
  const rejectedPaths = [
    'docs/tasks/2026-08-05-other/status.json',
    `docs/tasks/${taskId}/README.md`,
    `docs/tasks/${taskId}/extra.md`,
    `docs/tasks/${taskId}/.work/notes.md`,
    `docs/tasks/${taskId}/subdir/task.md`,
  ];
  for (const changedPath of rejectedPaths) {
    assert.throws(
      () => validateKitChangePaths({
        slug: 'default',
        taskId,
        records: [{ status: 'A', paths: [changedPath] }],
      }),
      /outside the declared Kit and Task boundary/u,
      changedPath,
    );
  }
  for (const [status, paths] of [
    ['R100', [`docs/tasks/${taskId}/task.md`, 'kits/default/task.md']],
    ['R100', ['kits/default/task.md', `docs/tasks/${taskId}/task.md`]],
    ['C100', [`docs/tasks/${taskId}/summary.md`, 'kits/default/summary.md']],
    ['C100', ['kits/default/summary.md', `docs/tasks/${taskId}/summary.md`]],
  ]) {
    assert.throws(
      () => validateKitChangePaths({ slug: 'default', taskId, records: [{ status, paths }] }),
      /rename or copy must stay within one allowed boundary/u,
    );
  }
});

test('parses NUL-delimited name-status output including both rename paths', () => {
  assert.deepEqual(parseDiffNameStatus(nulRecords([
    'A', 'kits/default/a.ts',
    'M', 'kits/default/package.json',
    'D', 'kits/default/old.ts',
    'R100', 'kits/default/from.ts', 'kits/default/to.ts',
  ])), [
    { status: 'A', paths: ['kits/default/a.ts'] },
    { status: 'M', paths: ['kits/default/package.json'] },
    { status: 'D', paths: ['kits/default/old.ts'] },
    { status: 'R100', paths: ['kits/default/from.ts', 'kits/default/to.ts'] },
  ]);
  assert.deepEqual(parseDiffNameStatus(Buffer.alloc(0)), []);
});

test('rejects malformed or non-UTF-8 name-status output', () => {
  assert.throws(
    () => parseDiffNameStatus(Buffer.from('M\0kits/default/a.ts', 'utf8')),
    /not NUL terminated/u,
  );
  assert.throws(
    () => parseDiffNameStatus(nulRecords(['R100', 'kits/default/from.ts'])),
    /unexpected end/u,
  );
  assert.throws(
    () => parseDiffNameStatus(Buffer.from([0xff, 0x00])),
    /not valid UTF-8/u,
  );
});

test('parses only regular NUL-delimited stage-zero index entries', () => {
  const modes = parseLsFilesStageOutput(nulRecords([
    `100644 ${objectName} 0\tkits/default/package.json`,
    `100755 ${objectName} 0\tkits/default/run.sh`,
  ]));
  assert.deepEqual([...modes], [
    ['kits/default/package.json', '100644'],
    ['kits/default/run.sh', '100755'],
  ]);
});

test('rejects malformed, duplicate, unmerged, symlink, and gitlink index entries', () => {
  for (const [entry, pattern] of [
    [`100644 ${objectName} 1\tkits/default/a.ts`, /unmerged/u],
    [`120000 ${objectName} 0\tkits/default/link`, /disallowed file mode/u],
    [`160000 ${objectName} 0\tkits/default/submodule`, /disallowed file mode/u],
    [`100644 short 0\tkits/default/a.ts`, /malformed object name/u],
    [`100644 ${objectName} 0 kits/default/a.ts`, /missing path separator/u],
  ]) {
    assert.throws(() => parseLsFilesStageOutput(nulRecords([entry])), pattern);
  }
  const duplicate = `100644 ${objectName} 0\tkits/default/a.ts`;
  assert.throws(
    () => parseLsFilesStageOutput(nulRecords([duplicate, duplicate])),
    /duplicate index entry/u,
  );
  assert.throws(
    () => parseLsFilesStageOutput(Buffer.from([0x00])),
    /empty entry/u,
  );
  assert.throws(
    () => parseLsFilesStageOutput(Buffer.concat([nulRecords([duplicate]), Buffer.from([0x00])])),
    /empty entry/u,
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
    await mkdir(path.join(repositoryRoot, 'kits', 'default'), { recursive: true });
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'package.json'), '{}\n');
    const base = await commitAll(repositoryRoot, 'initial');
    await action({ base, repositoryRoot });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test('reads and validates a real in-boundary modification', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'package.json'), '{"v":1}\n');
    const head = await commitAll(repositoryRoot, 'modify');
    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{ status: 'M', paths: ['kits/default/package.json'] }],
    );
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      { paths: ['kits/default/package.json'] },
    );
  });
});

test('validates the exact three real Task files with Git name-status and modes', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    const taskDirectory = path.join(repositoryRoot, 'docs', 'tasks', taskId);
    await mkdir(taskDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(taskDirectory, 'task.md'), '# Task\n'),
      writeFile(path.join(taskDirectory, 'status.json'), '{"task":"fixture"}\n'),
      writeFile(path.join(taskDirectory, 'summary.md'), '# Summary\n'),
    ]);
    const head = await commitAll(repositoryRoot, 'add Task files');
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      { paths: [
        `docs/tasks/${taskId}/status.json`,
        `docs/tasks/${taskId}/summary.md`,
        `docs/tasks/${taskId}/task.md`,
      ] },
    );
  });
});

test('treats independently generated similar Task status files as additions', async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const previousTaskDirectory = path.join(
      repositoryRoot,
      'docs',
      'tasks',
      '2026-08-04-task-development-lifecycle',
    );
    await mkdir(previousTaskDirectory, { recursive: true });
    await writeFile(path.join(previousTaskDirectory, 'status.json'), `${JSON.stringify({
      schemaVersion: 1,
      taskId: '2026-08-04-task-development-lifecycle',
      type: 'feature',
      updatedAt: '2026-08-04T00:00:00.000Z',
      stages: {
        requirements: 'completed',
        design: 'completed',
        implementation: 'completed',
        verification: 'completed',
        consolidation: 'completed',
      },
      pullRequest: 42,
    }, null, 2)}\n`);
    const base = await commitAll(repositoryRoot, 'add previous Task status');

    const currentTaskDirectory = path.join(repositoryRoot, 'docs', 'tasks', taskId);
    await mkdir(currentTaskDirectory, { recursive: true });
    await writeFile(path.join(currentTaskDirectory, 'status.json'), `${JSON.stringify({
      schemaVersion: 1,
      taskId,
      type: 'refactor',
      updatedAt: '2026-08-07T00:00:00.000Z',
      stages: {
        requirements: 'completed',
        design: 'completed',
        implementation: 'completed',
        verification: 'completed',
        consolidation: 'in_progress',
      },
      pullRequest: null,
    }, null, 2)}\n`);
    const head = await commitAll(repositoryRoot, 'add current Task status');

    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{ status: 'A', paths: [`docs/tasks/${taskId}/status.json`] }],
    );
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      { paths: [`docs/tasks/${taskId}/status.json`] },
    );
  });
});

test('real CLI rejects an unchanged Kit source copied into the current Task boundary', async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const content = 'copy detection fixture\n';
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'template.md'), content);
    const base = await commitAll(repositoryRoot, 'add Kit template');
    const taskDirectory = path.join(repositoryRoot, 'docs', 'tasks', taskId);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(path.join(taskDirectory, 'summary.md'), content);
    const head = await commitAll(repositoryRoot, 'copy Kit template into Task');

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, 'default', '--task', taskId, '--base', base, '--head', head],
        { cwd: repositoryRoot, encoding: 'utf8' },
      ),
      /rename or copy must stay within one allowed boundary/u,
    );
    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{
        status: 'C100',
        paths: ['kits/default/template.md', `docs/tasks/${taskId}/summary.md`],
      }],
    );
  });
});

test('real CLI rejects an unchanged current Task source copied into the Kit boundary', async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const content = 'reverse copy detection fixture\n';
    const taskDirectory = path.join(repositoryRoot, 'docs', 'tasks', taskId);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(path.join(taskDirectory, 'summary.md'), content);
    const base = await commitAll(repositoryRoot, 'add Task summary');
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'copied.md'), content);
    const head = await commitAll(repositoryRoot, 'copy Task summary into Kit');

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, 'default', '--task', taskId, '--base', base, '--head', head],
        { cwd: repositoryRoot, encoding: 'utf8' },
      ),
      /rename or copy must stay within one allowed boundary/u,
    );
    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{
        status: 'C100',
        paths: [`docs/tasks/${taskId}/summary.md`, 'kits/default/copied.md'],
      }],
    );
  });
});

test('real same-boundary copies remain allowed inside a Kit and inside the current Task', async () => {
  await withRepository(async ({ repositoryRoot }) => {
    const content = 'same Kit copy\n';
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'template.md'), content);
    const base = await commitAll(repositoryRoot, 'add Kit copy source');
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'copied.md'), content);
    const head = await commitAll(repositoryRoot, 'copy inside Kit');
    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{ status: 'C100', paths: ['kits/default/template.md', 'kits/default/copied.md'] }],
    );
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      { paths: ['kits/default/template.md', 'kits/default/copied.md'] },
    );
  });

  await withRepository(async ({ repositoryRoot }) => {
    const content = 'same Task copy\n';
    const taskDirectory = path.join(repositoryRoot, 'docs', 'tasks', taskId);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(path.join(taskDirectory, 'task.md'), content);
    const base = await commitAll(repositoryRoot, 'add Task copy source');
    await writeFile(path.join(taskDirectory, 'summary.md'), content);
    const head = await commitAll(repositoryRoot, 'copy inside Task');
    assert.deepEqual(
      await readChangedPathRecords({ repositoryRoot, base, head }),
      [{
        status: 'C100',
        paths: [`docs/tasks/${taskId}/task.md`, `docs/tasks/${taskId}/summary.md`],
      }],
    );
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      { paths: [`docs/tasks/${taskId}/task.md`, `docs/tasks/${taskId}/summary.md`] },
    );
  });
});

test('allows a real deletion and an in-boundary rename with absent source modes', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'old.ts'), 'old\n');
    const withOld = await commitAll(repositoryRoot, 'add old');
    await git(repositoryRoot, 'mv', 'kits/default/old.ts', 'kits/default/new.ts');
    const renamed = await commitAll(repositoryRoot, 'rename');
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base: withOld, head: renamed }),
      { paths: ['kits/default/old.ts', 'kits/default/new.ts'] },
    );
    await rm(path.join(repositoryRoot, 'kits', 'default', 'new.ts'));
    const deleted = await commitAll(repositoryRoot, 'delete');
    assert.deepEqual(
      await validateKitChange({ repositoryRoot, slug: 'default', taskId, base: renamed, head: deleted }),
      { paths: ['kits/default/new.ts'] },
    );
    assert.match(base, /^[0-9a-f]{40}$/u);
  });
});

test('rejects a real out-of-boundary commit', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'package-lock.json'), '{}\n');
    const head = await commitAll(repositoryRoot, 'root change');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      /outside kits\/default/u,
    );
  });
});

test('rejects real symlink and gitlink modes inside a Kit', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await symlink('package.json', path.join(repositoryRoot, 'kits', 'default', 'link'));
    const symlinkHead = await commitAll(repositoryRoot, 'symlink');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head: symlinkHead }),
      /disallowed file mode.*120000/u,
    );
  });
  await withRepository(async ({ base, repositoryRoot }) => {
    await git(
      repositoryRoot,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${base},kits/default/submodule`,
    );
    await git(repositoryRoot, 'commit', '-qm', 'gitlink');
    const head = await git(repositoryRoot, 'rev-parse', 'HEAD');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      /disallowed file mode.*160000/u,
    );
  });
});

test('does not relax unsafe modes for exact Task files', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    const taskDirectory = path.join(repositoryRoot, 'docs', 'tasks', taskId);
    await mkdir(taskDirectory, { recursive: true });
    await symlink('elsewhere', path.join(taskDirectory, 'summary.md'));
    const head = await commitAll(repositoryRoot, 'Task symlink');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head }),
      /disallowed file mode.*120000/u,
    );
  });
});

test('rejects a requested unsafe head when the checkout and index remain at a safe commit', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await symlink('package.json', path.join(repositoryRoot, 'kits', 'default', 'link'));
    const unsafeHead = await commitAll(repositoryRoot, 'unsafe head');
    await git(repositoryRoot, 'reset', '--hard', base);
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head: unsafeHead }),
      /head revision must resolve to the checked-out HEAD/u,
    );
  });
});

test('rejects an index that does not match the checked-out head', async () => {
  await withRepository(async ({ base, repositoryRoot }) => {
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'staged.ts'), 'staged\n');
    await git(repositoryRoot, 'add', 'kits/default/staged.ts');
    await assert.rejects(
      validateKitChange({ repositoryRoot, slug: 'default', taskId, base, head: 'HEAD' }),
      /index must match the checked-out HEAD/u,
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
    ['default', '--task', taskId, '--base', 'base', '--head', 'head'],
    capture.io,
    {
      repositoryRoot: '/repository',
      validateKitChange: async (input) => {
        calls.push(input);
        return { paths: ['kits/default/a.ts', 'kits/default/b.ts'] };
      },
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(calls, [{
      repositoryRoot: '/repository',
      slug: 'default',
      taskId,
      base: 'base',
    head: 'head',
  }]);
  assert.deepEqual(capture.output(), {
    stdout: 'BOUNDARY_KIT=default\nBOUNDARY_FILES=2\n',
    stderr: '',
  });
});

test('CLI rejects usage before validation and sanitizes operational errors', async () => {
  let calls = 0;
  for (const args of [
    [],
    ['SQLite', '--task', taskId, '--base', 'a', '--head', 'b'],
    ['default', '--base', 'a', '--task', taskId, '--head', 'b'],
    ['default', '--task', taskId, '--task', taskId, '--base', 'a', '--head', 'b'],
    ['default', '--task', taskId, '--base', 'a', '--head', 'b', 'extra'],
    ['default', '--task', taskId, '--base', 'a', '--unknown', 'b'],
    ['default', '--task', 'bad/task', '--base', 'a', '--head', 'b'],
  ]) {
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
    ['default', '--task', taskId, '--base', 'a', '--head', 'b'],
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
    await writeFile(path.join(repositoryRoot, 'kits', 'default', 'package.json'), '{"v":1}\n');
    const head = await commitAll(repositoryRoot, 'change');
    const result = await execFileAsync(
      process.execPath,
      [cli, 'default', '--task', taskId, '--base', base, '--head', head],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(result.stdout, 'BOUNDARY_KIT=default\nBOUNDARY_FILES=1\n');
    assert.equal(result.stderr, '');
  });
});
