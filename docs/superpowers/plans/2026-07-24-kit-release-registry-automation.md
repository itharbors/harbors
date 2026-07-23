# Kit Release and Registry Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exactly one directory-selected Kit from a `kit/{slug}/v{semver}` Tag and automatically rebuild the Pages Registry from verified GitHub Releases without Registry commits.

**Architecture:** A thin tag-triggered caller invokes an immutable `kit-publish-v2` reusable workflow. Publication metadata treats both Stable and Preview as immutable SemVer Tags. A release-source adapter enumerates GitHub Releases, validates their metadata and attestations against `registry/policy.json`, then the existing Registry projector selects the highest non-revoked version per channel and deploys a complete index.

**Tech Stack:** GitHub Actions reusable workflows, GitHub CLI/API, Node.js 22.18.0, npm 10.9.3, Sigstore attestations, `semver` 7.8.5, GitHub Pages.

## Global Constraints

- Run this plan after `2026-07-24-kit-monorepo-source-consolidation.md` passes.
- Publication Tags are exactly `kit/{sqlite|mysql|notifications}/v<valid-semver>`.
- A plain SemVer requires `kit.json.channel=stable`; a prerelease SemVer requires `kit.json.channel=preview`.
- Tag version, `kit.json.version`, `package.json.version`, `release.json.version`, and artifact filename version must match exactly.
- The Tag Commit must be reachable from `origin/main`.
- `.hkit` is the installable asset; GitHub-generated Source code ZIP/TAR URLs never enter Registry metadata.
- Existing Releases and assets are immutable and never overwritten.
- `index.v1.json` is rebuilt from all trusted Releases and is never committed to a Registry branch.
- `registry/policy.json` and `registry/revocations.json` are the only checked-in Registry governance state.
- The default Pages URL remains `https://itharbors.github.io/harbors/index.v1.json`.
- The v1 signer remains trusted for old Releases; new Releases use immutable signer `kit-publish-v2`.
- Repository-local Author and Committer must be `VisualSJ <devhacker520@hotmail.com>`.

---

### Task 1: Convert publication metadata to immutable Stable and Preview Tags

**Files:**
- Modify: `scripts/lib/kit-publish/metadata.mjs`
- Modify: `scripts/lib/kit-publish/metadata.test.mjs`
- Modify: `scripts/lib/kit-publish/registry.mjs`
- Modify: `scripts/lib/kit-publish/registry.test.mjs`

**Interfaces:**
- Consumes: existing `createKitPublicationMetadata(input)` and `parseRegistryEntry(value)` calls.
- Produces: `validateTag` semantics where every channel uses `kit/{slug}/v{manifest.version}` and a matching `refs/tags/...` ref.
- Produces: new release metadata with signer workflow `publish-kit-reusable.yml@refs/tags/kit-publish-v2`.

- [ ] **Step 1: Rewrite tests around prerelease SemVer Tags**

In `metadata.test.mjs`, make the Preview fixture use:

```js
const previewTag = 'kit/mysql/v1.3.0-preview.1';
const previewRef = `refs/tags/${previewTag}`;
```

Assert both Stable and Preview metadata use:

```js
source: {
  repository: 'itharbors/harbors',
  tag: channel === 'stable'
    ? 'kit/mysql/v1.2.3'
    : 'kit/mysql/v1.3.0-preview.1',
}
```

Add failing cases for a branch ref, a Tag version different from `kit.json`, a plain version with channel
`preview`, and a prerelease version with channel `stable`. Change the expected signer workflow to
`itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2`.

- [ ] **Step 2: Run focused tests and observe branch-preview failures**

Run: `node --test scripts/lib/kit-publish/metadata.test.mjs scripts/lib/kit-publish/registry.test.mjs`

Expected: FAIL because production code still requires `refs/heads/kit/mysql` and `preview/mysql/...`.

- [ ] **Step 3: Replace channel-specific tag parsing with exact SemVer identity**

In `metadata.mjs`:

```js
import semver from 'semver';

const PUBLISH_SIGNER_WORKFLOW =
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2';

function validateTag({ channel, ref, slug, tag, version }) {
  const expectedTag = `kit/${slug}/v${version}`;
  if (tag !== expectedTag || ref !== `refs/tags/${expectedTag}`) {
    throw new Error(`Kit publication requires Tag ${expectedTag}`);
  }
  const prerelease = semver.prerelease(version);
  if (channel === 'stable' && prerelease !== null) {
    throw new Error('Stable publication requires a version without a prerelease segment');
  }
  if (channel === 'preview' && prerelease === null) {
    throw new Error('Preview publication requires a SemVer prerelease segment');
  }
}
```

Remove `PREVIEW_TAG_PATTERN` and the unused `commit` argument from `validateTag`.

In `registry.mjs`, make `parseRegistryEntry` require `source.tag === kit/{slug}/v{version}` for both channels.
Make `validateRelease` expect `publish-kit.yml@refs/tags/{source.tag}` for both channels. Make revocation evidence
use the same exact Tag rule for Stable and Preview. Replace the single v1 signer equality with an immutable set
containing exactly the v1 and v2 signer refs; reject every signer outside that set. This preserves validation of old
Release evidence while new metadata always emits v2.

- [ ] **Step 4: Run the metadata and Registry tests**

Run: `node --test scripts/lib/kit-publish/metadata.test.mjs scripts/lib/kit-publish/registry.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the immutable Tag model**

```bash
git add scripts/lib/kit-publish/metadata.mjs scripts/lib/kit-publish/metadata.test.mjs scripts/lib/kit-publish/registry.mjs scripts/lib/kit-publish/registry.test.mjs
git commit -m "[Refactor] 统一 Kit 版本标签发布模型"
```

### Task 2: Discover and attest trusted GitHub Release assets

**Files:**
- Create: `scripts/lib/kit-publish/release-source.mjs`
- Create: `scripts/lib/kit-publish/release-source.test.mjs`
- Modify: `scripts/lib/kit-publish/registry.mjs`

**Interfaces:**
- Consumes: a parsed `KitPolicy`, `parseRegistryEntry(value)`, `parseReleaseManifest(value)`, and a verifier exposing `verify(expected): Promise<claims>`.
- Produces: `discoverTrustedKitReleases({ policy, repository, githubToken, fetchImpl, provenanceVerifier }): Promise<{ entries, releasesByUrl }>`.
- Produces: `validateRegistryRelease(entry, rawRelease): ReleaseManifest`, exported from `registry.mjs`.

- [ ] **Step 1: Write failing release-discovery tests**

Create `release-source.test.mjs` with an injected fetch function and verifier. Cover all of these exact cases:

1. API pages `1` and `2` are requested until a page has fewer than 100 Releases.
2. Drafts, unrelated Tags, unknown Kit slugs, and Releases without all three named assets are ignored.
3. A valid Release requires `release.json`, `registry-entry.json`, and exactly one `.hkit` asset.
4. `release.json` and `registry-entry.json` are downloaded using their `browser_download_url` values and
   `Accept: application/octet-stream`.
5. `release.tag_name`, Registry entry source Tag, release workflow Tag ref, manifest version, asset name, digest,
   and URL must agree.
6. The provenance verifier receives:

```js
{
  repository: 'itharbors/harbors',
  subjectName: 'kit-mysql-1.2.3-any-any.hkit',
  subjectSha256: 'a'.repeat(64),
  commit: '0123456789abcdef0123456789abcdef01234567',
  workflow: 'itharbors/harbors/.github/workflows/publish-kit.yml@refs/tags/kit/mysql/v1.2.3',
  signerWorkflow: 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  attestationUrl: 'https://api.github.com/repos/itharbors/harbors/attestations/sha256:' + 'a'.repeat(64),
}
```

7. A metadata mismatch or failed attestation rejects the complete aggregation instead of publishing a partial index.

- [ ] **Step 2: Run the test and confirm the adapter is missing**

Run: `node --test scripts/lib/kit-publish/release-source.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `release-source.mjs`.

