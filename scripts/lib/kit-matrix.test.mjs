import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createKitMatrixPlan,
  runKitMatrix,
  runKitMatrixCli,
} from '../run-kit-matrix.mjs';

const repositoryRoot = '/repo';
const descriptors = Object.freeze([
  Object.freeze({ slug: 'zeta', id: '@example/kit-zeta', version: '2.0.0', directory: '/repo/kits/zeta', distribution: 'market' }),
  Object.freeze({ slug: 'alpha', id: '@example/kit-alpha', version: '1.0.0', directory: '/repo/kits/alpha', distribution: 'builtin' }),
]);

const installFixture = async ({ descriptor }) => ({
  installRoot: `/runs/${descriptor.slug}/repository/kits/${descriptor.slug}`,
  runRoot: `/runs/${descriptor.slug}`,
});

test('loads the matrix entrypoint before repository Kit dependencies exist on a clean checkout', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'kit-matrix-clean-module-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(
    path.join(fixture, 'run-kit-matrix.mjs'),
    await readFile(new URL('../run-kit-matrix.mjs', import.meta.url)),
  );

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', "await import('./run-kit-matrix.mjs')"], {
    cwd: fixture,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('creates lifecycle commands from descriptors in canonical slug order', () => {
  assert.deepEqual(createKitMatrixPlan({ action: 'build', descriptors }), [
    { slug: 'alpha', id: '@example/kit-alpha', version: '1.0.0', command: 'build', directory: '/repo/kits/alpha', distribution: 'builtin' },
    { slug: 'zeta', id: '@example/kit-zeta', version: '2.0.0', command: 'build', directory: '/repo/kits/zeta', distribution: 'market' },
  ]);
  assert.deepEqual(createKitMatrixPlan({ action: 'test', slugs: ['zeta'], descriptors }), [
    { slug: 'zeta', id: '@example/kit-zeta', version: '2.0.0', command: 'test', directory: '/repo/kits/zeta', distribution: 'market' },
  ]);
  assert.throws(
    () => createKitMatrixPlan({ action: 'check', slugs: ['unknown'], descriptors }),
    /Unknown Kit slug/u,
  );
});

test('rejects non-canonical, duplicate, and ambiguous matrix inputs', () => {
  for (const action of [null, 'CHECK', 'check\n']) {
    assert.throws(() => createKitMatrixPlan({ action, descriptors }), /matrix action/u);
  }
  assert.throws(() => createKitMatrixPlan({ action: 'build', slugs: 'alpha', descriptors }), /slugs must be an array/u);
  for (const slugs of [
    ['alpha', 'alpha'],
    ['../alpha'],
    ['Alpha'],
    ['alpha-'],
    ['alpha--beta'],
    [null],
  ]) {
    assert.throws(() => createKitMatrixPlan({ action: 'build', slugs, descriptors }), /slug/u);
  }
  assert.throws(() => createKitMatrixPlan({
    action: 'build',
    descriptors: [...descriptors, { slug: 'alpha', directory: '/repo/kits/other' }],
  }), /duplicate slug/u);
  assert.throws(() => createKitMatrixPlan({
    action: 'build',
    descriptors: [...descriptors, { slug: 'other', directory: '/repo/kits/alpha' }],
  }), /duplicate directory/u);
  for (const directory of ['relative/kit', '/repo/kits/../kit', null]) {
    assert.throws(() => createKitMatrixPlan({
      action: 'build',
      descriptors: [{ slug: 'other', directory }],
    }), /canonical absolute path/u);
  }
});

