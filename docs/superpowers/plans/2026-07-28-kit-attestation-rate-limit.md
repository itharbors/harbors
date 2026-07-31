# Kit Attestation Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kit installation report GitHub attestation rate limits precisely and let controlled desktop development sessions authenticate attestation API requests.

**Architecture:** `GitHubArtifactAttestationVerifier` classifies only trustworthy GitHub rate-limit responses and emits one stable public error. `KitReleaseResolver` passes through only that typed error while continuing to collapse all cryptographic and claim failures. `createKitManagerService` forwards an optional Harbors-specific token without exposing it through public configuration or sending it to bundle and artifact hosts.

**Tech Stack:** Node.js ESM, Electron, Sigstore, native `fetch`, Node test runner, GitHub Artifact Attestations API.

## Global Constraints

- The optional environment variable is exactly `HARBORS_KIT_GITHUB_TOKEN`.
- The stable public error code is exactly `ATTESTATION_RATE_LIMITED`.
- A rate limit requires HTTP 403 or 429, `x-ratelimit-remaining: 0`, and a valid positive Unix-seconds `x-ratelimit-reset`.
- The public message uses a UTC ISO timestamp: `GitHub verification rate limit reached. Retry after <ISO timestamp>.`
- A token is sent only to the canonical `api.github.com/repos/<owner>/<repo>/attestations/sha256:<digest>` request and never to a bundle, Release, Registry, or artifact request.
- Do not change Registry or Release schemas, cache attestation bundles, weaken Sigstore checks, or expose the token in service config, snapshots, logs, or errors.

---

### Task 1: Classify GitHub Attestation Rate Limits

**Files:**
- Modify: `scripts/lib/kit-registry/github-attestation.mjs:155-185,326-351`
- Test: `scripts/lib/kit-registry/github-attestation.test.mjs:292-360`

**Interfaces:**
- Consumes: `fetchJson({ fetchImpl, url, init, timeoutMs, maxBytes, codes, label })` and GitHub response headers.
- Produces: `GitHubAttestationError` with `code === 'ATTESTATION_RATE_LIMITED'` and a bounded UTC retry message.

- [ ] **Step 1: Write failing tests for valid and invalid rate-limit responses**

Add tests that exercise the real verifier API request path:

```js
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='rate limit|rate-limit' scripts/lib/kit-registry/github-attestation.test.mjs
```

Expected: FAIL because valid 403 and 429 responses currently become `ATTESTATION_FETCH_FAILED`.

- [ ] **Step 3: Implement minimal trusted rate-limit parsing**

Add a helper and an optional fetch error code:

```js
function rateLimitReset(response) {
  if (![403, 429].includes(response.status)) return undefined;
  if (response.headers.get('x-ratelimit-remaining') !== '0') return undefined;
  const raw = response.headers.get('x-ratelimit-reset');
  if (raw === null || !/^[1-9][0-9]{0,9}$/u.test(raw)) return undefined;
  const resetSeconds = Number(raw);
  if (!Number.isSafeInteger(resetSeconds)) return undefined;
  const reset = new Date(resetSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return undefined;
  return reset.toISOString();
}
```

In `fetchJson`, before the generic non-OK error, throw `codes.rateLimited` only when `rateLimitReset(response)` returns a value. Set `rateLimited: 'ATTESTATION_RATE_LIMITED'` only for the GitHub attestation API call; bundle calls must not classify rate limits as API rate limits.

- [ ] **Step 4: Run the full verifier test file and verify GREEN**

Run:

```bash
node --test scripts/lib/kit-registry/github-attestation.test.mjs
```

Expected: all tests pass, including token isolation and Electron ECDSA compatibility.

- [ ] **Step 5: Inspect and commit Task 1**

Run:

```bash
git diff --check
git diff -- scripts/lib/kit-registry/github-attestation.mjs scripts/lib/kit-registry/github-attestation.test.mjs
git add scripts/lib/kit-registry/github-attestation.mjs scripts/lib/kit-registry/github-attestation.test.mjs
git diff --cached --check
git commit -m '[Bug] 展示 GitHub 证明限流'
```

