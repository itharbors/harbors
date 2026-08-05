import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runKitPublishCli } from '../../kit-publish.mjs';
import { inspectKit, packKit } from '@itharbors/kit-cli';
import { GitHubArtifactAttestationVerifier } from '../kit-registry/github-attestation.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(repositoryRoot, 'scripts/kit-publish.mjs');
const fixture = path.join(repositoryRoot, 'packages/kit-cli/tests/fixtures/minimal-kit');
const commit = '0123456789abcdef0123456789abcdef01234567';

function runPrepare(kitArtifact, outputDirectory, {
  kitId = '@example/kit-demo',
  kitVersion = '1.2.3',
  kitChannel = 'stable',
  extra = [],
} = {}) {
  return spawnSync(process.execPath, [
    cli,
    'prepare',
    '--kit-artifact', kitArtifact,
    '--output-directory', outputDirectory,
    '--kit-id', kitId,
    '--kit-version', kitVersion,
    '--kit-channel', kitChannel,
    '--repository', 'example/harbors',
    '--commit', commit,
    '--workflow', 'example/harbors/.github/workflows/publish-kit.yml@refs/tags/kit/demo/v1.2.3',
    '--signer-workflow', 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
    '--ref', 'refs/tags/kit/demo/v1.2.3',
    '--tag', 'kit/demo/v1.2.3',
    '--label', 'Demo Kit',
    '--summary', 'A deterministic publication fixture',
    ...extra,
  ], { encoding: 'utf8' });
}

function runDirectoryPrepare(kitDirectory, outputDirectory, { tag = 'kit/demo/v1.2.3' } = {}) {
  return spawnSync(process.execPath, [
    cli,
    'prepare',
    '--kit-directory', kitDirectory,
    '--output-directory', outputDirectory,
    '--repository', 'example/harbors',
    '--commit', commit,
    '--workflow', `example/harbors/.github/workflows/publish-kit.yml@refs/tags/${tag}`,
    '--signer-workflow', 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
    '--ref', `refs/tags/${tag}`,
    '--tag', tag,
    '--label', 'Demo Kit',
    '--summary', 'A deterministic publication fixture',
  ], { encoding: 'utf8' });
}

function runProvenance(releaseManifest, output) {
  return spawnSync(process.execPath, [
    cli,
    'provenance',
    '--release-manifest', releaseManifest,
    '--output', output,
  ], { encoding: 'utf8' });
}

