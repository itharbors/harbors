import assert from 'node:assert/strict';
import test from 'node:test';

import { createKitPublicationMetadata } from './metadata.mjs';
import { createKitProvenancePredicate } from './provenance.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const tag = 'kit/demo/v1.2.3';
const ref = `refs/tags/${tag}`;
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3';

const manifest = {
  schemaVersion: 1,
  id: '@itharbors/kit-demo',
  version: '1.2.3',
  channel: 'stable',
  publisher: 'itharbors',
  requires: {
    harbors: '>=1.0.0 <2.0.0',
    kitApi: '>=1.0.0 <2.0.0',
    protocolVersion: 1,
  },
  target: { platform: 'any', arch: 'any' },
  permissions: [],
  entry: 'package.json',
};

function release() {
  return createKitPublicationMetadata({
    manifest,
    sha256: 'a'.repeat(64),
    size: 1024,
    repository: 'itharbors/harbors',
    commit,
    workflow: `itharbors/harbors/.github/workflows/publish-kit.yml@${ref}`,
    signerWorkflow,
    ref,
    tag,
    label: 'Demo',
    summary: 'Legacy product artifact packaged by immutable v3',
  }).release;
}

test('creates SLSA provenance for the validated product Tag instead of the recovery caller', () => {
  const predicate = createKitProvenancePredicate(release());
  assert.deepEqual(predicate, {
    buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: {
        workflow: {
          repository: 'https://github.com/itharbors/harbors',
          path: '.github/workflows/publish-kit.yml',
          ref,
        },
      },
      internalParameters: {},
      resolvedDependencies: [{
        uri: `git+https://github.com/itharbors/harbors@${ref}`,
        digest: { gitCommit: commit },
      }],
    },
    runDetails: {
      builder: { id: `https://github.com/${signerWorkflow}` },
      metadata: {},
    },
  });
  assert.equal(Object.isFrozen(predicate), true);
});

test('rejects mutable or historical signer identities when generating v3 provenance', () => {
  const value = release();
  for (const signer of [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/heads/main',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ]) {
    assert.throws(
      () => createKitProvenancePredicate({
        ...value,
        source: { ...value.source, signerWorkflow: signer },
      }),
      /kit-publish-v3/u,
    );
  }
});