test('prepares the fixed Kit runner and executes the exact full check lifecycle for builtin and market Kits', async () => {
  const calls = [];
  const removed = [];
  const temporaryDirectories = ['/tmp/check-alpha', '/tmp/check-zeta'];
  const results = await runKitMatrix({
    action: 'check',
    repositoryRoot,
    descriptors,
    ensureInstall: installFixture,
    run: async (file, args, options) => calls.push({ file, args, options }),
    makeTempDirectory: async () => temporaryDirectories.shift(),
    removeDirectory: async (directory) => removed.push(directory),
  });

  assert.deepEqual(results, [
    { slug: 'alpha', status: 'passed' },
    { slug: 'zeta', status: 'passed' },
  ]);
  assert.deepEqual(calls[0], {
    file: 'npm',
    args: ['run', 'build', '-w', '@itharbors/kit-core', '-w', '@itharbors/kit-cli'],
    options: { cwd: repositoryRoot, encoding: 'utf8' },
  });
  assert.deepEqual(
    calls.slice(1).map(({ args }) => args.slice(1)),
    [
      ['build', '/runs/alpha/repository/kits/alpha'],
      ['test', '/runs/alpha/repository/kits/alpha'],
      ['validate', '/runs/alpha/repository/kits/alpha'],
      ['pack', '/runs/alpha/repository/kits/alpha', '--output', '/tmp/check-alpha/alpha.hkit'],
      ['inspect', '/tmp/check-alpha/alpha.hkit', '--json'],
      ['build', '/runs/zeta/repository/kits/zeta'],
      ['test', '/runs/zeta/repository/kits/zeta'],
      ['validate', '/runs/zeta/repository/kits/zeta'],
      ['pack', '/runs/zeta/repository/kits/zeta', '--output', '/tmp/check-zeta/zeta.hkit'],
      ['inspect', '/tmp/check-zeta/zeta.hkit', '--json'],
    ],
  );
  assert.ok(calls.slice(1).every(({ file, args, options }) => (
    file === process.execPath
    && args[0] === 'packages/kit-cli/dist/cli.js'
    && options.cwd === repositoryRoot
  )));
  assert.deepEqual(removed, [
    '/tmp/check-alpha',
    '/runs/alpha',
    '/tmp/check-zeta',
    '/runs/zeta',
  ]);
});

test('builds an isolated Kit before testing it in the same working root', async () => {
  const calls = [];
  const removed = [];
  const results = await runKitMatrix({
    action: 'test',
    slugs: ['alpha'],
    repositoryRoot,
    descriptors,
    ensureInstall: installFixture,
    run: async (file, args, options) => calls.push({ file, args, options }),
    removeDirectory: async (directory) => removed.push(directory),
  });

  assert.deepEqual(results, [{ slug: 'alpha', status: 'passed' }]);
  assert.deepEqual(calls.slice(1).map(({ args }) => args.slice(1)), [
    ['build', '/runs/alpha/repository/kits/alpha'],
    ['test', '/runs/alpha/repository/kits/alpha'],
  ]);
  assert.deepEqual(removed, ['/runs/alpha']);
});

test('does not test after an isolated build failure and always removes the working root', async () => {
  const calls = [];
  const removed = [];
  await assert.rejects(
    runKitMatrix({
      action: 'test',
      slugs: ['alpha'],
      repositoryRoot,
      descriptors,
      ensureInstall: installFixture,
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (args.includes('build') && args.includes('/runs/alpha/repository/kits/alpha')) {
          throw new Error('build failed');
        }
      },
      removeDirectory: async (directory) => removed.push(directory),
    }),
    /alpha: build failed/u,
  );
  assert.equal(calls.some((call) => call.includes('test')), false);
  assert.deepEqual(removed, ['/runs/alpha']);
});

