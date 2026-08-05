import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultBundleVerifier,
  deriveGitHubAttestationUrl,
  GitHubArtifactAttestationVerifier,
} from './github-attestation.mjs';

const digest = 'a'.repeat(64);
const commit = '0123456789abcdef0123456789abcdef01234567';
const repository = 'example/kit-demo';
const workflow = 'example/kit-demo/.github/workflows/publish-kit.yml@refs/tags/v1.2.3';
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';
const recoverySignerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v4';
const subjectName = 'kit-demo-1.2.3-any-any.hkit';
const attestationUrl = `https://api.github.com/repos/${repository}/attestations/sha256:${digest}`;
const bundleUrl = 'https://objects.githubusercontent.com/github-production-repository-file/bundle.json';

function statement(overrides = {}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: subjectName, digest: { sha256: digest } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: `https://github.com/${repository}`,
            ref: 'refs/tags/v1.2.3',
            path: '.github/workflows/publish-kit.yml',
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/${repository}@refs/tags/v1.2.3`,
          digest: { gitCommit: commit },
        }],
      },
    },
    ...overrides,
  };
}

function mainRecoveryStatement({
  workflowRepository = repository,
  workflowRef = 'refs/heads/main',
  workflowPath = '.github/workflows/publish-kit.yml',
  dependencyRepository = repository,
  dependencyRef = workflowRef,
  dependencyCommit = 'f'.repeat(40),
} = {}) {
  return statement({
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: `https://github.com/${workflowRepository}`,
            ref: workflowRef,
            path: workflowPath,
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/${dependencyRepository}@${dependencyRef}`,
          digest: { gitCommit: dependencyCommit },
        }],
      },
    },
  });
}

function bundle({ payloadType = 'application/vnd.in-toto+json', payload = statement() } = {}) {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    dsseEnvelope: {
      payloadType,
      payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
      signatures: [{ keyid: '', sig: 'AA==' }],
    },
    verificationMaterial: {},
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function rawSnappyLiteral(value) {
  const source = Buffer.from(JSON.stringify(value));
  const lengthPrefix = [];
  for (let remaining = source.byteLength; remaining >= 0x80; remaining >>>= 7) {
    lengthPrefix.push((remaining & 0x7f) | 0x80);
  }
  lengthPrefix.push(source.byteLength >>> (7 * (lengthPrefix.length)));

  const literalLength = source.byteLength - 1;
  const literalLengthBytes = [];
  for (let remaining = literalLength; remaining > 0; remaining >>>= 8) {
    literalLengthBytes.push(remaining & 0xff);
  }
  const literalTag = (59 + literalLengthBytes.length) << 2;
  return Buffer.concat([
    Buffer.from(lengthPrefix),
    Buffer.from([literalTag, ...literalLengthBytes]),
    source,
  ]);
}

function snappyResponse(value) {
  return new Response(rawSnappyLiteral(value), {
    headers: { 'content-type': 'application/x-snappy' },
  });
}

function streamedSnappyResponse(bytes) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      controller.enqueue(bytes.subarray(1));
      controller.close();
    },
  }), {
    headers: { 'content-type': 'application/x-snappy' },
  });
}

function expected(overrides = {}) {
  return {
    attestationUrl,
    subjectName,
    subjectSha256: digest,
    repository,
    commit,
    workflow,
    signerWorkflow,
    ...overrides,
  };
}

function createVerifier({
  apiValue = { attestations: [{ bundle_url: bundleUrl }] },
  bundleValue = bundle(),
  fetchImpl,
  verifyBundle,
  ...options
} = {}) {
  const requests = [];
  const verifier = new GitHubArtifactAttestationVerifier({
    fetchImpl: fetchImpl ?? (async (url, init) => {
      requests.push({ url: String(url), init });
      return String(url).startsWith(attestationUrl)
        ? jsonResponse(apiValue)
        : jsonResponse(bundleValue);
    }),
    verifyBundle: verifyBundle ?? (async () => undefined),
    ...options,
  });
  return { verifier, requests };
}

test('loads Sigstore after installing the Electron ECDSA compatibility shim', async () => {
  const cryptoCalls = [];
  const cryptoModule = {
    verify(algorithm, data, key, signature) {
      cryptoCalls.push({ algorithm, data, key, signature });
      return algorithm === 'sha256';
    },
  };
  const sigstoreCalls = [];
  let imports = 0;
  const verifyBundle = createDefaultBundleVerifier({
    runtimeVersions: { electron: '43.2.0', openssl: '0.0.0' },
    cryptoModule,
    importSigstore: async () => {
      imports += 1;
      const capturedVerify = cryptoModule.verify;
      return {
        async verify(...args) {
          sigstoreCalls.push(args);
          assert.equal(capturedVerify(undefined, 'data', { asymmetricKeyType: 'ec' }, 'sig'), true);
          assert.equal(capturedVerify(
            undefined,
            'data',
            { key: { asymmetricKeyType: 'ec' } },
            'sig',
          ), true);
          assert.equal(capturedVerify(undefined, 'data', { asymmetricKeyType: 'ed25519' }, 'sig'), false);
          assert.equal(capturedVerify(
            undefined,
            'data',
            { key: { asymmetricKeyType: 'ed25519' } },
            'sig',
          ), false);
        },
      };
    },
  });

  assert.equal(imports, 0);
  const options = { certificateIssuer: 'https://token.actions.githubusercontent.com' };
  await verifyBundle({ bundle: true }, options);
  await verifyBundle({ bundle: false }, options);

  assert.equal(imports, 1);
  assert.deepEqual(sigstoreCalls, [
    [{ bundle: true }, options],
    [{ bundle: false }, options],
  ]);
  assert.deepEqual(cryptoCalls.map(({ algorithm }) => algorithm), [
    'sha256',
    'sha256',
    undefined,
    undefined,
    'sha256',
    'sha256',
    undefined,
    undefined,
  ]);
});

test('derives the only accepted GitHub repository attestation URL', () => {
  assert.equal(deriveGitHubAttestationUrl(repository, digest), attestationUrl);
  for (const value of ['example', '../example/repo', 'example/repo/extra', 'Example/repo']) {
    assert.throws(() => deriveGitHubAttestationUrl(value, digest), /repository/i);
  }
  assert.throws(() => deriveGitHubAttestationUrl(repository, 'not-a-digest'), /sha256/i);
});

test('verifies Sigstore identity and every selected artifact claim', async () => {
  const verifications = [];
  const { verifier, requests } = createVerifier({
    verifyBundle: async (value, options) => verifications.push({ value, options }),
  });

  assert.deepEqual(await verifier.verify(expected()), {
    verified: true,
    attestationUrl,
    subjectName,
    subjectSha256: digest,
    repository,
    commit,
    workflow,
    signerWorkflow,
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${attestationUrl}?predicate_type=provenance&per_page=100`,
  );
  assert.deepEqual(requests[0].init.headers, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  });
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[1].url, bundleUrl);
  assert.equal(requests[1].init.redirect, 'error');
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].value.dsseEnvelope.payloadType, 'application/vnd.in-toto+json');
  assert.deepEqual(verifications[0].options, {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    certificateIdentityURI: `https://github.com/${signerWorkflow}`,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
});

