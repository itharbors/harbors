# Agent Guard Preview 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package Agent Guard's policy resource in the real `.hkit`, advance the Kit to `0.1.0-preview.2`, and prepare a verified Kit PR and release.

**Architecture:** Keep the policy owned by `agent-guard-background` and include it through the existing `ce-editor.assets.public` contract. Prove the fix through the real Kit packer and archive inspector before changing the resource location.

**Tech Stack:** TypeScript, Vitest, Node.js Kit CLI, npm workspaces, GitHub Actions Kit publisher.

## Global Constraints

- Preserve immutable `0.1.0-preview.1`; the corrected version is exactly `0.1.0-preview.2` on the Preview channel.
- Work only in `kit-change/agent-guard/bug/package-resources` and publish only from merged `main`.
- Do not broaden the archive format to include arbitrary Kit-root directories.
- Every production change follows a verified RED-GREEN test cycle.

---

### Task 1: Prove the packaged policy regression

**Files:**
- Modify: `kits/agent-guard/tests/kit-manifest.test.ts`

**Interfaces:**
- Consumes: `packKit({ directory, output })` and `inspectKit({ archive })` from `@itharbors/kit-cli`.
- Produces: a regression test requiring `plugins/agent-guard-background/resources/policy-v1.json` in archive checksums.

- [ ] **Step 1: Write the failing artifact test**

Add an asynchronous test that creates a temporary directory, packs `kitRoot`, inspects the generated `.hkit`, and asserts the literal checksum path `plugins/agent-guard-background/resources/policy-v1.json`; clean the temporary directory in `finally`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w @itharbors/kit-agent-guard -- --run tests/kit-manifest.test.ts`

Expected: FAIL because the packed payload has no plugin-local policy resource.

### Task 2: Package the plugin-owned resource

**Files:**
- Move: `kits/agent-guard/resources/policy-v1.json` → `kits/agent-guard/plugins/agent-guard-background/resources/policy-v1.json`
- Modify: `kits/agent-guard/plugins/agent-guard-background/package.json`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/service.ts`
- Modify: Agent Guard tests that load the policy fixture

**Interfaces:**
- Consumes: plugin `ce-editor.assets.public: string[]` packaging contract.
- Produces: runtime lookup from `main/dist` to `../../resources/policy-v1.json`.

- [ ] **Step 1: Move the policy with `apply_patch` and update test fixture paths**

All tests must read the plugin-owned resource path; do not retain a duplicate Kit-root copy.

- [ ] **Step 2: Declare the public asset root**

Add `"assets": { "public": ["resources"] }` under the background plugin's `ce-editor` object.

- [ ] **Step 3: Update runtime resolution**

Resolve `../../resources/policy-v1.json` relative to `main/dist/service.js`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -w @itharbors/kit-agent-guard -- --run tests/kit-manifest.test.ts`

Expected: PASS and the real archive inspection contains the policy checksum entry.

### Task 3: Advance the immutable Preview version

**Files:**
- Modify: `kits/agent-guard/kit.json`
- Modify: `kits/agent-guard/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: consistent `0.1.0-preview.2` identity for policy, package, and lockfile validation.

- [ ] **Step 1: Update both manifests to `0.1.0-preview.2`**

- [ ] **Step 2: Regenerate only lockfile metadata**

Run: `npm install --package-lock-only --ignore-scripts`

- [ ] **Step 3: Run Agent Guard tests**

Run: `npm test -w @itharbors/kit-agent-guard`

Expected: all Agent Guard test files pass.

### Task 4: Verify and finish the Kit change

**Files:**
- Create outside repository: `/tmp/harbors-agent-guard-preview-2-pr.md`

**Interfaces:**
- Produces: a clean commit and an open PR targeting `main`.

- [ ] **Step 1: Run the targeted Kit gate**

Run: `npm run kit:check -- agent-guard --output-directory <fresh-absolute-temp-directory>`

Expected: one `kit-agent-guard-0.1.0-preview.2-darwin-arm64.hkit` whose inspection lists the policy resource.

- [ ] **Step 2: Inspect status and diffs, stage exact files, and commit**

Commit title: `[Bug] 修复 Agent Guard 发布资源缺失`

- [ ] **Step 3: Run the Kit finish workflow**

Run: `.agents/skills/kit-workflow/scripts/finish-kit-change.sh agent-guard '修复 Agent Guard 发布资源缺失' /tmp/harbors-agent-guard-preview-2-pr.md`

Expected: verified `PR_URL=` targeting `main`.

### Task 5: Release from merged main

**Files:** None.

**Interfaces:**
- Consumes: merged Preview 2 commit on exact `origin/main`.
- Produces: immutable Tag, GitHub Release, and Registry entry.

- [ ] **Step 1: Wait for the Kit PR to be merged**

Do not merge automatically and do not publish from the change branch.

- [ ] **Step 2: Generate the exact release confirmation token**

Run from clean exact `main`: `.agents/skills/kit-workflow/scripts/release-kit.sh agent-guard 0.1.0-preview.2`

- [ ] **Step 3: Present the exact token and obtain explicit approval**

- [ ] **Step 4: Publish with the approved token and verify Tag, Release assets, workflow, Registry, and desktop activation**

