import assert from 'node:assert/strict';
import test from 'node:test';

import { createKitReleasePlan } from './kit-release-intent.mjs';

function product(slug, version, channel = version.includes('-') ? 'preview' : 'stable') {
  const id = `@itharbors/kit-${slug}`;
  return {
    manifest: { id, version, channel },
    packageJson: { name: id, version },
    lockfile: { packages: { '': { name: id, version } } },
  };
}

const policy = { kits: { mysql: { id: '@itharbors/kit-mysql' }, sqlite: { id: '@itharbors/kit-sqlite' } } };

test('returns one deterministic release intent for every directly changed market Kit', () => {
  const plan = createKitReleasePlan({
    changedPaths: ['kits/sqlite/plugins/core/main.ts', 'kits/mysql/README.md', 'docs/README.md'],
    policy,
    baseProducts: new Map([
      ['sqlite', product('sqlite', '1.2.2')],
      ['mysql', product('mysql', '2.0.0-preview.1')],
    ]),
    headProducts: new Map([
      ['sqlite', product('sqlite', '1.2.3')],
      ['mysql', product('mysql', '2.0.0-preview.2')],
    ]),
  });

  assert.deepEqual(plan, [
    { slug: 'mysql', version: '2.0.0-preview.2', channel: 'preview', tag: 'kit/mysql/v2.0.0-preview.2' },
    { slug: 'sqlite', version: '1.2.3', channel: 'stable', tag: 'kit/sqlite/v1.2.3' },
  ]);
  assert.ok(Object.isFrozen(plan));
  assert.ok(plan.every(Object.isFrozen));
});

test('ignores unrelated and builtin Kit paths', () => {
  assert.deepEqual(createKitReleasePlan({
    changedPaths: ['kits/default/plugins/title/main.ts', 'packages/server/src/index.ts'],
    policy,
    baseProducts: new Map(),
    headProducts: new Map(),
  }), []);
});

test('allows the first version of a newly registered market Kit', () => {
  const nextPolicy = { kits: { ...policy.kits, traceweave: { id: '@itharbors/kit-traceweave' } } };
  assert.deepEqual(createKitReleasePlan({
    changedPaths: ['kits/traceweave/kit.json'],
    policy: nextPolicy,
    baseProducts: new Map(),
    headProducts: new Map([['traceweave', product('traceweave', '0.1.0-preview.1')]]),
  }), [{
    slug: 'traceweave',
    version: '0.1.0-preview.1',
    channel: 'preview',
    tag: 'kit/traceweave/v0.1.0-preview.1',
  }]);
});

test('requires every changed market Kit version to increase', () => {
  for (const version of ['1.2.3', '1.2.2']) {
    assert.throws(() => createKitReleasePlan({
      changedPaths: ['kits/sqlite/src/index.ts'],
      policy,
      baseProducts: new Map([['sqlite', product('sqlite', '1.2.3')]]),
      headProducts: new Map([['sqlite', product('sqlite', version)]]),
    }), /must increase from 1\.2\.3/u);
  }
});

test('rejects manifest, package, lockfile, SemVer, identity, and channel drift', () => {
  const cases = [
    [product('sqlite', '1.2'), /canonical SemVer/u],
    [{ ...product('sqlite', '1.2.4'), packageJson: { name: '@itharbors/kit-sqlite', version: '1.2.5' } }, /versions do not match/u],
    [{ ...product('sqlite', '1.2.4'), lockfile: { packages: { '': { name: '@itharbors/kit-sqlite', version: '1.2.3' } } } }, /lockfile identity/u],
    [{ ...product('sqlite', '1.2.4'), manifest: { id: '@itharbors/kit-wrong', version: '1.2.4', channel: 'stable' } }, /identity mismatch/u],
    [product('sqlite', '1.2.4', 'preview'), /channel must be stable/u],
  ];
  for (const [head, expected] of cases) {
    assert.throws(() => createKitReleasePlan({
      changedPaths: ['kits/sqlite/kit.json'],
      policy,
      baseProducts: new Map([['sqlite', product('sqlite', '1.2.3')]]),
      headProducts: new Map([['sqlite', head]]),
    }), expected);
  }
});

test('rejects unsafe changed paths and missing changed market Kit snapshots', () => {
  assert.throws(() => createKitReleasePlan({
    changedPaths: ['kits/sqlite/evil\npath'], policy, baseProducts: new Map(), headProducts: new Map(),
  }), /canonical repository path/u);
  assert.throws(() => createKitReleasePlan({
    changedPaths: ['kits/sqlite/kit.json'], policy, baseProducts: new Map(), headProducts: new Map(),
  }), /missing at the head revision/u);
});