- [ ] **Step 3: Export the existing release validator**

Rename private `validateRelease` in `registry.mjs` to:

```js
export function validateRegistryRelease(entry, rawRelease) {
  // Keep the existing strict identity, permissions, URL, workflow,
  // single-asset, digest, and attestation-URL checks.
}
```

Update all internal callers and tests to use the exported name.

- [ ] **Step 4: Implement bounded, authenticated Release discovery**

Create `release-source.mjs` with:

```js
const RELEASE_TAG = /^kit\/(mysql|notifications|sqlite)\/v(.+)$/u;
const API_VERSION = '2026-03-10';
const MAX_RELEASES = 1000;
const MAX_METADATA_BYTES = 1024 * 1024;

export async function discoverTrustedKitReleases({
  policy,
  repository,
  githubToken,
  fetchImpl = globalThis.fetch,
  provenanceVerifier,
}) {
  if (repository !== policy.repository) throw new Error('Release repository is not trusted');
  if (typeof githubToken !== 'string' || githubToken.length === 0) {
    throw new Error('GitHub token is required');
  }
  const releases = await listReleases({ repository, githubToken, fetchImpl });
  const entries = [];
  const releasesByUrl = new Map();
  for (const releaseRecord of releases) {
    if (releaseRecord.draft) continue;
    const match = RELEASE_TAG.exec(releaseRecord.tag_name);
    if (!match || !Object.hasOwn(policy.kits, match[1])) continue;
    const assets = indexAssets(releaseRecord.assets);
    if (!assets.has('release.json') || !assets.has('registry-entry.json')) {
      throw new Error(`Trusted Kit Release is incomplete: ${releaseRecord.tag_name}`);
    }
    const hkitAssets = [...assets.values()].filter((asset) => asset.name.endsWith('.hkit'));
    if (hkitAssets.length !== 1) {
      throw new Error(`Trusted Kit Release must contain exactly one .hkit: ${releaseRecord.tag_name}`);
    }
    const entry = parseRegistryEntry(await fetchAssetJson(assets.get('registry-entry.json'), {
      githubToken, fetchImpl, maxBytes: MAX_METADATA_BYTES,
    }));
    if (entry.source.tag !== releaseRecord.tag_name) throw new Error('Release Tag does not match Registry entry');
    const rawRelease = await fetchAssetJson(assets.get('release.json'), {
      githubToken, fetchImpl, maxBytes: MAX_METADATA_BYTES,
    });
    const validated = validateRegistryRelease(entry, rawRelease);
    if (!policy.signerWorkflows.includes(validated.source.signerWorkflow)) {
      throw new Error('Release signer workflow is not trusted');
    }
    const expectedPrerelease = validated.channel === 'preview';
    if (releaseRecord.prerelease !== expectedPrerelease
      || releaseRecord.target_commitish !== validated.source.commit) {
      throw new Error('GitHub Release channel or target Commit does not match release.json');
    }
    const artifact = validated.assets[0];
    if (artifact.name !== hkitAssets[0].name || artifact.url !== hkitAssets[0].browser_download_url) {
      throw new Error('Release .hkit asset does not match release.json');
    }
    await provenanceVerifier.verify({
      repository: validated.source.repository,
      subjectName: artifact.name,
      subjectSha256: artifact.sha256,
      commit: validated.source.commit,
      workflow: validated.source.workflow,
      signerWorkflow: validated.source.signerWorkflow,
      attestationUrl: validated.source.attestationUrl,
    });
    entries.push(entry);
    releasesByUrl.set(entry.releaseManifestUrl, validated);
  }
  return Object.freeze({ entries: Object.freeze(entries), releasesByUrl });
}
```

Implement `listReleases`, `indexAssets`, and `fetchAssetJson` in the same file with these fixed limits: 100 items per
page, at most 10 pages, one MiB per metadata asset, HTTPS-only asset URLs, no redirects to non-HTTPS origins, and an
`Authorization` header formed by prefixing `githubToken` with `Bearer ` plus
`X-GitHub-Api-Version: 2026-03-10` on API calls.

