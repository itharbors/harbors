# Kit Mainline Workflow Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Kit development, CI, release preparation, documentation, and the first end-to-end Preview through `main` and `kits/{slug}` without using product or Registry branches.

**Architecture:** A pure path classifier drives a per-Kit GitHub Actions matrix. The local `kit-workflow` keeps short-lived Kit branches and worktrees but bases them on `origin/main`, while release preparation tags the exact clean `origin/main` Commit. Obsolete migration utilities and branch-oriented documentation are retired only after local regressions pass; old remote branches remain untouched as rollback refs.

**Tech Stack:** Bash 3.2-compatible scripts, Node.js 22.18.0 ES modules and tests, Git worktrees, GitHub Actions, GitHub CLI.

## Global Constraints

- Run this plan after both `2026-07-24-kit-monorepo-source-consolidation.md` and `2026-07-24-kit-release-registry-automation.md` pass.
- `main` is the only active long-lived development and PR base branch.
- Short-lived branches may use `kit-change/{slug}/{type}/{change}` and are deleted through normal PR cleanup.
- Old `kit/sqlite`, `kit/mysql`, `kit/notifications`, and `kit-registry` refs remain readable and are not pushed, rewritten, or deleted.
- Kit release preparation runs only from a clean local `main` whose HEAD equals `origin/main`.
- Tag push requires the exact confirmation token `kit/{slug}/v{version}@{40-character-commit}`.
- Path-level CI validates each directly changed Kit and validates all official Kits for shared Kit toolchain or governance changes.
- Ordinary Kit PRs and `main` pushes never create Releases or change the Framework version.
- Repository-local Author and Committer must be `VisualSJ <devhacker520@hotmail.com>`.

---

### Task 1: Add deterministic path-level Kit CI selection

**Files:**
- Create: `scripts/lib/kit-ci-selection.mjs`
- Create: `scripts/lib/kit-ci-selection.test.mjs`
- Create: `scripts/select-kit-ci.mjs`
- Create: `.github/workflows/kit-ci.yml`
- Modify: `package.json`
- Modify: `scripts/lib/ci-workflow.test.mjs`

**Interfaces:**
- Consumes: `OFFICIAL_KIT_SLUGS` from `scripts/lib/kit-monorepo.mjs`.
- Produces: `selectKitSlugs(paths: string[]): string[]`.
- Produces CLI: `node scripts/select-kit-ci.mjs <base-sha> <head-sha>` with `MATRIX_JSON=` and `HAS_KITS=` outputs.

- [ ] **Step 1: Write the failing pure selector tests**

Create `scripts/lib/kit-ci-selection.test.mjs` with these exact expectations:

```js
assert.deepEqual(selectKitSlugs(['kits/mysql/package.json']), ['mysql']);
assert.deepEqual(
  selectKitSlugs(['kits/sqlite/main.html', 'kits/notifications/layout.json']),
  ['notifications', 'sqlite'],
);
assert.deepEqual(selectKitSlugs(['docs/README.md']), []);
for (const sharedPath of [
  'package.json',
  'package-lock.json',
  'registry/policy.json',
  'registry/revocations.json',
  'packages/kit-core/src/schema.ts',
  'packages/kit-cli/src/archive.ts',
  'scripts/check-kit.mjs',
  'scripts/lib/kit-check.mjs',
  'scripts/lib/kit-monorepo.mjs',
  'scripts/kit-publish.mjs',
  'scripts/select-kit-ci.mjs',
  'scripts/lib/kit-publish/metadata.mjs',
  '.github/workflows/kit-ci.yml',
  '.github/workflows/publish-kit.yml',
  '.github/workflows/publish-kit-reusable.yml',
  '.github/workflows/publish-kit-registry.yml',
]) {
  assert.deepEqual(selectKitSlugs([sharedPath]), ['mysql', 'notifications', 'sqlite']);
}
assert.throws(() => selectKitSlugs(['kits/unknown/package.json']), /unknown Kit directory/i);
assert.throws(() => selectKitSlugs(['../kits/sqlite/package.json']), /canonical repository path/i);
```

- [ ] **Step 2: Run the test and confirm the selector is missing**

Run: `node --test scripts/lib/kit-ci-selection.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement canonical path classification**

Create `kit-ci-selection.mjs` with:

```js
import { OFFICIAL_KIT_SLUGS } from './kit-monorepo.mjs';

