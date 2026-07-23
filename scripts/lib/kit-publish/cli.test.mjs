import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runKitPublishCli } from '../../kit-publish.mjs';
import { GitHubArtifactAttestationVerifier } from '../kit-registry/github-attestation.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(repositoryRoot, 'scripts/kit-publish.mjs');
const fixture = path.join(repositoryRoot, 'packages/kit-cli/tests/fixtures/minimal-kit');
const commit = '0123456789abcdef0123456789abcdef01234567';

function runPrepare(outputDirectory, extra = []) {
  return spawnSync(process.execPath, [
    cli,
    'prepare',
    '--kit-directory', fixture,
    '--output-directory', outputDirectory,
    '--repository', 'example/harbors',
    '--commit', commit,
    '--workflow', 'example/harbors/.github/workflows/publish-kit.yml@refs/tags/kit/demo/v1.2.3',
    '--signer-workflow', 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
    '--ref', 'refs/tags/kit/demo/v1.2.3',
    '--tag', 'kit/demo/v1.2.3',
    '--label', 'Demo Kit',
    '--summary', 'A deterministic publication fixture',
    ...extra,
  ], { encoding: 'utf8' });
}

test('prepare writes a packed Kit, release manifest, SBOM, and Registry entry exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-cli-'));
  const outputDirectory = path.join(root, 'release');
  try {
    const result = runPrepare(outputDirectory);
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('=')));
    assert.equal(outputs.CHANNEL, 'stable');
    assert.equal(outputs.VERSION, '1.2.3');
    assert.equal(outputs.TAG, 'kit/demo/v1.2.3');
    assert.equal(outputs.ARTIFACT_NAME, 'kit-demo-1.2.3-any-any.hkit');
    assert.match(outputs.ARTIFACT_SHA256, /^[a-f0-9]{64}$/u);

    const release = JSON.parse(await readFile(path.join(outputDirectory, 'release.json'), 'utf8'));
    const entry = JSON.parse(await readFile(path.join(outputDirectory, 'registry-entry.json'), 'utf8'));
    const sbom = JSON.parse(await readFile(path.join(outputDirectory, 'sbom.spdx.json'), 'utf8'));
    assert.equal(release.assets[0].sha256, outputs.ARTIFACT_SHA256);
    assert.equal(
      release.source.signerWorkflow,
      'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
    );
    assert.equal(entry.releaseManifestUrl.endsWith('/release.json'), true);
    assert.equal(sbom.spdxVersion, 'SPDX-2.3');
    assert.equal(await readFile(path.join(outputDirectory, outputs.ARTIFACT_NAME)).then((value) => value.length), release.assets[0].size);

    const replay = runPrepare(outputDirectory);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /^ERROR=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare rejects unknown, duplicate, and missing arguments before writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-cli-'));
  try {
    for (const extra of [
      ['--unknown', 'value'],
      ['--tag', 'kit/demo/v1.2.3'],
    ]) {
      const result = runPrepare(path.join(root, `release-${extra[0].slice(2)}`), extra);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage:/u);
    }
    const missing = spawnSync(process.execPath, [cli, 'prepare'], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Usage:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate writes one canonical Pages index with an injected clock value', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-aggregate-'));
  const output = path.join(root, 'index.v1.json');
  const stdout = [];
  const stderr = [];
  const index = {
    schemaVersion: 1,
    generatedAt: '2026-07-23T12:00:00.000Z',
    kits: [],
    revocations: [],
  };
  const calls = [];
  const verifier = Object.freeze({ verify: async () => undefined });
  const factoryCalls = [];
  try {
    const code = await runKitPublishCli([
      'aggregate',
      '--repository-root', root,
      '--repository', 'itharbors/harbors',
      '--policy-file', path.join(root, 'policy.json'),
      '--revocations-file', path.join(root, 'revocations.json'),
      '--output', output,
      '--generated-at', index.generatedAt,
    ], {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    }, {
      aggregateKitRegistry: async (input) => {
        calls.push(input);
        return index;
      },
      createProvenanceVerifier: (input) => {
        factoryCalls.push(input);
        return verifier;
      },
      env: { GITHUB_TOKEN: 'test-token' },
    });
    assert.equal(code, 0, stderr.join(''));
    assert.deepEqual(factoryCalls, [{ githubToken: 'test-token' }]);
    assert.deepEqual(calls, [{
      repositoryRoot: root,
      repository: 'itharbors/harbors',
      policyFile: path.join(root, 'policy.json'),
      revocationsFile: path.join(root, 'revocations.json'),
      generatedAt: index.generatedAt,
      githubToken: 'test-token',
      provenanceVerifier: verifier,
    }]);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), index);
    assert.match(stdout.join(''), /KITS=0\nREVOCATIONS=0/u);

    const replay = await runKitPublishCli([
      'aggregate',
      '--repository-root', root,
      '--repository', 'itharbors/harbors',
      '--policy-file', path.join(root, 'policy.json'),
      '--revocations-file', path.join(root, 'revocations.json'),
      '--output', output,
      '--generated-at', index.generatedAt,
    ], {
      stdout: { write: () => undefined },
      stderr: { write: (value) => stderr.push(value) },
    }, { aggregateKitRegistry: async () => index, env: { GITHUB_TOKEN: 'test-token' } });
    assert.equal(replay, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate production dependencies construct the GitHub provenance verifier', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-aggregate-'));
  const output = path.join(root, 'index.v1.json');
  let provenanceVerifier;
  try {
    const code = await runKitPublishCli([
      'aggregate',
      '--repository-root', root,
      '--repository', 'itharbors/harbors',
      '--policy-file', path.join(root, 'policy.json'),
      '--revocations-file', path.join(root, 'revocations.json'),
      '--output', output,
      '--generated-at', '2026-07-24T00:00:00.000Z',
    ], {
      stdout: { write: () => undefined },
      stderr: { write: (value) => assert.fail(value) },
    }, {
      aggregateKitRegistry: async (input) => {
        provenanceVerifier = input.provenanceVerifier;
        return {
          schemaVersion: 1,
          generatedAt: '2026-07-24T00:00:00.000Z',
          kits: [],
          revocations: [],
        };
      },
      env: { GITHUB_TOKEN: 'production-token' },
    });
    assert.equal(code, 0);
    assert.ok(provenanceVerifier instanceof GitHubArtifactAttestationVerifier);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate fails before requests or output writes when its GitHub token is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-aggregate-'));
  const output = path.join(root, 'index.v1.json');
  const stderr = [];
  let calls = 0;
  let factoryCalls = 0;
  try {
    const code = await runKitPublishCli([
      'aggregate',
      '--repository-root', root,
      '--repository', 'itharbors/harbors',
      '--policy-file', path.join(root, 'policy.json'),
      '--revocations-file', path.join(root, 'revocations.json'),
      '--output', output,
      '--generated-at', '2026-07-24T00:00:00.000Z',
    ], {
      stdout: { write: () => assert.fail('aggregate must not write output') },
      stderr: { write: (value) => stderr.push(value) },
    }, {
      aggregateKitRegistry: async () => { calls += 1; },
      createProvenanceVerifier: () => {
        factoryCalls += 1;
        return { verify: async () => undefined };
      },
      env: {},
    });
    assert.equal(code, 1);
    assert.equal(calls, 0);
    assert.equal(factoryCalls, 0);
    assert.deepEqual(stderr, ['ERROR=GitHub token is required\n']);
    await assert.rejects(readFile(output));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