- [ ] **Step 5: Run release-source and existing Registry tests**

Run:

```bash
node --test scripts/lib/kit-publish/release-source.test.mjs
node --test scripts/lib/kit-publish/registry.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit trusted Release discovery**

```bash
git add scripts/lib/kit-publish/release-source.mjs scripts/lib/kit-publish/release-source.test.mjs scripts/lib/kit-publish/registry.mjs scripts/lib/kit-publish/registry.test.mjs
git commit -m "[Feature] 扫描并验证可信 Kit Release"
```

### Task 3: Select the newest non-revoked release and expose the new aggregate CLI

**Files:**
- Modify: `scripts/lib/kit-publish/registry.mjs`
- Modify: `scripts/lib/kit-publish/registry.test.mjs`
- Modify: `scripts/kit-publish.mjs`
- Modify: `scripts/lib/kit-publish/cli.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `discoverTrustedKitReleases(...)` from Task 2.
- Produces: `aggregateKitRegistry({ repositoryRoot, repository, policyFile, revocationsFile, generatedAt, githubToken, fetchImpl, provenanceVerifier })`.
- Produces CLI: `kit-publish.mjs aggregate --repository-root ... --repository ... --policy-file ... --revocations-file ... --output ... --generated-at ...` using `GITHUB_TOKEN` from the environment.

- [ ] **Step 1: Write failing version-selection and revocation tests**

Add cases to `registry.test.mjs` with Stable versions `1.0.0`, `1.1.0`, `2.0.0` and Preview versions
`2.1.0-preview.1`, `2.1.0-preview.2`. Assert:

```js
assert.equal(index.kits[0].channels.stable.version, '2.0.0');
assert.equal(index.kits[0].channels.preview.version, '2.1.0-preview.2');
```

Then revoke the `2.0.0` artifact digest and assert Stable falls back to `1.1.0`. Add duplicate Tag/version tests that
must fail instead of choosing nondeterministically.

In `cli.test.mjs`, assert the aggregate dependency receives `repositoryRoot`, `repository`, `policyFile`,
`revocationsFile`, `generatedAt`, and `githubToken: 'test-token'`; remove every `entriesDirectory` expectation.

- [ ] **Step 2: Run tests and observe duplicate-channel and old-option failures**

Run: `node --test scripts/lib/kit-publish/registry.test.mjs scripts/lib/kit-publish/cli.test.mjs`

Expected: FAIL because the old projector rejects multiple versions per channel and the CLI still requires
`--entries-directory`.

- [ ] **Step 3: Implement deterministic channel selection**

Add direct root dependency `semver: "^7.8.5"`. In `buildKitRegistryIndex`:

1. Parse and validate every entry and Release first.
2. Reject duplicate `(id, version, channel)` and duplicate source Tags.
3. Validate all revocation evidence.
4. Exclude a candidate when a validated revocation matches its Kit ID, version, and `.hkit` digest.
5. Group remaining candidates by `(id, channel)`.
6. Sort with `semver.rcompare(left.version, right.version)` and use index `0`.
7. Keep display identity equality checks across all versions and channels.
8. Sort final Kits and public revocations with the existing deterministic keys.

- [ ] **Step 4: Replace filesystem entries with Release discovery**

Change `aggregateKitRegistry` to call `loadKitPolicy({ repositoryRoot, policyFile })`, pass the returned policy to
`discoverTrustedKitReleases`, load revocations, fetch any revocation evidence not already present, and call
`buildKitRegistryIndex`.

Replace CLI aggregate options with exactly:

```js
const AGGREGATE_OPTIONS = [
  'repository-root',
  'repository',
  'policy-file',
  'revocations-file',
  'output',
  'generated-at',
];
```

Pass `process.env.GITHUB_TOKEN`; fail with `ERROR=GitHub token is required` before any request when it is absent.