const SHARED_PREFIXES = [
  'packages/kit-core/',
  'packages/kit-cli/',
  'scripts/lib/kit-check.',
  'scripts/lib/kit-monorepo.',
  'scripts/lib/kit-publish/',
];
const SHARED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'registry/policy.json',
  'registry/revocations.json',
  'scripts/check-kit.mjs',
  'scripts/kit-publish.mjs',
  'scripts/select-kit-ci.mjs',
  '.github/workflows/kit-ci.yml',
  '.github/workflows/publish-kit.yml',
  '.github/workflows/publish-kit-reusable.yml',
  '.github/workflows/publish-kit-registry.yml',
]);

export function selectKitSlugs(paths) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array');
  const selected = new Set();
  for (const value of paths) {
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
      || value.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Changed path must be a canonical repository path');
    }
    if (SHARED_FILES.has(value) || SHARED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      OFFICIAL_KIT_SLUGS.forEach((slug) => selected.add(slug));
      continue;
    }
    const match = /^kits\/([^/]+)\//u.exec(value);
    if (!match) continue;
    if (!OFFICIAL_KIT_SLUGS.includes(match[1])) {
      if (match[1] !== 'default') throw new Error(`Unknown Kit directory: ${match[1]}`);
      continue;
    }
    selected.add(match[1]);
  }
  return [...selected].sort();
}
```

- [ ] **Step 4: Implement the Git diff adapter**

Create `select-kit-ci.mjs`. Accept exactly two lowercase 40-character Git SHAs, execute
`git diff --name-only --diff-filter=ACMR <base> <head>` without a shell, split non-empty lines, call
`selectKitSlugs`, load each selected runner from `registry/policy.json`, and print:

```text
MATRIX_JSON={"include":[{"kit":"mysql","runner":"ubuntu-latest"},{"kit":"sqlite","runner":"macos-14"}]}
HAS_KITS=true
```

Print `HAS_KITS=false` with `MATRIX_JSON={"include":[]}` when no official Kit applies. Exit 2 for invalid arguments and 1 for Git
or classification failures.

- [ ] **Step 5: Add the path-aware workflow**

Create `.github/workflows/kit-ci.yml` with PR, merge-group, and `main` push triggers. Its `select` job must checkout
with `fetch-depth: 0`, choose `${{ github.event.pull_request.base.sha }}` for PRs,
`${{ github.event.merge_group.base_sha }}` for merge groups, and `${{ github.event.before }}` for pushes. If a push
`before` SHA is forty zeroes, use the repository root Commit. Call `select-kit-ci.mjs`, and expose
`matrix-json`/`has-kits` outputs. Its `check-kit` job must use:

```yaml
if: needs.select.outputs.has-kits == 'true'
strategy:
  fail-fast: false
  matrix:
    include: ${{ fromJSON(needs.select.outputs.matrix-json).include }}
```

For every matrix entry, run `npm ci` followed by:

```bash
output_directory="$RUNNER_TEMP/kit-${{ matrix.kit }}"
npm run kit:check -- "${{ matrix.kit }}" --output-directory "$output_directory"
```

Set `runs-on: ${{ matrix.runner }}`. The policy emits `macos-14` for SQLite and `ubuntu-latest` for the other two.

- [ ] **Step 6: Extend CI workflow contract tests**

Assert that `kit-ci.yml` has no incomplete `paths:` trigger, uses a full-history checkout, consumes selector outputs,
uses a matrix, runs `npm ci` before `kit:check`, and never invokes either publishing workflow.

- [ ] **Step 7: Run selector and workflow tests**

Run:

```bash
node --test scripts/lib/kit-ci-selection.test.mjs scripts/lib/ci-workflow.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Register and commit the CI selector**

Add `"test:kit-ci-selection": "node --test scripts/lib/kit-ci-selection.test.mjs"` to `package.json` and append it
to the root `test` script. Then commit:

```bash
git add .github/workflows/kit-ci.yml scripts/lib/kit-ci-selection.mjs scripts/lib/kit-ci-selection.test.mjs scripts/select-kit-ci.mjs scripts/lib/ci-workflow.test.mjs package.json
git commit -m "[Feature] 按变更路径验证 Kit"
```

### Task 2: Rebase the Kit development Skill on main

