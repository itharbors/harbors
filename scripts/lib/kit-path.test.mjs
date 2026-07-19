import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { normalizeKitArgument } from './kit-path.mjs';

test('resolves relative kit paths before workspace processes start', () => {
  assert.equal(
    normalizeKitArgument('./kits/sqlite', '/repo/harbors'),
    path.resolve('/repo/harbors', './kits/sqlite'),
  );
});

test('preserves package names and absolute kit paths', () => {
  assert.equal(normalizeKitArgument('@itharbors/kit-sqlite', '/repo/harbors'), '@itharbors/kit-sqlite');
  assert.equal(normalizeKitArgument('/tmp/sqlite-kit', '/repo/harbors'), '/tmp/sqlite-kit');
});
