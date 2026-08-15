import assert from 'node:assert/strict';
import test from 'node:test';

import { createPnpmSpawnSpec } from './pnpm-spawn.mjs';

test('uses npm_node_execpath instead of the host executable for npm_execpath', () => {
  const pnpmArgs = ['run', 'dev:web', '--', '--kit', 'default'];

  const spec = createPnpmSpawnSpec(pnpmArgs, {
    env: {
      npm_execpath: '/project/node_modules/.pnpm/pnpm@9.12.0/node_modules/pnpm/bin/pnpm.cjs',
      npm_node_execpath: '/usr/local/bin/node',
    },
    execPath: '/Applications/Harbors.app/Contents/MacOS/Harbors',
    platform: 'darwin',
  });

  assert.deepEqual(spec, {
    command: '/usr/local/bin/node',
    args: [
      '/project/node_modules/.pnpm/pnpm@9.12.0/node_modules/pnpm/bin/pnpm.cjs',
      ...pnpmArgs,
    ],
    spawnOptions: {},
  });
});

test('uses the current Node executable for npm_execpath on Windows', () => {
  const pnpmArgs = ['run', 'dev:web', '--', '--kit', 'default'];

  const spec = createPnpmSpawnSpec(pnpmArgs, {
    env: { npm_execpath: 'C:\\pnpm\\pnpm.cjs' },
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });

  assert.deepEqual(spec, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [
      'C:\\pnpm\\pnpm.cjs',
      ...pnpmArgs,
    ],
    spawnOptions: {},
  });
});

test('uses pnpm.cmd through a shell on Windows without npm_execpath', () => {
  const spec = createPnpmSpawnSpec(['exec', 'tsx'], {
    env: {},
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });

  assert.deepEqual(spec, {
    command: 'pnpm.cmd',
    args: ['exec', 'tsx'],
    spawnOptions: { shell: true },
  });
});

test('uses pnpm directly without a shell on non-Windows platforms', () => {
  const spec = createPnpmSpawnSpec(['run', 'dev'], {
    env: {},
    execPath: '/usr/local/bin/node',
    platform: 'linux',
  });

  assert.deepEqual(spec, {
    command: 'pnpm',
    args: ['run', 'dev'],
    spawnOptions: {},
  });
});