test('sends an optional GitHub token only to the attestation API', async () => {
  const { verifier, requests } = createVerifier({ githubToken: 'github-token' });
  await verifier.verify(expected());
  assert.equal(requests[0].init.headers.Authorization, 'Bearer github-token');
  assert.deepEqual(requests[1].init.headers, { Accept: 'application/json' });
});

test('accepts GitHub raw Snappy attestation bundles', async () => {
  const { verifier } = createVerifier({
    fetchImpl: async (url) => String(url).startsWith(attestationUrl)
      ? jsonResponse({ attestations: [{ bundle_url: bundleUrl }] })
      : snappyResponse(bundle()),
  });

  assert.equal((await verifier.verify(expected())).verified, true);
});

test('rejects streamed Snappy bundles whose compressed input exceeds the bound', async () => {
  let cryptoChecks = 0;
  const { verifier } = createVerifier({
    maxBundleBytes: 64,
    fetchImpl: async (url) => String(url).startsWith(attestationUrl)
      ? jsonResponse({ attestations: [{ bundle_url: bundleUrl }] })
      : streamedSnappyResponse(Buffer.alloc(65)),
    verifyBundle: async () => { cryptoChecks += 1; },
  });

  await assert.rejects(verifier.verify(expected()), (error) => error.code === 'PROVENANCE_FAILED');
  assert.equal(cryptoChecks, 0);
});

test('rejects Snappy bundles whose declared output exceeds the bound', async () => {
  let cryptoChecks = 0;
  const { verifier } = createVerifier({
    maxBundleBytes: 64,
    fetchImpl: async (url) => String(url).startsWith(attestationUrl)
      ? jsonResponse({ attestations: [{ bundle_url: bundleUrl }] })
      : streamedSnappyResponse(Buffer.from([65])),
    verifyBundle: async () => { cryptoChecks += 1; },
  });

  await assert.rejects(verifier.verify(expected()), (error) => error.code === 'PROVENANCE_FAILED');
  assert.equal(cryptoChecks, 0);
});

