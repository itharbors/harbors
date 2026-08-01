# Kit Manager Error Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a safe runtime failure cause through Kit activation and display it as accessible expandable technical details in the Kit Manager.

**Architecture:** Carry a bounded failure record in activation outcomes, wrap it in a typed runtime error, serialize only typed errors and their bounded cause messages across IPC, validate the shape in preload, and render text-only details in the existing status region.

**Tech Stack:** Node.js ESM, Electron IPC/preload, DOM APIs, JSDOM, Node test runner.

## Global Constraints

- Do not expose stacks, arbitrary properties, HTML, or more than four 240-character causal messages.
- Preserve rollback, bad-version, and runtime recovery behavior.
- Unknown or malformed thrown values retain the generic `OPERATION_FAILED` fallback.
- Work only in `bug/kit-manager-error-details`; keep this PR independent of Agent Guard.
- Every production change follows a verified RED-GREEN test cycle.

---

### Task 1: Retain runtime activation failure details

**Files:**
- Modify: `scripts/lib/kit-store/startup.test.mjs`
- Modify: `scripts/lib/kit-store/startup.mjs`

**Interfaces:**
- Produces: failed activation outcomes with `error: { code: 'RUNTIME_LOAD_FAILED', message: string }`.

- [ ] **Step 1: Change the existing failed-runtime expectations first**

Require the literal validation message in the `error` field for both recovery-pending and disabled outcomes.

- [ ] **Step 2: Run the startup test and verify RED**

Run: `node --test scripts/lib/kit-store/startup.test.mjs`

Expected: FAIL because outcomes currently contain only id, version, and status.

- [ ] **Step 3: Add bounded runtime failure capture**

Normalize only `Error.message`, strip control characters, collapse whitespace, cap at 240 characters, and use `Kit runtime validation failed` when no safe message exists.

- [ ] **Step 4: Re-run and verify GREEN**

Run: `node --test scripts/lib/kit-store/startup.test.mjs`

### Task 2: Create a typed runtime-apply error with cause

**Files:**
- Create: `scripts/lib/kit-runtime-error.mjs`
- Create: `scripts/lib/kit-runtime-error.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: root `package.json` test command

**Interfaces:**
- Produces: `createKitRuntimeApplyError(message, failure)` returning code `KIT_RUNTIME_APPLY_FAILED` and an optional typed cause.

- [ ] **Step 1: Write the failing unit test**

Assert the returned error has the stable code, summary, and cause carrying `RUNTIME_LOAD_FAILED` plus the exact missing-resource message; assert malformed failure input produces no cause.

- [ ] **Step 2: Run and verify RED**

Run: `node --test scripts/lib/kit-runtime-error.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal factory and integrate it**

When `replaceFrameworkForKitMutation` finds the target failed outcome, pass `outcome.error` into the factory before restoring the previous runtime.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test scripts/lib/kit-runtime-error.test.mjs scripts/lib/electron-launcher.test.mjs`

### Task 3: Serialize and reconstruct safe cause messages

**Files:**
- Modify: `scripts/lib/kit-manager-ipc.test.mjs`
- Modify: `scripts/lib/kit-manager-ipc.mjs`
- Modify: `scripts/lib/kit-manager-preload.test.mjs`
- Modify: `scripts/kit-manager-preload.cjs`

**Interfaces:**
- IPC failure: `{ code, message, causes?: string[] }`.
- Preload error: `Error & { code: string, causes?: string[] }`.

- [ ] **Step 1: Add IPC RED cases**

Require a typed error's nested causes in outer-to-inner order, with control characters removed, four-item limit, and 240-character truncation; retain the generic fallback for untyped top-level errors.

- [ ] **Step 2: Run IPC tests and verify RED**

Run: `node --test scripts/lib/kit-manager-ipc.test.mjs`

- [ ] **Step 3: Implement bounded typed-error serialization**

Only serialize causes when the top-level error has a valid stable code. Traverse `cause` links, accept valid `Error` messages only, and never serialize stacks or arbitrary fields.

- [ ] **Step 4: Add preload RED cases**

Require a valid causes array to be frozen/copied onto the thrown renderer error; malformed codes, messages, or causes must become the generic fallback.

- [ ] **Step 5: Implement preload validation and verify GREEN**

Run: `node --test scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs`

### Task 4: Render accessible expandable technical details

**Files:**
- Modify: `scripts/lib/kit-manager-view.test.mjs`
- Modify: `scripts/lib/kit-manager-view.mjs`
- Modify: `scripts/kit-manager.css`

**Interfaces:**
- Consumes: renderer errors with `code` and optional `causes`.
- Produces: summary text plus native `<details>` containing code and ordered cause text.

- [ ] **Step 1: Extend the operation-error test first**

Require `#operation-status` to contain the summary, a closed native details element labeled `技术详情`, the stable code, literal causes, and no injected HTML; require the next success/progress message to remove stale details.

- [ ] **Step 2: Run and verify RED**

Run: `node --test scripts/lib/kit-manager-view.test.mjs`

- [ ] **Step 3: Implement text-only details rendering and minimal styling**

Clear the status node for every message, append a summary span, and append details only for errors with validated technical fields.

- [ ] **Step 4: Re-run and verify GREEN**

Run: `node --test scripts/lib/kit-manager-view.test.mjs`

### Task 5: Verify the end-to-end boundary and finish

**Files:**
- Modify if needed: `scripts/lib/kit-manager-acceptance.test.mjs`
- Create outside repository: `/tmp/harbors-kit-manager-error-details-pr.md`

**Interfaces:**
- Produces: a clean bug commit and an open PR targeting `main`.

- [ ] **Step 1: Add one acceptance assertion only if focused boundary tests do not cover the real chain**

The acceptance must use a real nested runtime error and assert the renderer-visible code and missing-resource message, not a mock call count.

- [ ] **Step 2: Run the focused suite**

Run: `node --test scripts/lib/kit-store/startup.test.mjs scripts/lib/kit-runtime-error.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/electron-launcher.test.mjs`

- [ ] **Step 3: Run the repository verification gate, inspect diffs, stage exact files, and commit**

Commit title: `[Bug] 显示 Kit 管理失败根因`

- [ ] **Step 4: Finish the change workflow**

Run: `.agents/skills/change-workflow/scripts/finish-change.sh '显示 Kit 管理失败根因' /tmp/harbors-kit-manager-error-details-pr.md`

Expected: verified `PR_URL=` targeting `main`.