test('cleans failed checks, continues later Kits, and reports deterministic aggregate results', async () => {
  const calls = [];
  const removed = [];
  let temporaryIndex = 0;
  await assert.rejects(
    runKitMatrix({
      action: 'check',
      repositoryRoot,
      descriptors,
      ensureInstall: installFixture,
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (args.includes('test') && args.includes('/runs/alpha/repository/kits/alpha')) {
          throw new Error('alpha failed');
        }
      },
      makeTempDirectory: async () => `/tmp/failure-${temporaryIndex++}`,
      removeDirectory: async (directory) => removed.push(directory),
    }),
    (error) => {
      assert.match(error.message, /Kit matrix failed: alpha: alpha failed/u);
      assert.deepEqual(error.results, [
        { slug: 'alpha', status: 'failed', error: 'alpha failed' },
        { slug: 'zeta', status: 'passed' },
      ]);
      return true;
    },
  );
  assert.deepEqual(removed, ['/tmp/failure-0', '/runs/alpha', '/tmp/failure-1', '/runs/zeta']);
  assert.ok(calls.some((call) => call.includes('/runs/zeta/repository/kits/zeta')));
  assert.equal(calls.some((call) => call.includes('validate') && call.includes('/runs/alpha/repository/kits/alpha')), false);
});

test('reports cleanup-only failures per Kit and continues later Kits', async () => {
  const visited = [];
  await assert.rejects(
    runKitMatrix({
      action: 'build',
      repositoryRoot,
      descriptors,
      ensureInstall: installFixture,
      run: async (file, args) => {
        if (file !== 'npm') visited.push(args.at(-1));
      },
      removeDirectory: async (directory) => {
        if (directory === '/runs/alpha') throw new Error('alpha cleanup failed');
      },
    }),
    (error) => {
      assert.deepEqual(error.results, [
        { slug: 'alpha', status: 'failed', error: 'cleanup failed: alpha cleanup failed' },
        { slug: 'zeta', status: 'passed' },
      ]);
      return true;
    },
  );
  assert.deepEqual(visited, [
    '/runs/alpha/repository/kits/alpha',
    '/runs/zeta/repository/kits/zeta',
  ]);
});

test('preserves operation and cleanup failures in deterministic order and continues', async () => {
  await assert.rejects(
    runKitMatrix({
      action: 'build',
      repositoryRoot,
      descriptors,
      ensureInstall: installFixture,
      run: async (file, args) => {
        if (file !== 'npm' && args.includes('/runs/alpha/repository/kits/alpha')) {
          throw new Error('alpha operation failed');
        }
      },
      removeDirectory: async (directory) => {
        if (directory === '/runs/alpha') throw new Error('alpha cleanup failed');
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        'Kit matrix failed: alpha: alpha operation failed; cleanup failed: alpha cleanup failed',
      );
      assert.deepEqual(error.results, [
        {
          slug: 'alpha',
          status: 'failed',
          error: 'alpha operation failed; cleanup failed: alpha cleanup failed',
        },
        { slug: 'zeta', status: 'passed' },
      ]);
      return true;
    },
  );
});

test('CLI sanitizes control-bearing failures into one line and rejects malicious slug argv', async () => {
  const output = [];
  const io = {
    stdout: { write: (value) => output.push(['stdout', value]) },
    stderr: { write: (value) => output.push(['stderr', value]) },
  };
  const code = await runKitMatrixCli(['build', 'alpha'], io, {
    repositoryRoot,
    descriptors,
    ensureInstall: installFixture,
    run: async (file) => {
      if (file !== 'npm') throw new Error('unsafe\nmessage\u0000with\u0085controls\u2028done');
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(output, [
    ['stdout', 'KIT=alpha STATUS=failed\n'],
    ['stderr', 'ERROR=Kit matrix failed: alpha: unsafe message with controls done\n'],
  ]);
  assert.doesNotMatch(
    output.map(([, value]) => value.replace(/\n$/u, '')).join(''),
    /[\p{Cc}\p{Zl}\p{Zp}]/u,
  );

  const malicious = [];
  const maliciousCode = await runKitMatrixCli(['build', 'alpha\nforged'], {
    stdout: { write: (value) => malicious.push(value) },
    stderr: { write: (value) => malicious.push(value) },
  }, { repositoryRoot, descriptors, run: async () => {} });
  assert.equal(maliciousCode, 1);
  assert.equal(malicious.join(''), 'ERROR=slugs[0] must be a canonical Kit slug\n');
});
