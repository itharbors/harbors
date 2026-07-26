# Registry Pages Build Version Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Kit release can refresh the public Registry even when several release tags point to the same commit.

**Architecture:** Keep the immutable `kit-publish-v2` signer, trusted Release scanner, and protected GitHub Pages deployment unchanged. After the v2 publisher completes, make the main tag-triggered caller start a correlated `workflow_dispatch` from `main`, then wait for that exact Registry run so `actions/deploy-pages` executes in the supported standalone dispatch context and publication failures still fail the Kit release workflow.

**Tech Stack:** GitHub Actions YAML, GitHub CLI, Node.js test runner

## Global Constraints

- Preserve GitHub Pages environment protection and OIDC deployment.
- Preserve immutable GitHub Release discovery and aggregation from `main`.
- Do not create commits or mutate Registry branches from CI.
- Keep Kit publication blocked on a failed Registry deployment.

---

### Task 1: Correlated Registry Dispatch

**Files:**
- Modify: `scripts/lib/kit-publish/workflows.test.mjs`
- Modify: `.github/workflows/publish-kit.yml`
- Modify: `.github/workflows/publish-kit-registry.yml`

**Interfaces:**
- Consumes: a successful immutable v2 publisher job and `${{ github.run_id }}-${{ github.run_attempt }}`.
- Produces: one `workflow_dispatch` Registry run on `main`, identified by a required `request-id`, whose conclusion is propagated to the caller.

- [ ] **Step 1: Write the failing workflow contract test**

Assert that the main tag-triggered caller dispatches `publish-kit-registry.yml` on `main` only after the immutable v2 publisher succeeds, with a unique request ID, resolves the matching run by its display title, and waits with `gh run watch --exit-status`. Assert that the Registry workflow declares the input and uses it in `run-name`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test scripts/lib/kit-publish/workflows.test.mjs`

Expected: FAIL because the main caller has no follow-up dispatch job and the Registry has no correlated dispatch input.

- [ ] **Step 3: Implement the minimal workflow change**

Add an Ubuntu follow-up job with `actions: write` after the immutable publisher, dispatch the Registry workflow against `main`, poll until its correlated run appears, and wait for its final conclusion. Add the required `request-id` workflow-dispatch input and deterministic `run-name` to the Registry workflow.

- [ ] **Step 4: Run focused and complete Kit publication checks**

Run: `node --test scripts/lib/kit-publish/workflows.test.mjs`

Run: `npm run test:kit-publish`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Inspect and commit**

Inspect `git status --short`, `git diff`, and `git diff --cached`; stage only the three implementation/test files and this plan. Commit as `[Bug] 修复同提交 Kit 市场发布`.

### Task 2: Publish the Fix for Review

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: clean committed branch `bug/registry-pages-build-version`.
- Produces: a GitHub pull request targeting `main`.

- [ ] **Step 1: Run final verification**

Run the focused workflow test, the complete Kit publication suite, and the repository workflow syntax/contract checks required by the finish script.

- [ ] **Step 2: Create the PR through the repository workflow**

Create a body file outside the repository with exact `## Summary` and `## Testing` sections, then run `.agents/skills/change-workflow/scripts/finish-change.sh` with the unlabelled summary `修复同提交 Kit 市场发布`.

- [ ] **Step 3: Verify the PR result**

Require `PR_URL=` from the finish script and preserve the worktree for review feedback.