- [ ] **Step 5: Regenerate the lock and run publication tests**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm run test:kit-publish
```

Expected: all Kit publication tests PASS; no test or production code reads `registry/entries`.

- [ ] **Step 6: Commit Release-backed aggregation**

```bash
git add package.json package-lock.json scripts/kit-publish.mjs scripts/lib/kit-publish/registry.mjs scripts/lib/kit-publish/registry.test.mjs scripts/lib/kit-publish/cli.test.mjs
git commit -m "[Feature] 从 Release 重建 Kit 市场索引"
```

### Task 4: Replace product callers and Registry branch deployment with mainline workflows

**Files:**
- Create: `.github/workflows/publish-kit.yml`
- Create: `.github/workflows/publish-kit-registry.yml`
- Modify: `.github/workflows/publish-kit-reusable.yml`
- Delete: `.github/kit-templates/publish-kit.yml`
- Delete: `.github/kit-templates/registry-pages.yml`
- Modify: `scripts/lib/kit-publish/workflows.test.mjs`

**Interfaces:**
- Consumes: `npm run kit:check`, `kit-publish.mjs prepare`, and the new aggregate CLI.
- Produces: tag-only caller `.github/workflows/publish-kit.yml`.
- Produces: reusable/manual Pages workflow `.github/workflows/publish-kit-registry.yml`.
- Produces: immutable reusable publisher intended to be tagged `kit-publish-v2` after merge.

- [ ] **Step 1: Replace workflow text tests with the new contract**

Rewrite `workflows.test.mjs` to assert:

- caller trigger contains only `tags: ['kit/*/v*']`, not product branches or `main`;
- caller invokes `publish-kit-reusable.yml@kit-publish-v2`;
- reusable workflow parses slug from `github.ref`, checks `origin/main` ancestry, runs `npm ci`, and invokes
  `npm run kit:check -- "$KIT_NAME"` plus `kit-publish.mjs prepare --kit-directory "kits/$KIT_NAME"`;
- all `gh release` commands set `GH_REPO: ${{ github.repository }}` or pass `--repo`;
- Preview uses `--prerelease`, Stable uses environment `kit-stable`, and both use `--verify-tag` without
  `--clobber`;
- no workflow checks out, commits, pushes, or opens a PR against `kit-registry`;
- Registry workflow supports `workflow_call` and `workflow_dispatch`, checks out `main`, scans Releases, uploads a
  Pages artifact, and deploys with `pages: write`/`id-token: write`;
- publisher ends with a reusable Registry deployment job after the successful Stable or Preview Release job.

- [ ] **Step 2: Run workflow tests and confirm old templates fail the contract**

Run: `node --test scripts/lib/kit-publish/workflows.test.mjs`

Expected: FAIL on branch triggers, `kit-registry` mutations, missing mainline caller, and missing release scanner.

- [ ] **Step 3: Add the thin tag caller**

Create `.github/workflows/publish-kit.yml` with this complete job boundary:

```yaml
name: Publish Kit

on:
  push:
    tags:
      - 'kit/*/v*'

permissions:
  contents: write
  id-token: write
  attestations: write
  pages: write

jobs:
  publish:
    uses: itharbors/harbors/.github/workflows/publish-kit-reusable.yml@kit-publish-v2
    secrets: inherit
```

- [ ] **Step 4: Rewrite the reusable publisher for a directory-selected Kit**

Keep four jobs with these exact responsibilities:

1. `context` on Ubuntu: checkout the Tag with full history; require `refs/tags/kit/{slug}/v{version}`; fetch
   `origin/main`; require `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`; load label, summary, runner, ID
   from `registry/policy.json`; emit slug/version/channel/runner outputs.
2. `prepare` on `${{ needs.context.outputs.runner }}`: checkout the Tag; install Node 22.18.0; run `npm ci`; run
   `npm run kit:check -- "$KIT_NAME" --output-directory "$RUNNER_TEMP/kit-check"`; run `kit-publish.mjs prepare`
   against `kits/$KIT_NAME`; inspect the produced `.hkit`; upload a one-day `kit-publication` artifact.
3. `publish-preview` or `publish-stable`: download the bundle, attest the `.hkit` and `release.json`, reject an
   existing Release, and create the Release with explicit `GH_REPO`. Stable uses `environment: kit-stable`; Preview
   uses `--prerelease`; both pass `--verify-tag` and upload only `.hkit`, `release.json`, `sbom.spdx.json`, and
   `registry-entry.json`.
4. `publish-registry`: with `always()` plus an exact success predicate for one publish job, call
   `itharbors/harbors/.github/workflows/publish-kit-registry.yml@kit-publish-v2` and inherit secrets.

Remove branch Preview generation, Preview retention deletion, Registry checkout, Registry commits, and Registry PRs.

- [ ] **Step 5: Add the reusable/manual Pages deployment**

Create `.github/workflows/publish-kit-registry.yml` with:

```yaml
name: Publish Kit Registry

