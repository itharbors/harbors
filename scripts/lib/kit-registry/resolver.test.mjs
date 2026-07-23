import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertResolvedRegistryAsset,
  KitReleaseResolver,
} from './resolver.mjs';

const sha256 = 'a'.repeat(64);
const commit = '0123456789abcdef0123456789abcdef01234567';
const releaseManifestUrl = 'https://github.com/example/kit-demo/releases/download/v1.2.3/release.json';
const workflow = 'example/workflows/.github/workflows/publish-kit.yml@refs/tags/v1';
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';

const manifest = {
  schemaVersion: 1,
  id: '@example/kit-demo',
  version: '1.2.3',
  channel: 'stable',
  publisher: 'example',
  requires: {
    harbors: '>=1.0.0 <2.0.0',
    kitApi: '>=1.0.0 <2.0.0',
    protocolVersion: 1,
  },
  target: { platform: 'any', arch: 'any' },
  permissions: ['network'],
  entry: 'package.json',
};

const release = {
  schemaVersion: 1,
  id: manifest.id,
  version: manifest.version,
  channel: manifest.channel,
  publisher: manifest.publisher,
  source: {
    repository: 'example/kit-demo',
    commit,
    workflow,
    signerWorkflow,
    attestationUrl: 'https://github.com/example/kit-demo/attestations/1234',
  },
  assets: [{
    name: 'kit-demo-1.2.3-any-any.hkit',
    url: 'https://github.com/example/kit-demo/releases/download/v1.2.3/kit-demo.hkit',
    sha256,
    size: 3179,
    manifest,
  }],
};

const registryIndex = {
  schemaVersion: 1,
  generatedAt: '2026-07-23T10:00:00.000Z',
  kits: [{
    id: manifest.id,
    label: 'Demo',
    publisher: manifest.publisher,
    summary: 'Fixture Kit',
    channels: {
      stable: { version: manifest.version, releaseManifestUrl, permissions: ['network'] },
      preview: {
        version: '1.3.0-preview.abc1234',
        releaseManifestUrl: 'https://github.com/example/kit-demo/releases/download/preview%2Fdemo%2F1-0123456789ab/release.json',
        permissions: ['network'],
      },
    },
  }],
  revocations: [],
};

const runtime = {
  harborsVersion: '1.0.0',
  kitApiVersion: '1.0.0',
  protocolVersion: 1,
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};

function snapshotProvider(index = registryIndex) {
  return {
    snapshot: async () => ({
      index,
      source: 'cache',
      stale: false,
      validatedAt: '2026-07-23T11:00:00.000Z',
    }),
  };
}

function claims(overrides = {}) {
  return {
    verified: true,
    subjectName: release.assets[0].name,
    subjectSha256: release.assets[0].sha256,
    repository: release.source.repository,
    commit: release.source.commit,
    workflow: release.source.workflow,
    signerWorkflow: release.source.signerWorkflow,
    ...overrides,
  };
}

function createResolver({
  index = registryIndex,
  releaseValue = release,
  fetchImpl,
  verifier,
  policies,
} = {}) {
  return new KitReleaseResolver({
    snapshotProvider: snapshotProvider(index),
    fetchImpl: fetchImpl ?? (async () => new Response(JSON.stringify(releaseValue), {
      headers: { 'content-type': 'application/json' },
    })),
    provenanceVerifier: verifier ?? { verify: async () => claims() },
    publisherPolicies: policies ?? {
      example: {
        repositories: ['example/kit-demo'],
        workflows: [workflow],
        signerWorkflows: [signerWorkflow],
      },
    },
  });
}

