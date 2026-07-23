import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFrameworkRuntime } from './framework-runtime.mjs';

test('derives native compatibility from the Node process that runs Framework plugins', () => {
  const calls = [];
  const runtime = resolveFrameworkRuntime({
    env: { npm_node_execpath: '/opt/node-22/bin/node' },
    execFileSync: (command, args, options) => {
      calls.push({ command, args, options });
      return '{"platform":"darwin","arch":"arm64","nodeAbi":"127"}\n';
    },
  });

  assert.deepEqual(runtime, { platform: 'darwin', arch: 'arm64', nodeAbi: '127' });
  assert.equal(calls[0].command, '/opt/node-22/bin/node');
  assert.deepEqual(calls[0].args.slice(0, 1), ['-p']);
  assert.equal(calls[0].options.shell, false);
});

test('rejects malformed runtime output instead of falling back to Electron ABI', () => {
  assert.throws(() => resolveFrameworkRuntime({
    env: {},
    execFileSync: () => '{"platform":"darwin","arch":"arm64","nodeAbi":"not-an-abi"}',
  }), /invalid/i);
});
