import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