test('rejects empty or control-bearing GitHub tokens', () => {
  for (const githubToken of ['', 'token\nvalue', 'token\u007fvalue', 'token\u0085value']) {
    assert.throws(
      () => createVerifier({ githubToken }),
      /githubToken/u,
    );
  }
});

test('reports a bounded retry time when the GitHub attestation API is rate limited', async () => {
  for (const status of [403, 429]) {
    const { verifier } = createVerifier({
      fetchImpl: async () => new Response('{}', {
        status,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1785241677',
        },
      }),
    });
    await assert.rejects(
      verifier.verify(expected()),
      (error) => (
        error.code === 'ATTESTATION_RATE_LIMITED'
        && error.message === 'GitHub verification rate limit reached. Retry after 2026-07-28T12:27:57.000Z.'
      ),
    );
  }
});

test('does not trust malformed or incomplete GitHub rate-limit headers', async () => {
  for (const headers of [
    {},
    { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '1785241677' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'not-a-time' },
  ]) {
    const { verifier } = createVerifier({
      fetchImpl: async () => new Response('{}', { status: 403, headers }),
    });
    await assert.rejects(
      verifier.verify(expected()),
      (error) => error.code === 'ATTESTATION_FETCH_FAILED',
    );
  }
});

test('rejects an attestation URL that is not exactly derived from repository and digest', async () => {
  for (const changed of [
    'https://evil.test/attestations/sha256:abc',
    `${attestationUrl}/extra`,
    `${attestationUrl}?predicate_type=provenance`,
    attestationUrl.replace(repository, 'example/other'),
  ]) {
    const { verifier, requests } = createVerifier();
    await assert.rejects(
      verifier.verify(expected({ attestationUrl: changed })),
      (error) => error.code === 'ATTESTATION_URL_MISMATCH',
    );
    assert.equal(requests.length, 0);
  }
});

test('requires a non-empty bounded GitHub attestation response', async () => {
  await assert.rejects(
    createVerifier({ apiValue: { attestations: [] } }).verifier.verify(expected()),
    (error) => error.code === 'ATTESTATION_NOT_FOUND',
  );
  await assert.rejects(
    createVerifier({
      fetchImpl: async () => new Response('{}', { headers: { 'content-length': '1048577' } }),
    }).verifier.verify(expected()),
    (error) => error.code === 'ATTESTATION_RESPONSE_TOO_LARGE',
  );
});

test('requires HTTPS bundle URLs and enforces the bundle response bound', async () => {
  await assert.rejects(
    createVerifier({ apiValue: { attestations: [{ bundle_url: 'http://objects.example/bundle' }] } })
      .verifier.verify(expected()),
    (error) => error.code === 'PROVENANCE_FAILED',
  );
  await assert.rejects(
    createVerifier({
      fetchImpl: async (url) => String(url).startsWith(attestationUrl)
        ? jsonResponse({ attestations: [{ bundle_url: bundleUrl }] })
        : new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } }),
    }).verifier.verify(expected()),
    (error) => error.code === 'PROVENANCE_FAILED',
  );
});

test('times out network requests without leaking response data', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    createVerifier({ fetchImpl, timeoutMs: 10 }).verifier.verify(expected()),
    (error) => error.code === 'ATTESTATION_FETCH_FAILED' && !error.message.includes(subjectName),
  );
});

test('tries later bundles after Sigstore or claim verification fails', async () => {
  const secondBundleUrl = 'https://objects.githubusercontent.com/second-bundle.json';
  let cryptoChecks = 0;
  const { verifier } = createVerifier({
    apiValue: { attestations: [{ bundle_url: bundleUrl }, { bundle_url: secondBundleUrl }] },
    fetchImpl: async (url) => String(url).startsWith(attestationUrl)
      ? jsonResponse({ attestations: [{ bundle_url: bundleUrl }, { bundle_url: secondBundleUrl }] })
      : jsonResponse(String(url) === bundleUrl
        ? bundle({ payload: statement({ subject: [{ name: 'wrong.hkit', digest: { sha256: digest } }] }) })
        : bundle()),
    verifyBundle: async () => {
      cryptoChecks += 1;
      if (cryptoChecks === 1) throw new Error('certificate identity mismatch: secret bundle body');
    },
  });
  assert.equal((await verifier.verify(expected())).verified, true);
  assert.equal(cryptoChecks, 2);
});