### Task 2: Preserve the Typed Limit Through Resolution

**Files:**
- Modify: `scripts/lib/kit-registry/resolver.mjs:1-8,319-329`
- Test: `scripts/lib/kit-registry/resolver.test.mjs:350-385`

**Interfaces:**
- Consumes: `GitHubAttestationError` from `./github-attestation.mjs`.
- Produces: `KitRegistryResolutionError('ATTESTATION_RATE_LIMITED', message, { cause })` only for the typed rate-limit error; every other verifier failure remains `PROVENANCE_FAILED`.

- [ ] **Step 1: Write the failing resolver boundary test**

Import `GitHubAttestationError` and add:

```js
test('preserves only a typed GitHub attestation rate limit for Kit Manager', async () => {
  const limited = new GitHubAttestationError(
    'ATTESTATION_RATE_LIMITED',
    'GitHub verification rate limit reached. Retry after 2026-07-28T12:27:57.000Z.',
  );
  const resolver = createResolver({
    verifier: { verify: async () => { throw limited; } },
  });
  await assert.rejects(
    resolver.resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => (
      error.code === 'ATTESTATION_RATE_LIMITED'
      && error.message === limited.message
      && error.cause === limited
    ),
  );

  const generic = createResolver({
    verifier: { verify: async () => { throw Object.assign(new Error('secret'), { code: 'ATTESTATION_RATE_LIMITED' }); } },
  });
  await assert.rejects(
    generic.resolve({ id: manifest.id, version: manifest.version, channel: 'stable', runtime }),
    (error) => error.code === 'PROVENANCE_FAILED' && !error.message.includes('secret'),
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='typed GitHub attestation rate limit' scripts/lib/kit-registry/resolver.test.mjs
```

Expected: FAIL because the resolver currently converts both errors to `PROVENANCE_FAILED`.

- [ ] **Step 3: Implement the typed pass-through**

Import `GitHubAttestationError`. In the verifier catch block, add exactly one exception:

```js
if (error instanceof GitHubAttestationError && error.code === 'ATTESTATION_RATE_LIMITED') {
  throw new KitRegistryResolutionError(error.code, error.message, { cause: error });
}
```

Keep the existing generic `PROVENANCE_FAILED` conversion after this condition.

- [ ] **Step 4: Run resolver and IPC/view tests and verify GREEN**

Run:

```bash
node --test scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-view.test.mjs
```

Expected: all tests pass and IPC continues to serialize only bounded stable errors.

- [ ] **Step 5: Inspect and commit Task 2**

Run:

```bash
git diff --check
git diff -- scripts/lib/kit-registry/resolver.mjs scripts/lib/kit-registry/resolver.test.mjs
git add scripts/lib/kit-registry/resolver.mjs scripts/lib/kit-registry/resolver.test.mjs
git diff --cached --check
git commit -m '[Bug] 传递 Kit 证明限流信息'
```

### Task 3: Forward a Harbors-Specific GitHub Token

**Files:**
- Modify: `scripts/lib/kit-manager-service.mjs:141-180`
- Test: `scripts/lib/kit-manager-service.test.mjs:35-115`
- Modify: `docs/guides/kit-artifacts.md:100-112`

**Interfaces:**
- Consumes: optional `env.HARBORS_KIT_GITHUB_TOKEN: string | undefined`.
- Produces: `GitHubArtifactAttestationVerifier({ fetchImpl, githubToken })`; public `service.config` remains unchanged and contains no token.

- [ ] **Step 1: Write the failing service composition test**

Create a service with `HARBORS_KIT_GITHUB_TOKEN: 'development-token'`, call its exposed `provenanceVerifier.verify` against a canonical expected claim, return `{ attestations: [] }`, and assert:

