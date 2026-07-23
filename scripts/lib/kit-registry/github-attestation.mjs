import { verify as verifySigstoreBundle } from 'sigstore';
import snappy from 'snappyjs';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_API_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

export class GitHubAttestationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GitHubAttestationError';
    this.code = code;
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function optionalGitHubToken(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new TypeError('githubToken must be a non-empty control-free string');
  }
  return value;
}

function assertRepository(repository) {
  if (typeof repository !== 'string') throw new TypeError('repository must be owner/repo');
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !REPOSITORY_PART_PATTERN.test(part))) {
    throw new TypeError('repository must be a canonical lowercase owner/repo');
  }
  return repository;
}

function assertSha256(digest) {
  if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
    throw new TypeError('sha256 must be a lowercase 64-character hex digest');
  }
  return digest;
}

export function deriveGitHubAttestationUrl(repository, sha256) {
  return `${GITHUB_API_ORIGIN}/repos/${assertRepository(repository)}/attestations/sha256:${assertSha256(sha256)}`;
}

function parseWorkflow(workflow, expectedRepository) {
  if (typeof workflow !== 'string') throw new TypeError('workflow must be a string');
  const separator = workflow.lastIndexOf('@');
  const qualifiedPath = workflow.slice(0, separator);
  const ref = workflow.slice(separator + 1);
  const match = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)\/(\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml)$/u.exec(qualifiedPath);
  if (
    separator <= 0
    || !match
    || (expectedRepository !== undefined && match[1] !== expectedRepository)
    || !ref.startsWith('refs/')
  ) {
    throw new TypeError('workflow must identify a repository workflow and git ref');
  }
  return {
    repository: match[1],
    path: match[2],
    ref,
    identity: `https://github.com/${workflow}`,
  };
}

function validateExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new TypeError('expected attestation claims are required');
  }
  const repository = assertRepository(expected.repository);
  const subjectSha256 = assertSha256(expected.subjectSha256);
  if (typeof expected.subjectName !== 'string' || expected.subjectName.length === 0) {
    throw new TypeError('subjectName must be a non-empty string');
  }
  if (typeof expected.commit !== 'string' || !COMMIT_PATTERN.test(expected.commit)) {
    throw new TypeError('commit must be a lowercase 40-character git commit');
  }
  const workflow = parseWorkflow(expected.workflow, repository);
  const signerWorkflow = parseWorkflow(expected.signerWorkflow);
  const derivedUrl = deriveGitHubAttestationUrl(repository, subjectSha256);
  if (expected.attestationUrl !== derivedUrl) {
    throw new GitHubAttestationError(
      'ATTESTATION_URL_MISMATCH',
      'Attestation URL does not match repository and artifact digest',
    );
  }
  return { ...expected, repository, subjectSha256, workflow, signerWorkflow, derivedUrl };
}

