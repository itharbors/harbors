import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDevStackEnvironments } from './dev-launcher.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const devScript = path.join(repositoryRoot, 'scripts/dev.mjs');

test('accepts the pnpm argument separator before dev options', () => {
  const result = spawnSync(process.execPath, [devScript, '--', '--help'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:\s+pnpm dev/);
});

test('continues to reject unknown dev arguments', () => {
  const result = spawnSync(process.execPath, [devScript, '--unknown'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown dev argument: --unknown/);
});

test('accepts both absolute data-root forms without starting on help', () => {
  for (const args of [['--data-root', '/tmp/harbors-data', '--help'], ['--data-root=/tmp/harbors-data', '--help']]) {
    const result = spawnSync(process.execPath, [devScript, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--data-root <absolute-path>/u);
  }
});

test('rejects invalid data-root arguments', () => {
  for (const args of [['--data-root'], ['--data-root', 'relative'], ['--data-root=/one', '--data-root=/two']]) {
    const result = spawnSync(process.execPath, [devScript, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--data-root/u);
  }
});

test('does not let help hide an invalid data-root', () => {
  const result = spawnSync(process.execPath, [devScript, '--data-root', 'relative', '--help'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--data-root must be an absolute path/u);
});

test('exposes only the Gateway while keeping development upstreams on loopback', () => {
  const stack = createDevStackEnvironments({}, '', 'development', [
    { directory: '/repo/kits/default', source: 'builtin' },
  ]);

  assert.equal(stack.gatewayEnv.HARBORS_BIND_HOST, '0.0.0.0');
  assert.equal(stack.serverEnv.HARBORS_BIND_HOST, '127.0.0.1');
  assert.equal(stack.clientEnv.HARBORS_BIND_HOST, '127.0.0.1');
});

test('passes a unified data root through the development environments', () => {
  const stack = createDevStackEnvironments({ HARBORS_DATA_ROOT: '/tmp/harbors-data' }, '', 'development', [
    { directory: '/repo/kits/default', source: 'builtin' },
  ]);
  assert.equal(stack.gatewayEnv.HARBORS_DATA_ROOT, '/tmp/harbors-data');
  assert.equal(stack.serverEnv.HARBORS_DATA_ROOT, '/tmp/harbors-data');
  assert.equal(stack.clientEnv.HARBORS_DATA_ROOT, '/tmp/harbors-data');
});
