import assert from 'node:assert/strict';
import test from 'node:test';

import { createKitReleasePlan } from './kit-release-intent.mjs';

function product(slug, version, channel = version.includes('-') ? 'preview' : 'stable') {
  const id = slug;
  return {
    manifest: { id, version, channel },
    packageJson: { name: id, version },
    lockfile: { packages: { '': { name: id, version } } },
  };
}

const policy = { kits: { default: { id: 'default' } } };

test('returns one deterministic release intent for every directly changed market Kit', () => {
  const plan = createKitReleasePlan({
    changedPaths: ['kits/default/plugins/core/main.ts', 'kits/default/README.md', 'docs/README.md'],
    policy,
    baseProducts: new Map([
      ['default', product('default', '1.2.2')],
    ]),
    headProducts: new Map([
      ['default', product('default', '1.2.3')],
    ]),
  });

  assert.deepEqual(plan, [
    { slug: 'default', version: '1.2.3', channel: 'stable', tag: 'kit/default/v1.2.3' },
  ]);
  assert.ok(Object.isFrozen(plan));
  assert.ok(plan.every(Object.isFrozen));
});

test('processes builtin Kit paths', () => {
  const plan = createKitReleasePlan({
    changedPaths: ['kits/default/plugins/title/main.ts', 'packages/server/src/index.ts'],
    policy,
    baseProducts: new Map(),
    headProducts: new Map([['default', product('default', '0.0.2')]]),
  });
  assert.deepEqual(plan, [
    { slug: 'default', version: '0.0.2', channel: 'stable', tag: 'kit/default/v0.0.2' },
  ]);
});

test('allows the first version of a newly registered market Kit', () => {
  const nextPolicy = { kits: { ...policy.kits, default: { id: 'default' } } };
  assert.deepEqual(createKitReleasePlan({
    changedPaths: ['kits/default/kit.json'],
    policy: nextPolicy,
    baseProducts: new Map(),
    headProducts: new Map([['default', product('default', '0.1.0-preview.1')]]),
  }), [{
    slug: 'default',
    version: '0.1.0-preview.1',
    channel: 'preview',
    tag: 'kit/default/v0.1.0-preview.1',
  }]);
});

test('requires every changed market Kit version to increase', () => {
  for (const version of ['1.2.3', '1.2.2']) {
    assert.throws(() => createKitReleasePlan({
      changedPaths: ['kits/default/src/index.ts'],
      policy,
      baseProducts: new Map([['default', product('default', '1.2.3')]]),
      headProducts: new Map([['default', product('default', version)]]),
    }), /must increase from 1\.2\.3/u);
  }
});

test('rejects manifest, package, lockfile, SemVer, identity, and channel drift', () => {
  const cases = [
    [product('default', '1.2'), /canonical SemVer/u],
    [{ ...product('default', '1.2.4'), packageJson: { name: 'default', version: '1.2.5' } }, /versions do not match/u],
    [{ ...product('default', '1.2.4'), lockfile: { packages: { '': { name: 'default', version: '1.2.3' } } } }, /lockfile identity/u],
    [{ ...product('default', '1.2.4'), manifest: { id: '@itharbors/kit-wrong', version: '1.2.4', channel: 'stable' } }, /identity mismatch/u],
    [product('default', '1.2.4', 'preview'), /channel must be stable/u],
  ];
  for (const [head, expected] of cases) {
    assert.throws(() => createKitReleasePlan({
      changedPaths: ['kits/default/kit.json'],
      policy,
      baseProducts: new Map([['default', product('default', '1.2.3')]]),
      headProducts: new Map([['default', head]]),
    }), expected);
  }
});

test('rejects unsafe changed paths and missing changed market Kit snapshots', () => {
  assert.throws(() => createKitReleasePlan({
    changedPaths: ['kits/default/evil\npath'], policy, baseProducts: new Map(), headProducts: new Map(),
  }), /canonical repository path/u);
  assert.throws(() => createKitReleasePlan({
    changedPaths: ['kits/default/kit.json'], policy, baseProducts: new Map(), headProducts: new Map(),
  }), /missing at the head revision/u);
});