test('resolves a compatible asset through Registry, Release, policy, and provenance identity', async () => {
  const verificationInputs = [];
  const resolver = createResolver({
    verifier: {
      verify: async (input) => {
        verificationInputs.push(input);
        return claims();
      },
    },
  });

  const resolved = await resolver.resolve({
    id: manifest.id,
    version: manifest.version,
    channel: manifest.channel,
    runtime,
  });
  assert.equal(resolved.id, manifest.id);
  assert.equal(resolved.url, release.assets[0].url);
  assert.equal(resolved.sha256, sha256);
  assert.equal(resolved.releaseManifestUrl, releaseManifestUrl);
  assert.deepEqual(resolved.source, release.source);
  assert.equal(resolved.provenance.verified, true);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(assertResolvedRegistryAsset(resolved), resolved);
  assert.deepEqual(verificationInputs, [{
    attestationUrl: release.source.attestationUrl,
    subjectName: release.assets[0].name,
    subjectSha256: sha256,
    repository: release.source.repository,
    commit: release.source.commit,
    workflow: release.source.workflow,
    signerWorkflow: release.source.signerWorkflow,
  }]);
  assert.throws(() => assertResolvedRegistryAsset({ ...resolved }), /trusted resolver/i);
});

test('rejects ids, versions, and channels absent from the current verified snapshot before fetch', async () => {
  let fetches = 0;
  const resolver = createResolver({ fetchImpl: async () => { fetches += 1; } });
  await assert.rejects(
    resolver.resolve({ id: '@example/missing', version: '1.2.3', channel: 'stable', runtime }),
    (error) => error.code === 'KIT_NOT_FOUND',
  );
  await assert.rejects(
    resolver.resolve({ id: manifest.id, version: '9.9.9', channel: 'stable', runtime }),
    (error) => error.code === 'VERSION_NOT_LISTED',
  );
  await assert.rejects(
    resolver.resolve({ id: manifest.id, version: manifest.version, channel: 'preview', runtime }),
    (error) => error.code === 'VERSION_NOT_LISTED',
  );
  assert.equal(fetches, 0);
});

test('rejects Release identities that do not match the Registry projection', async (t) => {
  for (const [name, identity] of [
    ['id', { id: '@example/other' }],
    ['version', { version: '1.2.4' }],
    ['channel', { channel: 'preview', version: '1.2.3-preview.1' }],
    ['publisher', { publisher: 'other' }],
  ]) {
    await t.test(name, async () => {
      const changed = {
        ...release,
        ...identity,
        assets: [{
          ...release.assets[0],
          manifest: { ...manifest, ...identity },
        }],
      };
      await assert.rejects(
        createResolver({ releaseValue: changed }).resolve({
          id: manifest.id,
          version: manifest.version,
          channel: manifest.channel,
          runtime,
        }),
        (error) => error.code === 'RELEASE_IDENTITY_MISMATCH',
      );
    });
  }
});