**Files:**
- Modify: `.agents/skills/kit-workflow/SKILL.md`
- Modify: `.agents/skills/kit-workflow/agents/openai.yaml`
- Modify: `.agents/skills/kit-workflow/scripts/_kit-workflow-lib.sh`
- Modify: `.agents/skills/kit-workflow/scripts/start-kit-change.sh`
- Modify: `.agents/skills/kit-workflow/scripts/finish-kit-change.sh`
- Modify: `.agents/skills/kit-workflow/scripts/release-kit.sh`
- Modify: `scripts/lib/kit-workflow/test-helper.sh`
- Modify: `scripts/lib/kit-workflow/start.test.sh`
- Modify: `scripts/lib/kit-workflow/finish.test.sh`
- Modify: `scripts/lib/kit-workflow/release.test.sh`
- Modify: `scripts/lib/kit-workflow/contract.test.sh`

**Interfaces:**
- Produces: `start-kit-change.sh <kit> <type> <slug>` based on `origin/main`.
- Produces: `finish-kit-change.sh <kit> <summary> <body-file>` opening a PR to `main`.
- Produces: `release-kit.sh <kit> <semver>` tagging the exact clean `origin/main` Commit after explicit confirmation.

- [ ] **Step 1: Rewrite tests to state the mainline contract**

Change fixtures to create and push `main` containing `kits/sqlite/kit.json` and `kits/sqlite/package.json`. Assert:

```text
start:  TARGET_BRANCH=main; BASE_COMMIT equals origin/main
finish: gh pr create --base main --head kit-change/sqlite/{type}/finish-case
checks: npm run kit:check -- sqlite --output-directory {temporary-directory}
release: current branch main; HEAD equals origin/main
tag:    kit/sqlite/v0.1.0-preview.1
confirm: kit/sqlite/v0.1.0-preview.1@{commit}
```

Add rejection tests for unknown official Kits, missing `kits/sqlite/kit.json`, mismatched package/manifest versions,
wrong manifest channel for a plain/prerelease version, non-main release branch, unpushed main Commit, existing local or
remote Tag, dirty tree, and repository-local identity other than `VisualSJ <devhacker520@hotmail.com>`.

- [ ] **Step 2: Run the shell suite and observe product-branch assumptions**

Run: `npm run test:kit-workflow`

Expected: FAIL with old `origin/kit/sqlite`, product-root `kit.json`, or PR-base expectations.

- [ ] **Step 3: Make product validation directory-aware**

Change `_kit-workflow-lib.sh` so `kit_workflow_validate_product "$repo_root" "$kit" "$channel"` reads:

```text
$repo_root/kits/$kit/kit.json
$repo_root/kits/$kit/package.json
$repo_root/package-lock.json
$repo_root/registry/policy.json
```

Require the policy entry ID, manifest ID, and package name to equal `@itharbors/kit-$kit`; require package and
manifest versions to match; derive Stable/Preview from SemVer; and assert local Git config exactly:

```bash
test "$(git -C "$repo_root" config --local user.name)" = VisualSJ
test "$(git -C "$repo_root" config --local user.email)" = devhacker520@hotmail.com
```

Replace `kit_workflow_run_product_checks` with one invocation of:

```bash
(cd "$repo_root" && npm run kit:check -- "$kit" --output-directory "$pack_dir")
```

- [ ] **Step 4: Base start and finish on origin/main**

In `start-kit-change.sh`, set `target_branch=main`, resolve `refs/remotes/origin/main`, keep the existing short-lived
branch pattern and linked-worktree isolation, validate `kits/$kit`, then run root `npm ci`.

In `finish-kit-change.sh`, require the branch Kit to match the argument, require `origin/main` to be an ancestor,
validate commits since `origin/main`, run the targeted check, push normally, and create/verify an open PR with base
`main`.

- [ ] **Step 5: Make release Tag-only from exact origin/main**

In `release-kit.sh`:

1. Accept only canonical Stable or prerelease SemVer under the existing `kit-core` policy; reject build metadata.
2. Require local branch `main`, a clean tree, and `HEAD == refs/remotes/origin/main`.
3. Require `kit.json.channel=stable` for plain SemVer and `preview` for prerelease SemVer.
4. Require `kits/$kit/kit.json.version` and `kits/$kit/package.json.version` to equal the argument.
5. Reject local and remote `refs/tags/kit/$kit/v$version`.
6. Print `RELEASE_CONFIRM=kit/$kit/v$version@$commit` before any Tag creation.
7. Run the targeted Kit check.
8. Only create and push the Tag when `HARBORS_KIT_RELEASE_CONFIRM` exactly equals that token.

