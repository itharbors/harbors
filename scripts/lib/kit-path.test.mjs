import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { normalizeKitArgument } from './kit-path.mjs';

test('resolves relative kit paths before workspace processes start', () => {
  assert.equal(
    normalizeKitArgument('./kits/default', '/repo/harbors'),
    path.resolve('/repo/harbors', './kits/default'),
  );
});

test('preserves package names and absolute kit paths', () => {
  assert.equal(normalizeKitArgument('default', '/repo/harbors'), 'default');
  assert.equal(normalizeKitArgument('/tmp/default-kit', '/repo/harbors'), '/tmp/default-kit');
});