async function readLimitedJson(response, maxBytes, tooLargeCode, invalidCode, label) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new GitHubAttestationError(tooLargeCode, `${label} exceeds the size limit`);
    }
  }
  if (!response.body) {
    throw new GitHubAttestationError(invalidCode, `${label} body is empty`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubAttestationError(tooLargeCode, `${label} exceeds the size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let bytes = Buffer.concat(chunks, total);
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/x-snappy') {
    let declaredSize = 0;
    let shift = 0;
    let complete = false;
    for (const byte of bytes.subarray(0, 8)) {
      declaredSize += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
      shift += 7;
    }
    if (!complete || !Number.isSafeInteger(declaredSize)) {
      throw new GitHubAttestationError(invalidCode, `${label} has an invalid Snappy length`);
    }
    if (declaredSize > maxBytes) {
      throw new GitHubAttestationError(tooLargeCode, `${label} exceeds the size limit`);
    }
    try {
      bytes = Buffer.from(snappy.uncompress(bytes, maxBytes));
    } catch (error) {
      throw new GitHubAttestationError(invalidCode, `${label} is not valid Snappy`, { cause: error });
    }
    if (bytes.byteLength !== declaredSize || bytes.byteLength > maxBytes) {
      throw new GitHubAttestationError(invalidCode, `${label} has an invalid Snappy size`);
    }
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new GitHubAttestationError(invalidCode, `${label} is not valid JSON`, { cause: error });
  }
}

async function fetchJson({ fetchImpl, url, init, timeoutMs, maxBytes, codes, label }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (!response?.ok) {
      throw new GitHubAttestationError(codes.fetch, `${label} request failed`);
    }
    return await readLimitedJson(response, maxBytes, codes.tooLarge, codes.invalid, label);
  } catch (error) {
    if (error instanceof GitHubAttestationError) throw error;
    throw new GitHubAttestationError(codes.fetch, `${label} request failed`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function parseApiResponse(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.attestations)) {
    throw new GitHubAttestationError('ATTESTATION_RESPONSE_INVALID', 'GitHub attestation response is invalid');
  }
  const urls = value.attestations
    .slice(0, 100)
    .map((entry) => entry?.bundle_url)
    .filter((entry) => typeof entry === 'string');
  if (urls.length === 0) {
    throw new GitHubAttestationError('ATTESTATION_NOT_FOUND', 'No GitHub artifact attestation was found');
  }
  return urls;
}

function decodeStatement(bundle) {
  const envelope = bundle?.dsseEnvelope;
  if (
    envelope?.payloadType !== 'application/vnd.in-toto+json'
    || typeof envelope.payload !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload)
  ) {
    throw new Error('Invalid DSSE envelope');
  }
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > DEFAULT_MAX_BUNDLE_BYTES) {
    throw new Error('Invalid DSSE payload size');
  }
  const statement = JSON.parse(bytes.toString('utf8'));
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
    throw new Error('Invalid in-toto statement');
  }
  return statement;
}

function assertStatement(statement, expected) {
  if (
    statement._type !== 'https://in-toto.io/Statement/v1'
    || statement.predicateType !== 'https://slsa.dev/provenance/v1'
  ) {
    throw new Error('Unsupported provenance statement');
  }
  const subjectMatches = Array.isArray(statement.subject) && statement.subject.some((subject) => (
    subject?.name === expected.subjectName
    && subject?.digest?.sha256 === expected.subjectSha256
  ));
  if (!subjectMatches) throw new Error('Artifact subject does not match');

  const definition = statement.predicate?.buildDefinition;
  const externalWorkflow = definition?.externalParameters?.workflow;
  if (
    externalWorkflow?.repository !== `https://github.com/${expected.repository}`
    || externalWorkflow.path !== expected.workflow.path
    || externalWorkflow.ref !== expected.workflow.ref
  ) {
    throw new Error('Workflow source does not match');
  }
  const dependencyUri = `git+https://github.com/${expected.repository}@${expected.workflow.ref}`;
  const commitMatches = Array.isArray(definition?.resolvedDependencies)
    && definition.resolvedDependencies.some((dependency) => (
      dependency?.uri === dependencyUri && dependency?.digest?.gitCommit === expected.commit
    ));
  if (!commitMatches) throw new Error('Source commit does not match');
}

async function defaultVerifyBundle(bundle, options) {
  await verifySigstoreBundle(bundle, undefined, options);
}

export class GitHubArtifactAttestationVerifier {
  #fetch;
  #githubToken;
  #verifyBundle;
  #timeoutMs;
  #maxApiResponseBytes;
  #maxBundleBytes;

  constructor({
    fetchImpl = globalThis.fetch,
    githubToken,
    verifyBundle = defaultVerifyBundle,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxApiResponseBytes = DEFAULT_MAX_API_RESPONSE_BYTES,
    maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (typeof verifyBundle !== 'function') throw new TypeError('verifyBundle is required');
    this.#fetch = fetchImpl;
    this.#githubToken = optionalGitHubToken(githubToken);
    this.#verifyBundle = verifyBundle;
    this.#timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.#maxApiResponseBytes = positiveInteger(maxApiResponseBytes, 'maxApiResponseBytes');
    this.#maxBundleBytes = positiveInteger(maxBundleBytes, 'maxBundleBytes');
  }

  async verify(rawExpected) {
    const expected = validateExpected(rawExpected);
    const api = new URL(expected.derivedUrl);
    api.searchParams.set('predicate_type', 'provenance');
    api.searchParams.set('per_page', '100');
    const response = await fetchJson({
      fetchImpl: this.#fetch,
      url: api.href,
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          ...(this.#githubToken === undefined
            ? {}
            : { Authorization: `Bearer ${this.#githubToken}` }),
        },
      },
      timeoutMs: this.#timeoutMs,
      maxBytes: this.#maxApiResponseBytes,
      codes: {
        fetch: 'ATTESTATION_FETCH_FAILED',
        tooLarge: 'ATTESTATION_RESPONSE_TOO_LARGE',
        invalid: 'ATTESTATION_RESPONSE_INVALID',
      },
      label: 'GitHub attestation API',
    });
    const bundleUrls = parseApiResponse(response);
    const verificationOptions = {
      certificateIssuer: GITHUB_OIDC_ISSUER,
      certificateIdentityURI: expected.signerWorkflow.identity,
      ctLogThreshold: 1,
      tlogThreshold: 1,
    };

    for (const rawBundleUrl of bundleUrls) {
      try {
        const parsed = new URL(rawBundleUrl);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
        const bundle = await fetchJson({
          fetchImpl: this.#fetch,
          url: parsed.href,
          init: { method: 'GET', headers: { Accept: 'application/json' } },
          timeoutMs: this.#timeoutMs,
          maxBytes: this.#maxBundleBytes,
          codes: {
            fetch: 'BUNDLE_FETCH_FAILED',
            tooLarge: 'BUNDLE_TOO_LARGE',
            invalid: 'BUNDLE_INVALID',
          },
          label: 'Sigstore bundle',
        });
        await this.#verifyBundle(bundle, verificationOptions);
        assertStatement(decodeStatement(bundle), expected);
        return Object.freeze({
          verified: true,
          attestationUrl: rawExpected.attestationUrl,
          subjectName: expected.subjectName,
          subjectSha256: expected.subjectSha256,
          repository: expected.repository,
          commit: expected.commit,
          workflow: rawExpected.workflow,
          signerWorkflow: rawExpected.signerWorkflow,
        });
      } catch {
        // A query may return several attestations. Trust only a fully matching bundle.
      }
    }
    throw new GitHubAttestationError(
      'PROVENANCE_FAILED',
      'No valid GitHub artifact attestation matched',
    );
  }
}
