# Kit Merge Automatic Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every changed market Kit to bump its version in the development PR and automatically create and publish its immutable version Tag after merge to `main`.

**Architecture:** A pure release-intent planner validates Git revision snapshots and emits a deterministic release plan. Existing Kit CI and local finish reuse that planner, while a new serialized `main` workflow creates idempotent Git refs and explicitly dispatches the existing Tag-bound publisher because `GITHUB_TOKEN` Tag pushes do not trigger new workflow runs.

**Tech Stack:** Node.js 22 ESM, `semver`, Git CLI, Bash, GitHub Actions, GitHub CLI, Node test runner.

## Global Constraints

- Release Tags are `kit/<slug>/v<canonical-semver>` and build metadata is forbidden.
- `kit.json`, `package.json`, and `package-lock.json` root identity must agree.
- Stable versions use `channel: stable`; prerelease versions use `channel: preview`.
- Every directly changed market Kit must have a version strictly greater than its base revision.
- Validate the complete multi-Kit plan before creating any Tag.
- Never delete, move, overwrite, or force-push a Tag or immutable Release.
- Use only `GITHUB_TOKEN` with `contents: write` and `actions: write`; add no PAT or long-lived Secret.
- Keep the existing `kit-stable` Environment approval and protected `kit-publish-v2` reusable publisher.
- Preserve the manual Tag push publication path for controlled recovery.

---

### Task 1: Release-intent planner