test('rejects incompatible or ambiguous compatible assets', async () => {
  const incompatibleManifest = {
    ...manifest,
    target: { platform: runtime.platform === 'linux' ? 'darwin' : 'linux', arch: 'arm64' },
  };
  await assert.rejects(
    createResolver({
      releaseValue: {
        ...release,
        assets: [{ ...release.assets[0], manifest: incompatibleManifest }],
      },
    }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'INCOMPATIBLE_ASSET',
  );
  await assert.rejects(
    createResolver({
      releaseValue: {
        ...release,
        assets: [
          release.assets[0],
          { ...release.assets[0], name: 'duplicate-compatible.hkit', sha256: 'b'.repeat(64) },
        ],
      },
    }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'INCOMPATIBLE_ASSET',
  );
});

test('rejects Registry permissions that do not match the signed Release manifest', async () => {
  await assert.rejects(
    createResolver({
      index: {
        ...registryIndex,
        kits: [{
          ...registryIndex.kits[0],
          channels: {
            stable: { ...registryIndex.kits[0].channels.stable, permissions: ['native-code'] },
          },
        }],
      },
    }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'PERMISSIONS_MISMATCH',
  );
});

test('rejects application-startup permission from non-official publishers', async () => {
  const startupManifest = { ...manifest, permissions: ['application-startup'] };
  await assert.rejects(
    createResolver({
      index: {
        ...registryIndex,
        kits: [{
          ...registryIndex.kits[0],
          channels: {
            stable: {
              ...registryIndex.kits[0].channels.stable,
              permissions: ['application-startup'],
            },
          },
        }],
      },
      releaseValue: {
        ...release,
        assets: [{ ...release.assets[0], manifest: startupManifest }],
      },
    }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'PERMISSION_NOT_ALLOWED',
  );
});

test('rejects revoked assets before provenance verification', async () => {
  let verifications = 0;
  const resolver = createResolver({
    index: {
      ...registryIndex,
      revocations: [{
        id: manifest.id,
        version: manifest.version,
        sha256,
        reason: 'COMPROMISED_ARTIFACT',
        action: 'block-install',
      }],
    },
    verifier: { verify: async () => { verifications += 1; return claims(); } },
  });
  await assert.rejects(
    resolver.resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'REVOKED' && /COMPROMISED_ARTIFACT/.test(error.message),
  );
  assert.equal(verifications, 0);
});

test('requires repository and workflow to match publisher policy', async () => {
  await assert.rejects(
    createResolver({ policies: {} }).resolve({
      id: manifest.id, version: manifest.version, channel: 'stable', runtime,
    }),
    (error) => error.code === 'SOURCE_NOT_TRUSTED',
  );
  await assert.rejects(
    createResolver({
      policies: {
        example: {
          repositories: ['example/other'],
          workflows: [workflow],
          signerWorkflows: [signerWorkflow],
        },
      },
    }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'SOURCE_NOT_TRUSTED',
  );
  await assert.rejects(
    createResolver({
      policies: {
        example: {
          repositories: ['example/kit-demo'],
          workflows: ['example/other.yml@v1'],
          signerWorkflows: [signerWorkflow],
        },
      },
    }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'SOURCE_NOT_TRUSTED',
  );
});

test('allows an exact trusted workflow file across cryptographically verified refs', async () => {
  const resolved = await createResolver({
    policies: {
      example: {
        repositories: ['example/kit-demo'],
        workflows: ['example/workflows/.github/workflows/publish-kit.yml'],
        signerWorkflows: [signerWorkflow],
      },
    },
  }).resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime });
  assert.equal(resolved.source.workflow, workflow);
});

test('requires every verified attestation claim to match the selected asset and source', async (t) => {
  for (const [field, value] of [
    ['verified', false],
    ['subjectName', 'other.hkit'],
    ['subjectSha256', 'b'.repeat(64)],
    ['repository', 'example/other'],
    ['commit', 'f'.repeat(40)],
    ['workflow', 'example/other.yml@v1'],
    ['signerWorkflow', 'example/other.yml@v1'],
  ]) {
    await t.test(field, async () => {
      const resolver = createResolver({
        verifier: { verify: async () => claims({ [field]: value }) },
      });
      await assert.rejects(
        resolver.resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
        (error) => error.code === 'PROVENANCE_FAILED',
      );
    });
  }
});

test('rejects failed, invalid, and oversized Release responses', async (t) => {
  for (const [name, fetchImpl, code] of [
    ['HTTP', async () => new Response('no', { status: 503 }), 'RELEASE_FETCH_FAILED'],
    ['invalid JSON', async () => new Response('{broken'), 'RELEASE_INVALID'],
    ['invalid schema', async () => new Response(JSON.stringify({ ...release, extra: true })), 'RELEASE_INVALID'],
    ['oversize', async () => new Response('x'.repeat(1024 * 1024 + 1)), 'RELEASE_TOO_LARGE'],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        createResolver({ fetchImpl }).resolve({
          id: manifest.id, version: manifest.version, channel: 'stable', runtime,
        }),
        (error) => error.code === code,
      );
    });
  }
});