on:
  workflow_call:
  workflow_dispatch:

concurrency:
  group: kit-registry-pages
  cancel-in-progress: false
```

Its `build` job checks out `ref: main`, installs Node 22.18.0 with `npm ci --ignore-scripts`, builds
`@itharbors/kit-core` and `@itharbors/kit-cli`, and runs:

```bash
site_directory="$RUNNER_TEMP/registry-site"
mkdir -p "$site_directory"
node scripts/kit-publish.mjs aggregate \
  --repository-root "$GITHUB_WORKSPACE" \
  --repository "$GITHUB_REPOSITORY" \
  --policy-file registry/policy.json \
  --revocations-file registry/revocations.json \
  --output "$site_directory/index.v1.json" \
  --generated-at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
```

Set `GITHUB_TOKEN: ${{ github.token }}` for this step. Configure Pages, upload only `$RUNNER_TEMP/registry-site`,
and deploy in a separate `deploy` job with `pages: write`, `id-token: write`, and environment `github-pages`.

- [ ] **Step 6: Delete obsolete templates and run workflow tests**

Delete both `.github/kit-templates/*.yml` files. Run:

```bash
npm run test:kit-publish
git grep -n 'HEAD:kit-registry\|--base kit-registry\|branches:.*kit/' -- .github scripts/lib/kit-publish
```

Expected: tests PASS; `git grep` returns no matches.

- [ ] **Step 7: Commit the workflow cutover**

```bash
git add .github/workflows/publish-kit.yml .github/workflows/publish-kit-reusable.yml .github/workflows/publish-kit-registry.yml .github/kit-templates scripts/lib/kit-publish/workflows.test.mjs
git commit -m "[Feature] 自动发布 Kit 与市场索引"
```

### Task 5: Trust the v2 signer without invalidating v1 releases

**Files:**
- Modify: `scripts/lib/kit-manager-service.mjs`
- Modify: `scripts/lib/kit-manager-service.test.mjs`

**Interfaces:**
- Consumes: existing `DEFAULT_KIT_PUBLISHER_POLICIES`.
- Produces: official signer allowlist containing immutable `kit-publish-v1` and `kit-publish-v2` refs.

- [ ] **Step 1: Write the failing compatibility assertion**

Change the default-policy test to require:

```js
signerWorkflows: [
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
]
```

Keep the repository, caller workflow, Registry URL, and auto-update publisher assertions unchanged.

- [ ] **Step 2: Run the service test and observe the missing v2 signer**

Run: `node --test scripts/lib/kit-manager-service.test.mjs`

Expected: FAIL because the default policy contains only v1.

- [ ] **Step 3: Append the exact v2 signer identity**

Add the v2 ref after v1 in `DEFAULT_KIT_PUBLISHER_POLICIES.itharbors.signerWorkflows`; do not replace v1 and do not
add a mutable branch reference.

- [ ] **Step 4: Run trust-policy and resolver regressions**

Run:

```bash
node --test scripts/lib/kit-manager-service.test.mjs scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-registry/github-attestation.test.mjs
npm run test:kit-publish
```

Expected: PASS.

- [ ] **Step 5: Commit the compatible signer policy**

```bash
git add scripts/lib/kit-manager-service.mjs scripts/lib/kit-manager-service.test.mjs
git commit -m "[Feature] 信任 Kit 发布工具链 v2"
```