- [ ] **Step 6: Rewrite the Skill instructions**

State that Kit code lives under `main:kits/{slug}`, all PRs target `main`, ordinary merges do not publish, and release
Tags select one directory. Remove every active instruction referencing `origin/kit/{slug}`, product-root lock files,
branch Preview publication, or independent product histories. Keep the explicit confirmation and no-force-push rules.

- [ ] **Step 7: Run the complete Skill suite**

Run: `npm run test:kit-workflow`

Expected: all start, finish, release, identity, channel, and contract cases PASS.

- [ ] **Step 8: Commit the mainline Kit Skill**

```bash
git add .agents/skills/kit-workflow scripts/lib/kit-workflow
git commit -m "[Refactor] 将 Kit 工作流切换到主分支"
```

### Task 3: Retire branch-oriented migration tooling and documentation

**Files:**
- Delete: `scripts/migrate-kit-product.mjs`
- Delete: `scripts/migrate-kit-registry.mjs`
- Delete: `scripts/lib/kit-product-migration.test.mjs`
- Delete: `scripts/lib/kit-registry-migration.test.mjs`
- Modify: `package.json`
- Modify: `docs/guides/development-workflow.md`
- Modify: `docs/guides/kit-artifacts.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `scripts/lib/kit-docs.test.mjs`

**Interfaces:**
- Consumes: actual `kit-workflow`, tag publication, and Release-backed Registry commands from the first two plans.
- Produces: one unambiguous user workflow for editing, checking, tagging, and installing Kits from `main`.

- [ ] **Step 1: Rewrite documentation tests first**

Make `kit-docs.test.mjs` require all of these strings in the appropriate guides:

```text
kits/sqlite
kits/mysql
kits/notifications
main
kit/<name>/v<semver>
.hkit
Release Asset
registry/policy.json
registry/revocations.json
index.v1.json
https://itharbors.github.io/harbors/index.v1.json
```

Make it reject active instructions containing:

```text
PR base kit/sqlite
PR base kit/mysql
PR base kit/notifications
push kit/<name> -> Preview
migrate-kit-product.mjs
migrate-kit-registry.mjs
HEAD:kit-registry
```

- [ ] **Step 2: Run the docs test and observe obsolete workflow text**

Run: `node --test scripts/lib/kit-docs.test.mjs`

Expected: FAIL on product-branch and Registry-branch instructions.

- [ ] **Step 3: Rewrite the development guide**

Document this exact lifecycle:

```text
main
  -> kit-change/<name>/<type>/<slug>
  -> PR base main
  -> merge without Release
  -> update kits/<name>/kit.json and package.json in a version-preparation PR
  -> release-kit.sh emits confirmation
  -> push kit/<name>/v<semver>