**Files:**
- Create: `scripts/lib/kit-release-intent.mjs`
- Create: `scripts/lib/kit-release-intent.test.mjs`
- Create: `scripts/plan-kit-releases.mjs`
- Create: `scripts/lib/kit-release-intent-cli.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: canonical `baseSha` and `headSha`, repository Git objects, `registry/policy.json`, Kit JSON files, and `semver`.
- Produces: `planKitReleaseIntents({ repositoryRoot, baseSha, headSha, git }) -> Promise<ReadonlyArray<{ slug, version, channel, tag }>>` and CLI records `RELEASES_JSON=<json>` plus `HAS_RELEASES=<boolean>`.

- [ ] **Step 1: Write failing pure planner tests** for unchanged paths, one and multiple changed market Kits, new Kit publication, unchanged or lower versions, malformed SemVer, mismatched manifest/package/lock versions, channel drift, builtin Kit exclusion, and deterministic slug ordering.
- [ ] **Step 2: Run `node --test scripts/lib/kit-release-intent.test.mjs`** and verify failure because the module is absent.
- [ ] **Step 3: Implement the pure validation and planning boundary** with exact JSON identity checks, `semver.gt` for existing Kits, canonical Tag construction, deep-frozen output, and sanitized errors.
- [ ] **Step 4: Run the pure tests** and verify all cases pass.
- [ ] **Step 5: Write failing CLI integration tests** using temporary Git repositories, real 40-character revisions, NUL-delimited changed paths, root/new Kit history, invalid arguments, and safe one-line failures.
- [ ] **Step 6: Implement `scripts/plan-kit-releases.mjs`** with bounded `git diff`/`git show`, canonical SHA validation, deterministic JSON output, and exit codes 0/1/2.
- [ ] **Step 7: Register `test:kit-release-intent` in `package.json` and `test:workflows`**, then run `npm run test:kit-release-intent` and verify all planner and CLI tests pass.
- [ ] **Step 8: Commit** with `[Feature] 建立 Kit 版本发布意图门禁` after staging only the five task files.

### Task 2: Local and PR enforcement

**Files:**
- Modify: `.agents/skills/kit-workflow/scripts/finish-kit-change.sh`
- Modify: `.agents/skills/kit-workflow/tests/finish.test.sh`
- Modify: `.github/workflows/kit-ci.yml`
- Modify: `scripts/lib/ci-workflow.test.mjs`

**Interfaces:**
- Consumes: Task 1 CLI output and the existing Kit CI `selection` step outputs `base-sha` and `head-sha`.
- Produces: a local pre-push failure for missing version bumps and a required existing Kit CI job that prints the deterministic release plan to `$GITHUB_STEP_SUMMARY`.

- [ ] **Step 1: Add failing shell tests** proving finish rejects a changed Kit with no version bump before pack/push and accepts a synchronized strictly higher version.
- [ ] **Step 2: Add failing workflow contract tests** requiring the existing `select` job to call the planner with its exact base/head outputs and append the result to the Step Summary.
- [ ] **Step 3: Run `npm run test:kit-workflow` and `node --test scripts/lib/ci-workflow.test.mjs`** and verify the new assertions fail.
- [ ] **Step 4: Invoke the planner in `finish-kit-change.sh`** after the fresh-base boundary validation and before packaging or network writes.
- [ ] **Step 5: Invoke the planner in the existing Kit CI `select` job** for pull requests, merge groups, and main pushes, preserving existing event-specific revision selection.
- [ ] **Step 6: Run the focused shell and Node tests** and verify they pass.
- [ ] **Step 7: Commit** with `[Feature] 强制 Kit PR 同步升级版本` after staging only the four task files.

### Task 3: Idempotent Tag creation and explicit publication dispatch

**Files:**
- Create: `.github/workflows/auto-publish-kit.yml`
- Modify: `.github/workflows/publish-kit.yml`
- Modify: `scripts/lib/kit-publish/workflows.test.mjs`

**Interfaces:**
- Consumes: Task 1 CLI records, `github.event.before`, `github.sha`, GitHub refs/Releases APIs, and `publish-kit.yml` dispatch inputs `release-tag` and `request-id`.
- Produces: serialized `main` merge runs that validate all candidates, create exact lightweight refs, skip already published Releases, and dispatch the Tag-bound publisher.

- [ ] **Step 1: Write failing workflow contract tests** for the `main`-only trigger, non-cancelling concurrency, minimal permissions, full-history checkout, complete preflight planning, lightweight Tag identity checks, no delete/force behavior, Release idempotency, and explicit per-Tag dispatch.
- [ ] **Step 2: Extend the existing publisher contract test** to require both Tag push compatibility and `workflow_dispatch` inputs, an exact `inputs.release-tag`/`GITHUB_REF` check, and a request-correlated run name.
- [ ] **Step 3: Run `node --test scripts/lib/kit-publish/workflows.test.mjs`** and verify the new assertions fail.
- [ ] **Step 4: Add `workflow_dispatch` to `publish-kit.yml`** while retaining `push.tags`; verify the dispatch Tag equals the checked-out `GITHUB_REF` before resolving the trusted market Kit.
- [ ] **Step 5: Implement `auto-publish-kit.yml`** to compute the full plan before writes, inspect or create each exact ref through `gh api`, skip existing Releases, and run `gh workflow run publish-kit.yml --ref "$tag" -f release-tag="$tag" -f request-id="$request_id"`.
- [ ] **Step 6: Run the workflow contract tests** and verify they pass without weakening the reusable publisher assertions.
- [ ] **Step 7: Commit** with `[Feature] 合并后自动发布 Kit 版本` after staging only the three task files.

### Task 4: Workflow documentation and final verification

**Files:**
- Modify: `.agents/skills/kit-workflow/SKILL.md`
- Modify: `docs/guides/development-workflow.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `scripts/lib/kit-docs.test.mjs`

**Interfaces:**
- Consumes: the final behavior from Tasks 1-3.
- Produces: one documented normal lifecycle, an explicit PR version checklist, and a manual recovery path that retains exact confirmation.

- [ ] **Step 1: Write failing documentation contract assertions** requiring the automatic lifecycle, synchronized three-file version bump, merge-as-release-authorization rule, Stable approval behavior, and manual recovery wording.
- [ ] **Step 2: Update the Kit Skill, development guide, and PR template** to describe the automatic path and distinguish `release-kit.sh` as recovery-only.
- [ ] **Step 3: Run `node --test scripts/lib/kit-docs.test.mjs`** and verify it passes.
- [ ] **Step 4: Run focused verification:** `npm run test:kit-release-intent`, `npm run test:kit-workflow`, `npm run test:kit-publish`, and `node --test scripts/lib/ci-workflow.test.mjs scripts/lib/kit-docs.test.mjs`.
- [ ] **Step 5: Run `npm run test:workflows` and `git diff --check`**, then inspect `git status --short`, `git diff`, and `git log origin/main..HEAD`.
- [ ] **Step 6: Commit** with `[Docs] 说明 Kit 合并自动发布流程` only if documentation remains as an independent final change; otherwise include it in the matching feature commit.
