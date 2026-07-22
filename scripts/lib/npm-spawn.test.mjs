import assert from 'node:assert/strict';
import test from 'node:test';

import { createNpmSpawnSpec } from './npm-spawn.mjs';

test('uses npm_node_execpath instead of the Electron executable for npm_execpath', () => {
  const npmArgs = ['run', 'dev:web', '--', '--kit', '@itharbors/kit-sqlite'];

  const spec = createNpmSpawnSpec(npmArgs, {
    env: {
      npm_execpath: '/project/node_modules/npm/bin/npm-cli.js',
      npm_node_execpath: '/usr/local/bin/node',
    },
    execPath: '/Applications/Harbors.app/Contents/MacOS/Harbors',
    platform: 'darwin',
  });

  assert.deepEqual(spec, {
    command: '/usr/local/bin/node',
    args: [
      '/project/node_modules/npm/bin/npm-cli.js',
      ...npmArgs,
    ],
    spawnOptions: {},
  });
});

test('uses the current Node executable for npm_execpath on Windows', () => {
  const npmArgs = ['run', 'dev:web', '--', '--kit', '@itharbors/kit-sqlite'];

  const spec = createNpmSpawnSpec(npmArgs, {
    env: { npm_execpath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js' },
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });

  assert.deepEqual(spec, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [
      'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
      ...npmArgs,
    ],
    spawnOptions: {},
  });
});

test('uses npm.cmd through a shell on Windows without npm_execpath', () => {
  const spec = createNpmSpawnSpec(['exec', 'electron'], {
    env: {},
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });

  assert.deepEqual(spec, {
    command: 'npm.cmd',
    args: ['exec', 'electron'],
    spawnOptions: { shell: true },
  });
});

test('uses npm directly without a shell on non-Windows platforms', () => {
  const spec = createNpmSpawnSpec(['run', 'dev'], {
    env: {},
    execPath: '/usr/local/bin/node',
    platform: 'linux',
  });

  assert.deepEqual(spec, {
    command: 'npm',
    args: ['run', 'dev'],
    spawnOptions: {},
  });
});