test('uses the production Sigstore verifier by default and never accepts an unsigned fixture', async () => {
  const verifier = new GitHubArtifactAttestationVerifier({
    fetchImpl: async (url) => String(url).startsWith(attestationUrl)
      ? jsonResponse({ attestations: [{ bundle_url: bundleUrl }] })
      : jsonResponse(bundle()),
  });
  await assert.rejects(
    verifier.verify(expected()),
    (error) => error.code === 'PROVENANCE_FAILED',
  );
});

test('accepts automatic main-dispatch provenance only for the immutable v4 recovery signer', async () => {
  const v3Signer = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3';
  const automaticMainStatement = mainRecoveryStatement();
  await assert.rejects(
    createVerifier({ bundleValue: bundle({ payload: automaticMainStatement }) })
      .verifier.verify(expected({ signerWorkflow: v3Signer })),
    (error) => error.code === 'PROVENANCE_FAILED',
  );

  const verificationOptions = [];
  const recovery = createVerifier({
    bundleValue: bundle({ payload: automaticMainStatement }),
    verifyBundle: async (_bundle, options) => verificationOptions.push(options),
  });
  assert.equal((await recovery.verifier.verify(expected({ signerWorkflow: recoverySignerWorkflow }))).verified, true);
  assert.equal(
    verificationOptions[0].certificateIdentityURI,
    `https://github.com/${recoverySignerWorkflow}`,
  );
});

test('v4 keeps accepting product-Tag execution provenance for ordinary Tag-triggered publication', async () => {
  const { verifier } = createVerifier();
  assert.equal((await verifier.verify(expected({ signerWorkflow: recoverySignerWorkflow }))).verified, true);
});

test('rejects malformed or widened v4 main recovery execution claims', async (t) => {
  const cases = [
    ['branch', mainRecoveryStatement({ workflowRef: 'refs/heads/release' })],
    ['workflow path', mainRecoveryStatement({ workflowPath: '.github/workflows/other.yml' })],
    ['workflow repository', mainRecoveryStatement({ workflowRepository: 'example/other' })],
    ['dependency repository', mainRecoveryStatement({ dependencyRepository: 'example/other' })],
    ['dependency ref', mainRecoveryStatement({ dependencyRef: 'refs/tags/v1.2.3' })],
    ['dependency commit', mainRecoveryStatement({ dependencyCommit: 'not-a-commit' })],
  ];
  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        createVerifier({ bundleValue: bundle({ payload }) })
          .verifier.verify(expected({ signerWorkflow: recoverySignerWorkflow })),
        (error) => error.code === 'PROVENANCE_FAILED',
      );
    });
  }
});

test('rejects invalid DSSE and mismatched subject, repository, commit, or workflow claims', async (t) => {
  const cases = [
    ['payload type', bundle({ payloadType: 'application/json' })],
    ['statement type', bundle({ payload: statement({ _type: 'wrong' }) })],
    ['predicate type', bundle({ payload: statement({ predicateType: 'wrong' }) })],
    ['subject name', bundle({ payload: statement({ subject: [{ name: 'other.hkit', digest: { sha256: digest } }] }) })],
    ['subject digest', bundle({ payload: statement({ subject: [{ name: subjectName, digest: { sha256: 'b'.repeat(64) } }] }) })],
    ['repository', bundle({ payload: statement({ predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/example/other', ref: 'refs/tags/v1.2.3', path: '/.github/workflows/publish-kit.yml' } }, resolvedDependencies: [{ uri: `git+https://github.com/${repository}@refs/tags/v1.2.3`, digest: { gitCommit: commit } }] } } }) })],
    ['commit', bundle({ payload: statement({ predicate: { buildDefinition: { externalParameters: { workflow: { repository: `https://github.com/${repository}`, ref: 'refs/tags/v1.2.3', path: '/.github/workflows/publish-kit.yml' } }, resolvedDependencies: [{ uri: `git+https://github.com/${repository}@refs/tags/v1.2.3`, digest: { gitCommit: 'f'.repeat(40) } }] } } }) })],
    ['workflow', bundle({ payload: statement({ predicate: { buildDefinition: { externalParameters: { workflow: { repository: `https://github.com/${repository}`, ref: 'refs/heads/main', path: '/.github/workflows/other.yml' } }, resolvedDependencies: [{ uri: `git+https://github.com/${repository}@refs/heads/main`, digest: { gitCommit: commit } }] } } }) })],
  ];
  for (const [name, bundleValue] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        createVerifier({ bundleValue }).verifier.verify(expected()),
        (error) => error.code === 'PROVENANCE_FAILED' && error.message === 'No valid GitHub artifact attestation matched',
      );
    });
  }
});
