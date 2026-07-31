# Source Electron Kit Runtime Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make source Electron installs use the canonical Harbors desktop version, surface the exact compatibility failure, and keep install progress visible.

**Architecture:** A pure desktop-version resolver selects and validates the packaged or repository version before Electron constructs any consumers. The Registry resolver derives a bounded public detail from the existing compatibility checker. Kit Dock retains one accessible operation region but makes it sticky and writes progress before invoking IPC.

**Tech Stack:** Node.js ESM, Electron, semver, node:test, JSDOM, CSS

## Global Constraints

- `packages/desktop/package.json` remains the only repository application-version declaration.
- Packaged applications continue to trust Electron `app.getVersion()`.
- Both application-version sources must be valid SemVer.
- Renderer permissions and the fixed Kit Manager IPC surface must not expand.
- Final install acceptance must run in Electron against the online Registry.

---

### Task 1: Resolve one authoritative desktop version

**Files:**
- Create: `scripts/lib/desktop-version.mjs`
- Create: `scripts/lib/desktop-version.test.mjs`
- Modify: `scripts/electron.mjs:1-90,330-345`
- Modify: `package.json:20-35`

**Interfaces:**
- Consumes: `{ isPackaged, packagedVersion, repositoryRoot, readFileSync? }`
- Produces: `resolveDesktopVersion(options): string`

- [ ] **Step 1: Write failing resolver tests**

Cover source mode returning `0.1.0-preview.1` from a supplied desktop package, packaged mode returning the supplied Electron version without reading, and invalid/missing versions throwing `Desktop application version is invalid`.

- [ ] **Step 2: Verify the tests fail**

Run: `node --test scripts/lib/desktop-version.test.mjs`

Expected: FAIL because `desktop-version.mjs` does not exist.

- [ ] **Step 3: Implement the resolver**

Implement a focused ESM module using `readFileSync`, `path.join`, and `semver.valid`. In source mode parse `<repositoryRoot>/packages/desktop/package.json`; wrap read/parse failures with `Unable to read desktop application version`; reject non-string or invalid SemVer values with `Desktop application version is invalid`.

- [ ] **Step 4: Wire the resolved value into Electron**

Resolve once after paths/profile initialization:

```js
const desktopVersion = resolveDesktopVersion({
  isPackaged: app.isPackaged,
  packagedVersion: app.getVersion(),
  repositoryRoot,
});
```

Use `desktopVersion` for both `kitRuntime.harborsVersion` and `createAppUpdater({ currentVersion })`. Add the focused test to the root `npm test` Node test list.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test scripts/lib/desktop-version.test.mjs scripts/lib/framework-runtime.test.mjs scripts/lib/app-updater.test.mjs`

Expected: PASS.

Commit: `git commit -m '[Bug] 修复源码桌面版本解析'`

---

### Task 2: Preserve the compatibility rejection reason

**Files:**
- Modify: `scripts/lib/kit-registry/resolver.mjs:1-12,180-215`
- Modify: `scripts/lib/kit-registry/resolver.test.mjs:210-240`

**Interfaces:**
- Consumes: `checkKitCompatibility(manifest, runtime)` from `@itharbors/kit-core`
- Produces: `INCOMPATIBLE_ASSET` errors whose public message includes the first concrete failed compatibility check

- [ ] **Step 1: Strengthen the failing resolver test**

Use a release whose manifest requires `harbors: '>=2.0.0 <3.0.0'` and assert that the rejection has code `INCOMPATIBLE_ASSET` and message matching `Harbors 1.0.0 does not satisfy >=2.0.0 <3.0.0`. Keep the ambiguous-assets assertion generic.

- [ ] **Step 2: Verify the test fails**

Run: `node --test scripts/lib/kit-registry/resolver.test.mjs`

Expected: FAIL because the current resolver replaces the compatibility reason with `has no unique compatible asset`.

- [ ] **Step 3: Add minimal reason projection**

Import `checkKitCompatibility`. In the `selectCompatibleAsset` catch path, inspect assets in declared order, select the first `{ compatible: false, message }`, and append that message to the existing public error. When every asset is individually compatible, keep the current ambiguous-assets message.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-ipc.test.mjs`

Expected: PASS and serialized error text remains within the existing IPC contract for the fixture.

Commit: `git commit -m '[Bug] 展示 Kit 兼容失败原因'`

---

### Task 3: Make install activity immediately visible

**Files:**
- Modify: `scripts/lib/kit-manager-view.mjs:95-140`
- Modify: `scripts/lib/kit-manager-view.test.mjs:140-250`
- Modify: `scripts/kit-manager.css:225-250`

**Interfaces:**
- Consumes: existing `setOperationMessage(message, error)` and install inputs
- Produces: immediate `Installing <label> <version>…` status and a sticky accessible operation region

- [ ] **Step 1: Write failing view and style assertions**

Gate `api.install` on a Promise, click Install, and before resolving assert that `#operation-status` contains `Installing SQLite Workbench 1.2.0` with `role="status"`. Extend the document/style test to require `.operation-status` with `position: sticky`, `top`, and a positive `z-index`.

- [ ] **Step 2: Verify the tests fail**

Run: `node --test scripts/lib/kit-manager-view.test.mjs`

Expected: FAIL because no progress message is set and the status is not sticky.

- [ ] **Step 3: Implement progress and sticky status**

After native-code confirmation succeeds and before `api.install`, call:

```js
setOperationMessage(`Installing ${kit.label ?? kit.id} ${reference.version}…`);
```

Give `.operation-status` `position: sticky`, `top: 12px`, `z-index: 4`, and a solid paper background so it stays readable over cards.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs`

Expected: PASS.

Commit: `git commit -m '[Bug] 改善 Kit 安装状态反馈'`

---

### Task 4: Verify source and Electron install behavior

**Files:**
- Modify only if verification exposes a regression covered by a new failing test.

**Interfaces:**
- Consumes: the completed source-version, resolver-detail, and view-status changes
- Produces: evidence that local and end-to-end paths pass

- [ ] **Step 1: Run the complete affected test set**

Run:

```bash
node --test scripts/lib/desktop-version.test.mjs scripts/lib/framework-runtime.test.mjs scripts/lib/app-updater.test.mjs scripts/lib/kit-registry/resolver.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 3: Perform Electron online acceptance**

Start the branch worktree with `npm run start`, open **Kit Manager…**, refresh the Registry, install one Preview Kit, and confirm the UI transitions through Installing to Installed without `INCOMPATIBLE_ASSET`. Confirm the audit contains a successful `kit.install` entry and inspect `git status --short`.

- [ ] **Step 4: Commit any verification-only documentation if needed**

Do not create a commit when verification produces no file changes. If a test-driven correction was required, commit only those files with the branch `[Bug]` label.