```

Explain that changing a Kit does not change the Framework version and that shared toolchain changes run all Kit CI.

- [ ] **Step 4: Rewrite the artifact and authoring guides**

Describe Tag-to-directory selection, exact version/channel checks, `.hkit` Release Assets, automatic trusted-Release
aggregation, low-frequency policy/revocations, unchanged Framework Registry URL, and rollback refs. Remove commands
that initialize, develop on, publish from, or update the old product/Registry branches.

- [ ] **Step 5: Delete one-time branch migration programs and scripts**

Delete the four migration files listed above. Remove `test:kit-migration` and `test:kit-registry-migration` from root
`package.json` and from the root `test` chain. Do not delete any Git ref or remote repository.

- [ ] **Step 6: Run docs and stale-reference checks**

Run:

```bash
node --test scripts/lib/kit-docs.test.mjs
git grep -n 'migrate-kit-product\|migrate-kit-registry\|HEAD:kit-registry\|--base kit-registry' -- ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'
```

Expected: docs tests PASS; `git grep` returns no active-code or active-guide matches.

- [ ] **Step 7: Commit the documentation cutover**

```bash
git add package.json docs/guides scripts/lib/kit-docs.test.mjs scripts/migrate-kit-product.mjs scripts/migrate-kit-registry.mjs scripts/lib/kit-product-migration.test.mjs scripts/lib/kit-registry-migration.test.mjs
git commit -m "[Refactor] 移除旧 Kit 分支迁移流程"
```

### Task 4: Run the complete local completion audit and open the PR

**Files:**
- No planned source edits; failures return to the owning task and commit.

**Interfaces:**
- Consumes: all commands and workflows from the three implementation plans.
- Produces: one reviewable PR with full local verification evidence.

- [ ] **Step 1: Verify repository identity and cleanliness**

Run:

```bash
git config --local user.name
git config --local user.email
git status --short
```

Expected: `VisualSJ`, `devhacker520@hotmail.com`, and no uncommitted files.

- [ ] **Step 2: Install from the public lock and run all focused gates**

Run:

```bash
npm ci
npm run test:kit-monorepo
npm run test:kit-check
npm run test:kit-publish
npm run test:kit-ci-selection
npm run test:kit-workflow
node --test scripts/lib/kit-docs.test.mjs scripts/lib/kit-manager-service.test.mjs
```

Expected: every command exits 0.

- [ ] **Step 3: Run every real Kit check and the full repository gate**

Run:

```bash
sqlite_check_dir=$(mktemp -d)
mysql_check_dir=$(mktemp -d)
notifications_check_dir=$(mktemp -d)
npm run kit:check -- sqlite --output-directory "$sqlite_check_dir"
npm run kit:check -- mysql --output-directory "$mysql_check_dir"
npm run kit:check -- notifications --output-directory "$notifications_check_dir"
npm run check
```

Expected: all commands exit 0 and each temporary directory contains exactly one matching `.hkit`.

- [ ] **Step 4: Audit every explicit goal against current files**

Run:

```bash
test -f kits/sqlite/kit.json
test -f kits/mysql/kit.json
test -f kits/notifications/kit.json
git check-ignore harbors-kits
git grep -n "tags:" .github/workflows/publish-kit.yml
git grep -n 'HEAD:kit-registry\|--base kit-registry\|ref: kit-registry' -- .github/workflows scripts
git log --format='%an <%ae>|%cn <%ce>' origin/main..HEAD | sort -u
```

Expected: all manifests exist; nested repo is ignored; caller is Tag-only; no active workflow or script mutates
`kit-registry`; every new Commit identity is `VisualSJ <devhacker520@hotmail.com>|VisualSJ <devhacker520@hotmail.com>`.

- [ ] **Step 5: Push the implementation branch and create a ready PR**

Run:

```bash
git push --set-upstream origin HEAD
gh pr create --base main --head "$(git branch --show-current)" \
  --title "[Feature] 统一主分支 Kit 发布与市场" \
  --body $'## Summary\n- 将三个官方 Kit 统一为 main 下的独立目录源码\n- 使用 Kit Tag 发布单目录 .hkit 并从可信 Releases 重建市场\n- 将 CI、Skill 和文档切换到 main\n\n## Testing\n- npm run check\n- npm run test:kit-publish\n- npm run test:kit-workflow\n- 三个 npm run kit:check 均通过'
```

Expected: ordinary push succeeds; `gh pr view --json baseRefName,headRefName,state,url` reports base `main`, current
head, state `OPEN`, and a non-empty URL.

### Task 5: Activate the immutable toolchain and verify a live Preview after merge

**Files:**
- No local source edits.

**Interfaces:**
- Consumes: merged `main`, workflows from Task 4, and Notifications version `0.1.0-preview.1`.
- Produces: immutable `kit-publish-v2`, Notifications Preview Release, attestation, deployed Pages index, and a live Framework install result.

- [ ] **Step 1: Wait for reviewed PR merge and fast-forward local main**

After the user merges the PR, run:

```bash
git fetch origin --prune
git switch main
git merge --ff-only origin/main
```

Expected: local `main` equals `origin/main`; no force-push, rebase, or old-branch mutation occurs.

- [ ] **Step 2: Verify Pages and create the exact release-Tag ruleset if absent**

Run:

```bash
gh api repos/itharbors/harbors/pages --jq '.build_type'
ruleset_id=$(gh api repos/itharbors/harbors/rulesets \
  --jq '.[] | select(.name == "Protect Kit release tags") | .id' | head -n 1)