```js
assert.equal(requests[0].init.headers.Authorization, 'Bearer development-token');
assert.equal(Object.hasOwn(service.config, 'githubToken'), false);
assert.equal(JSON.stringify(service.config).includes('development-token'), false);
```

Also assert that `createKitManagerService` rejects a token containing `\n` through the existing verifier validation.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
node --test --test-name-pattern='GitHub token' scripts/lib/kit-manager-service.test.mjs
```

Expected: FAIL because the service does not pass `HARBORS_KIT_GITHUB_TOKEN` to the verifier.

- [ ] **Step 3: Implement minimal token forwarding**

Change only verifier construction:

```js
const provenanceVerifier = new GitHubArtifactAttestationVerifier({
  fetchImpl,
  githubToken: env.HARBORS_KIT_GITHUB_TOKEN,
});
```

Do not add the token to `resolveKitManagerConfig` or the returned config clone.

- [ ] **Step 4: Document the controlled-development setting**

In `docs/guides/kit-artifacts.md`, document that normal installations may use anonymous GitHub API capacity and controlled development can set:

```bash
HARBORS_KIT_GITHUB_TOKEN="$(gh auth token)" npm run electron
```

State that the token is process-only, is not persisted, and is sent only to the canonical GitHub attestation API request.

- [ ] **Step 5: Run service, verifier, resolver, and docs tests and verify GREEN**

Run:

```bash
node --test scripts/lib/kit-manager-service.test.mjs scripts/lib/kit-registry/github-attestation.test.mjs scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-docs.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Inspect and commit Task 3**

Run:

```bash
git diff --check
git diff -- scripts/lib/kit-manager-service.mjs scripts/lib/kit-manager-service.test.mjs docs/guides/kit-artifacts.md
git add scripts/lib/kit-manager-service.mjs scripts/lib/kit-manager-service.test.mjs docs/guides/kit-artifacts.md
git diff --cached --check
git commit -m '[Bug] 支持 Kit 证明认证请求'
```

### Task 4: Electron Acceptance and Final Verification

**Files:**
- Verify only: `/Users/bytedance/Library/Application Support/Electron/kit-store/audit.ndjson`
- Verify only: `/Users/bytedance/Library/Application Support/Electron/kit-store/installed.json`

**Interfaces:**
- Consumes: completed Tasks 1-3, configured GitHub CLI credential, Electron Kit Manager UI.
- Produces: real online CSV installation evidence and a clean, fully verified worktree.

- [ ] **Step 1: Stop the currently running Electron development process**

Send `Ctrl-C` to the tracked Electron session and wait for the Framework child processes to exit.

- [ ] **Step 2: Launch Electron with the existing GitHub CLI credential**

Run without printing the token:

```bash
HARBORS_KIT_GITHUB_TOKEN="$(gh auth token)" npm run electron
```

Expected: Electron and the Framework become ready with Kit Manager available from the ITHARBORS tray menu.

- [ ] **Step 3: Install CSV through the real Kit Manager UI**

Open Preview Berths, click CSV `Install`, accept the native-code warning, and wait for the card to show `Installed` plus `Activate after restart`.

- [ ] **Step 4: Verify persistent installation evidence**

Run:

```bash
tail -5 '/Users/bytedance/Library/Application Support/Electron/kit-store/audit.ndjson'
node -e 'const fs=require("node:fs"); const state=JSON.parse(fs.readFileSync("/Users/bytedance/Library/Application Support/Electron/kit-store/installed.json","utf8")); console.log(JSON.stringify(state.kits["@itharbors/kit-csv"], null, 2));'
```

Expected: latest CSV audit event is `kit.install` with `outcome: success`, and installed state contains `0.1.0-preview.1`.

- [ ] **Step 5: Run the full repository check**

Run:

```bash
npm run check
```

Expected: exit code 0.

- [ ] **Step 6: Verify final repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate main..HEAD
```

Expected: no diff errors, clean status, and all rate-limit changes are committed on `bug/source-kit-runtime-version`.