test('prepare copies the checked Kit byte-for-byte and writes its publication metadata exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-cli-'));
  const sourceDirectory = path.join(root, 'source');
  const artifact = path.join(root, 'kit-demo-1.2.3-any-any.hkit');
  const outputDirectory = path.join(root, 'release');
  try {
    await cp(fixture, sourceDirectory, { recursive: true });
    await packKit({ directory: sourceDirectory, output: artifact });
    const checkedBytes = await readFile(artifact);
    await rm(sourceDirectory, { recursive: true, force: true });

    const result = runPrepare(artifact, outputDirectory);
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
      'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
    );
    assert.equal(entry.releaseManifestUrl.endsWith('/release.json'), true);
    assert.equal(sbom.spdxVersion, 'SPDX-2.3');
    const publishedBytes = await readFile(path.join(outputDirectory, outputs.ARTIFACT_NAME));
    assert.deepEqual(publishedBytes, checkedBytes);
    assert.equal(publishedBytes.length, release.assets[0].size);

    const replay = runPrepare(artifact, outputDirectory);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /^ERROR=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare supports the legacy directory input contract without weakening publication output guarantees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-cli-v2-'));
  const sourceDirectory = path.join(root, 'source');
  const outputDirectory = path.join(root, 'release');
  const failedOutput = path.join(root, 'failed-release');
  try {
    await cp(fixture, sourceDirectory, { recursive: true });

    const result = runDirectoryPrepare(sourceDirectory, outputDirectory);
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('=')));
    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      'kit-demo-1.2.3-any-any.hkit',
      'registry-entry.json',
      'release.json',
      'sbom.spdx.json',
    ]);
    assert.equal(outputs.ARTIFACT_NAME, 'kit-demo-1.2.3-any-any.hkit');
    const inspected = await inspectKit({
      archive: path.join(outputDirectory, outputs.ARTIFACT_NAME),
    });
    assert.equal(inspected.manifest.id, '@example/kit-demo');
    assert.equal(inspected.manifest.version, '1.2.3');
    assert.equal(inspected.manifest.channel, 'stable');
    const release = JSON.parse(await readFile(path.join(outputDirectory, 'release.json'), 'utf8'));
    const entry = JSON.parse(await readFile(path.join(outputDirectory, 'registry-entry.json'), 'utf8'));
    const sbom = JSON.parse(await readFile(path.join(outputDirectory, 'sbom.spdx.json'), 'utf8'));
    assert.equal(release.id, '@example/kit-demo');
    assert.equal(entry.id, '@example/kit-demo');
    assert.equal(sbom.name, '@example/kit-demo@1.2.3');
    assert.match(outputs.ARTIFACT_SHA256, /^[a-f0-9]{64}$/u);

    const replay = runDirectoryPrepare(sourceDirectory, outputDirectory);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /^ERROR=/u);

    const invalid = runDirectoryPrepare(sourceDirectory, failedOutput, { tag: 'kit/other/v1.2.3' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /requires Tag kit\/demo\/v1\.2\.3/u);
    await assert.rejects(access(failedOutput));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provenance writes the product Tag claims required by Registry verification exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-provenance-'));
  const artifact = path.join(root, 'kit-demo-1.2.3-any-any.hkit');
  const outputDirectory = path.join(root, 'release');
  const provenance = path.join(root, 'provenance.json');
  try {
    await packKit({ directory: fixture, output: artifact });
    const prepared = runPrepare(artifact, outputDirectory);
    assert.equal(prepared.status, 0, prepared.stderr);

    const result = runProvenance(path.join(outputDirectory, 'release.json'), provenance);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'PREDICATE=provenance.json\n');
    const predicate = JSON.parse(await readFile(provenance, 'utf8'));
    assert.deepEqual(predicate.buildDefinition.externalParameters.workflow, {
      repository: 'https://github.com/example/harbors',
      path: '.github/workflows/publish-kit.yml',
      ref: 'refs/tags/kit/demo/v1.2.3',
    });
    assert.deepEqual(predicate.buildDefinition.resolvedDependencies, [{
      uri: 'git+https://github.com/example/harbors@refs/tags/kit/demo/v1.2.3',
      digest: { gitCommit: commit },
    }]);

    const replay = runProvenance(path.join(outputDirectory, 'release.json'), provenance);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /^ERROR=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare rejects malformed and non-canonically named Kit artifacts without output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-cli-invalid-'));
  try {
    const malformed = path.join(root, 'kit-demo-1.2.3-any-any.hkit');
    await writeFile(malformed, 'not a Kit archive');
    const malformedResult = runPrepare(malformed, path.join(root, 'malformed-output'));
    assert.equal(malformedResult.status, 1);
    assert.match(malformedResult.stderr, /^ERROR=/u);

    const wrongName = path.join(root, 'renamed.hkit');
    await packKit({ directory: fixture, output: wrongName });
    const wrongNameResult = runPrepare(wrongName, path.join(root, 'wrong-name-output'));
    assert.equal(wrongNameResult.status, 1);
    assert.match(wrongNameResult.stderr, /canonical artifact name/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare rejects a checked artifact whose identity, version, or channel differs from the expected release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-publish-cli-identity-'));
  const artifact = path.join(root, 'kit-demo-1.2.3-any-any.hkit');
  try {
    await packKit({ directory: fixture, output: artifact });
    for (const expected of [
      { kitId: '@example/kit-other' },
      { kitVersion: '1.2.4' },
      { kitChannel: 'preview' },
    ]) {
      const [field] = Object.keys(expected);
      const result = runPrepare(artifact, path.join(root, field), expected);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not match expected/u);
    }
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
      const result = runPrepare(
        path.join(root, 'missing.hkit'),
        path.join(root, `release-${extra[0].slice(2)}`),
        { extra },
      );
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
