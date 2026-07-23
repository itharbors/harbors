import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createKitManagerService,
  DEFAULT_KIT_PUBLISHER_POLICIES,
  DEFAULT_KIT_REGISTRY_URL,
  resolveKitManagerConfig,
} from './kit-manager-service.mjs';

const roots = [];
const runtime = {
  harborsVersion: '1.0.0',
  kitApiVersion: '1.0.0',
  protocolVersion: 1,
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('uses the official Registry and an exact official repository/workflow policy by default', () => {
  assert.equal(DEFAULT_KIT_REGISTRY_URL, 'https://itharbors.github.io/harbors/index.v1.json');
  assert.deepEqual(DEFAULT_KIT_PUBLISHER_POLICIES, {
    itharbors: {
      repositories: ['itharbors/harbors'],
      workflows: ['itharbors/harbors/.github/workflows/publish-kit.yml'],
      signerWorkflows: [
        'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
        'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
      ],
    },
  });
  assert.deepEqual(resolveKitManagerConfig({}), {
    registryUrl: DEFAULT_KIT_REGISTRY_URL,
    publisherPolicies: DEFAULT_KIT_PUBLISHER_POLICIES,
    autoUpdatePublishers: ['itharbors'],
  });
});

test('accepts only explicit HTTPS Registry and strict publisher policy overrides', () => {
  assert.deepEqual(resolveKitManagerConfig({
    HARBORS_KIT_REGISTRY_URL: 'https://registry.example.test/index.v1.json',
    HARBORS_KIT_PUBLISHER_POLICIES_JSON: JSON.stringify({
      example: {
        repositories: ['example/kit'],
        workflows: ['example/kit/.github/workflows/publish.yml'],
        signerWorkflows: ['example/kit/.github/workflows/signer.yml@refs/tags/v1'],
      },
    }),
    HARBORS_KIT_AUTO_UPDATE_PUBLISHERS: 'example',
  }), {
    registryUrl: 'https://registry.example.test/index.v1.json',
    publisherPolicies: {
      ...DEFAULT_KIT_PUBLISHER_POLICIES,
      example: {
        repositories: ['example/kit'],
        workflows: ['example/kit/.github/workflows/publish.yml'],
        signerWorkflows: ['example/kit/.github/workflows/signer.yml@refs/tags/v1'],
      },
    },
    autoUpdatePublishers: ['example'],
  });
  for (const env of [
    { HARBORS_KIT_REGISTRY_URL: 'http://registry.example.test/index.json' },
    { HARBORS_KIT_PUBLISHER_POLICIES_JSON: '{broken' },
    { HARBORS_KIT_PUBLISHER_POLICIES_JSON: '{"example":{"repositories":[],"workflows":[],"extra":true}}' },
    { HARBORS_KIT_PUBLISHER_POLICIES_JSON: JSON.stringify({
      itharbors: {
        repositories: ['evil/kit'],
        workflows: ['evil/kit/.github/workflows/publish.yml'],
        signerWorkflows: ['evil/kit/.github/workflows/signer.yml@refs/tags/v1'],
      },
    }) },
    { HARBORS_KIT_AUTO_UPDATE_PUBLISHERS: 'example,,other' },
  ]) {
    assert.throws(() => resolveKitManagerConfig(env), /Kit|Registry|publisher|policy/i);
  }
});

test('composes the production service around one shared local Store', async () => {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-service-'));
  roots.push(storeRoot);
  const requests = [];
  const service = createKitManagerService({
    storeRoot,
    runtime,
    env: {},
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response('unavailable', { status: 503 });
    },
  });

  assert.equal(typeof service.manager.install, 'function');
  assert.equal(typeof service.provenanceVerifier.verify, 'function');
  assert.equal(service.config.registryUrl, DEFAULT_KIT_REGISTRY_URL);
  assert.deepEqual(await service.store.snapshot(), { schemaVersion: 1, kits: {} });
  assert.deepEqual(await service.manager.list(), {
    source: 'none', stale: true, validatedAt: null, kits: [],
  });
  assert.deepEqual(requests, []);
});