if test -z "$ruleset_id"; then
  gh api --method POST repos/itharbors/harbors/rulesets --input - <<'JSON'
{
  "name": "Protect Kit release tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/kit-publish-*", "refs/tags/kit/*/v*"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "update", "parameters": {"update_allows_fetch_and_merge": false}}
  ]
}
JSON
fi
```

Expected: Pages build type is `workflow`; the request either finds or creates one active Tag ruleset preventing
deletion and update of `kit-publish-*` and `kit/*/v*`.

- [ ] **Step 3: Create and push the immutable v2 toolchain Tag**

Run:

```bash
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
! git show-ref --verify --quiet refs/tags/kit-publish-v2
! git ls-remote --exit-code --tags origin refs/tags/kit-publish-v2 >/dev/null 2>&1
git tag kit-publish-v2 "$(git rev-parse HEAD)"
git push origin refs/tags/kit-publish-v2
```

Expected: Tag push succeeds and does not match the `kit/*/v*` Kit release trigger.

- [ ] **Step 4: Request explicit approval for the first Preview Tag**

Run once without confirmation:

```bash
.agents/skills/kit-workflow/scripts/release-kit.sh notifications 0.1.0-preview.1
```

Expected: command stops before Tag creation and prints exactly one `RELEASE_CONFIRM=` line containing the Notifications
Tag followed by `@` and the current 40-character main Commit. Present that exact line to the user and wait for approval;
implementation approval alone is not release approval.

- [ ] **Step 5: Push only the approved Preview Tag**

After the user approves the exact token, recompute the same immutable value and rerun:

```bash
export HARBORS_KIT_RELEASE_CONFIRM="kit/notifications/v0.1.0-preview.1@$(git rev-parse HEAD)"
.agents/skills/kit-workflow/scripts/release-kit.sh notifications 0.1.0-preview.1
unset HARBORS_KIT_RELEASE_CONFIRM
```

Expected: only `refs/tags/kit/notifications/v0.1.0-preview.1` is pushed.

- [ ] **Step 6: Monitor publication and inspect the immutable Release**

Run:

```bash
gh run list --workflow publish-kit.yml --limit 5
gh release view kit/notifications/v0.1.0-preview.1 \
  --json tagName,isPrerelease,targetCommitish,assets
```

Expected: workflow concludes `success`; Release is a prerelease at the approved Commit; uploaded assets contain
exactly one Notifications `.hkit`, `release.json`, `registry-entry.json`, and `sbom.spdx.json`. GitHub's separately
displayed source links are absent from Registry metadata.

- [ ] **Step 7: Verify Pages and install through the real Framework service**

First run:

```bash
curl --fail --silent --show-error https://itharbors.github.io/harbors/index.v1.json \
  | node -e '
    let text="";
    process.stdin.on("data", chunk => text += chunk);
    process.stdin.on("end", () => {
      const index = JSON.parse(text);
      const kit = index.kits.find(item => item.id === "@itharbors/kit-notifications");
      if (kit?.channels?.preview?.version !== "0.1.0-preview.1") process.exit(1);
    });
  '
```

Then execute this temporary-process Node module; it creates a new Store under the operating-system temporary directory
and never touches the user's Store:

```bash
node --input-type=module <<'NODE'
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKitManagerService } from './scripts/lib/kit-manager-service.mjs';

const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'harbors-live-kit-'));
const service = createKitManagerService({
  storeRoot,
  runtime: {
    harborsVersion: '0.0.1',
    kitApiVersion: '1.0.0',
    protocolVersion: 1,
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
  },
});
const refreshed = await service.manager.refresh();
if (refreshed.source !== 'network') throw new Error(`Unexpected Registry source: ${refreshed.source}`);
const installed = await service.manager.install({
  id: '@itharbors/kit-notifications',
  version: '0.1.0-preview.1',
  channel: 'preview',
});
if (installed.status !== 'installed') throw new Error(`Unexpected install status: ${installed.status}`);
const activated = await service.manager.activate({
  id: '@itharbors/kit-notifications',
  version: '0.1.0-preview.1',
});
if (activated.pending !== true || activated.requiresRestart !== true) {
  throw new Error('Preview activation did not enter pending-restart state');
}
console.log(JSON.stringify({ storeRoot, installed, activated }));
NODE
```

Expected: refresh source is `network`, install status is `installed`, and activation returns
`pending: true, requiresRestart: true`.

- [ ] **Step 8: Prove rollback and branch preservation**

Run:

```bash
node --test scripts/lib/kit-manager-acceptance.test.mjs
git ls-remote --heads origin kit/sqlite kit/mysql kit/notifications kit-registry
```

Expected: acceptance test PASS, including restart activation and rollback; all four old refs still resolve to their
pre-cutover tips. Do not archive or delete them in this plan.
