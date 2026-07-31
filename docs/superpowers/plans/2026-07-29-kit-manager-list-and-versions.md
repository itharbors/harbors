# Kit Manager List and Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Kit Manager as a horizontal resource list with an accessible install spinner and allow immediate switching to every locally installed historical version.

**Architecture:** Keep Registry/Store authority in `KitRegistryManager`, but order its sanitized version projection with canonical SemVer. Keep all interaction state inside `createKitManagerView`: each row owns a version selector and an operation indicator, while mutations continue through the existing narrow `install` and `activate` APIs. CSS converts the existing cards into full-width rows and provides responsive/reduced-motion behavior without changing the HTML security boundary.

**Tech Stack:** Node.js ESM, JSDOM, `node:test`, `semver` 7, local HTML/CSS, Electron preload IPC.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-29-kit-manager-list-and-versions-design.md`.
- Use test-driven development and observe each new assertion fail before production edits.
- Do not add IPC channels or expose paths, digests, URLs, source metadata, or filesystem controls.
- Stable and Preview sections remain separate; one channel reference remains one list row.
- Install progress is indeterminate; do not invent byte percentages or false phase boundaries.
- Historical activation must reuse `activate({ id, version, retryBad })` and the existing Framework hot-update transaction.
- Keep every commit on `bug/source-kit-runtime-version` with a focused `[Bug] 中文摘要` title.

---

### Task 1: Order the public installed-version projection by SemVer

**Files:**

- Modify: `scripts/lib/kit-registry/manager.mjs`
- Test: `scripts/lib/kit-registry/manager.test.mjs`

**Interfaces:**

- Consumes: strict installed Store records whose version keys are canonical SemVer.
- Produces: `installed.versions: string[]` sorted newest-first with `semver.rcompare`.

- [ ] **Step 1: Add a failing projection-order test**

Extend the Manager list test with installed versions deliberately hostile to lexical sorting:

```js
versions: {
  '1.9.0': installedVersion('1.9.0'),
  '1.10.0': installedVersion('1.10.0'),
  '2.0.0-preview.1': installedVersion('2.0.0-preview.1'),
}
```

Assert:

```js
assert.deepEqual(kit.installed.versions, [
  '2.0.0-preview.1',
  '1.10.0',
  '1.9.0',
]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/lib/kit-registry/manager.test.mjs
```

Expected: FAIL because the current lexical sort places `1.9.0` after `1.10.0`.

- [ ] **Step 3: Implement canonical SemVer ordering**

At the top of `manager.mjs` import the existing root dependency:

```js
import semver from 'semver';
```

Change only the public projection:

```js
versions: Object.keys(record.versions).sort(semver.rcompare),
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command and require zero failures.

- [ ] **Step 5: Commit the projection change**

```bash
git add scripts/lib/kit-registry/manager.mjs scripts/lib/kit-registry/manager.test.mjs
git commit -m '[Bug] 按版本顺序展示已安装 Kit'
```

### Task 2: Render and activate every installed historical version

**Files:**

- Modify: `scripts/lib/kit-manager-view.mjs`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**

- Consumes: `kit.installed.versions`, `active`, `pending`, and `badVersions` from Task 1.
- Produces: per-row `[data-role="installed-version"]` select and `[data-action="switch-version"]` button; invokes `api.activate({ id, version, retryBad })`.

- [ ] **Step 1: Add failing rendering tests for version history**

Build one installed fixture with versions `2.0.0`, `1.10.0`, and `1.9.0`, active `1.10.0`, and bad `2.0.0`. Assert:

```js
const select = row.querySelector('[data-role="installed-version"]');
assert.deepEqual([...select.options].map((option) => option.value), [
  '2.0.0', '1.10.0', '1.9.0',
]);
assert.match(select.options[0].textContent, /异常/);
assert.match(select.options[1].textContent, /当前/);
assert.equal(select.value, '1.10.0');
assert.equal(row.querySelector('[data-action="switch-version"]').disabled, true);
```

Also assert an uninstalled row and a builtin row do not render this control.

- [ ] **Step 2: Run the view test and verify RED**

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

Expected: FAIL because neither selector exists.

- [ ] **Step 3: Add minimal version-control rendering**

Add helpers with these exact responsibilities:

```js
function preferredInstalledVersion(installed) {
  return installed?.active ?? installed?.pending ?? installed?.versions?.[0];
}

function installedVersionLabel(installed, version) {
  const labels = [version];
  if (installed.active === version) labels.push('（当前）');
  if (installed.badVersions.includes(version)) labels.push('（异常）');
  return labels.join('');
}
```

For installed, non-builtin rows, append a labelled select and switch button. Set `select.dataset.role = 'installed-version'`, set each option value to the version, select `preferredInstalledVersion`, and disable the switch button while selection equals active.

- [ ] **Step 4: Verify rendering GREEN**

Run the focused view test and require zero failures.

- [ ] **Step 5: Add failing interaction tests for normal and bad versions**

In one test, select `1.9.0`, dispatch `change`, click `switch-version`, and assert:

```js
['activate', {
  id: '@itharbors/kit-sqlite',
  version: '1.9.0',
  retryBad: false,
}]
```

In a second case select `2.0.0`, assert the button text becomes `重试此版本`, click it, and assert `retryBad: true`. Confirm the warning says windows reload and includes the selected version.

- [ ] **Step 6: Run the interaction tests and verify RED**

Expected: FAIL because selection changes do not update or invoke the button.

- [ ] **Step 7: Implement historical activation**

Add `activateInstalledVersion(kit, version)` that reuses the existing queued mutation behavior:

```js
await api.activate({
  id: kit.id,
  version,
  retryBad: kit.installed.badVersions.includes(version),
});
await reloadInstalledProjection();
setOperationMessage(`已切换 ${kit.label ?? kit.id} 到 ${version}。`);
```

On select `change`, set button text to `重试此版本` for a bad version and `切换到此版本` otherwise; disable it for the active version. Remove only the rendered `rollback` shortcut while leaving `api.rollback` validation and preload compatibility intact.

- [ ] **Step 8: Run the view tests and verify GREEN**

Require all existing install, activate, uninstall, builtin, offline, and injection-safety tests to remain green.

- [ ] **Step 9: Commit historical version interaction**

```bash
git add scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m '[Bug] 支持切换 Kit 历史版本'
```

### Task 3: Add the row-local install progress indicator

**Files:**

- Modify: `scripts/lib/kit-manager-view.mjs`
- Modify: `scripts/kit-manager.css`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**

- Consumes: the existing `queue(task)` and `api.install(input)` Promise.
- Produces: `.kit-row__progress`, `.kit-row__spinner`, and row `data-operation="install"` for the in-flight install only.

- [ ] **Step 1: Add a failing pending-install test**

Hold `api.install` behind a Promise. After clicking install and before resolving it, assert:

```js
assert.equal(row.dataset.operation, 'install');
assert.equal(row.querySelector('.kit-row__progress').hidden, false);
assert.match(row.querySelector('.kit-row__progress').textContent, /正在下载并验证/);
assert.ok(row.querySelector('.kit-row__spinner'));
assert.equal(row.querySelector('.kit-row__spinner').getAttribute('aria-hidden'), 'true');
assert.equal(document.querySelector('[data-role="installed-version"]')?.disabled ?? true, true);
```

After success and after a separate rejected install, assert the retained/current row has no active operation and controls are enabled.

- [ ] **Step 2: Run the focused test and verify RED**

Expected: FAIL because the row-local progress element is absent.

- [ ] **Step 3: Implement operation-state helpers**

When creating each row, append a hidden progress container with a spinner and text node. Pass the row to `install`. Immediately after confirmation:

```js
row.dataset.operation = 'install';
progress.hidden = false;
progressText.textContent = '正在下载并验证…';
```

Clear the marker and hide progress in `finally`. Update `setBusy` to disable both `button` and `select`; preserve `data-permanent-disabled` semantics for builtin/current-version controls.

- [ ] **Step 4: Add the accessible spinner CSS**

Use the existing cobalt/navy palette:

```css
.kit-row__spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgb(36 88 211 / 22%);
  border-top-color: var(--dock-cobalt);
  border-radius: 50%;
  animation: kit-row-spin 720ms linear infinite;
}

@keyframes kit-row-spin {
  to { transform: rotate(360deg); }
}
```

Inside the existing reduced-motion media query, set `.kit-row__spinner { animation: none; }`.

- [ ] **Step 5: Run the view tests and verify GREEN**

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

- [ ] **Step 6: Commit the progress state**

```bash
git add scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs scripts/kit-manager.css
git commit -m '[Bug] 展示 Kit 安装下载进度'
```

### Task 4: Convert the card grid into horizontal resource rows

**Files:**

- Modify: `scripts/kit-manager.html`
- Modify: `scripts/kit-manager.css`
- Modify: `scripts/lib/kit-manager-view.mjs`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**

- Consumes: the row DOM from Tasks 2–3.
- Produces: `.kit-list`, `.kit-row`, `.kit-row__identity`, `.kit-row__release`, `.kit-row__installed`, and `.kit-row__actions` layout classes.

- [ ] **Step 1: Add failing structure and stylesheet tests**

Assert each rendered entry has the four row regions and the stylesheet uses a single-column list:

```js
assert.ok(row.querySelector('.kit-row__identity'));
assert.ok(row.querySelector('.kit-row__release'));
assert.ok(row.querySelector('.kit-row__installed'));
assert.ok(row.querySelector('.kit-row__actions'));
assert.match(css, /\.kit-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
assert.doesNotMatch(css, /repeat\(auto-fit,\s*minmax\(min\(100%,\s*330px\)/u);
```

Also require a responsive rule below 820px that changes `.kit-row` to fewer columns.

- [ ] **Step 2: Run the focused view test and verify RED**

Expected: FAIL on missing row regions and old auto-fit grid CSS.

- [ ] **Step 3: Restructure one rendered entry**

Rename only presentation concepts: `createCard` to `createRow`, `kit-card` to `kit-row`, and both Stable/Preview container classes in `kit-manager.html` from `.kit-grid` to `.kit-list` while keeping existing IDs and `data-kit-id` / `data-channel` selectors stable for IPC and tests.

Place name/publisher/summary in identity, channel/latest version/permissions in release, version selector/progress in installed, and all actions in actions. Keep exactly one uninstall button ownership rule.

- [ ] **Step 4: Implement the desktop and responsive CSS**

Desktop row:

```css
.kit-row {
  display: grid;
  grid-template-columns: minmax(210px, 1.4fr) minmax(190px, 1fr) minmax(210px, 1fr) minmax(180px, auto);
  gap: 22px;
  align-items: center;
  min-height: 138px;
}
```

At 980px use two columns; at 620px use one column and make primary controls full width. Preserve the left cobalt/orange risk border, quiet shadow, focus outline, and permission wrapping. Do not add new external fonts or assets.

- [ ] **Step 5: Run view tests and static security tests**

```bash
node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-window.test.mjs
```

Expected: PASS with CSP and local-resource assertions unchanged.

- [ ] **Step 6: Commit the horizontal layout**

```bash
git add scripts/kit-manager.html scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs scripts/kit-manager.css
git commit -m '[Bug] 改为横向 Kit 管理列表'
```

### Task 5: Acceptance, documentation, and live walkthrough

**Files:**

- Modify: `scripts/lib/kit-manager-acceptance.test.mjs`
- Modify: `docs/guides/kit-artifacts.md`
- Test: `scripts/lib/kit-manager-acceptance.test.mjs`

**Interfaces:**

- Consumes: the public Manager API and list UI from Tasks 1–4.
- Produces: regression evidence for install progress, cross-version selection, and live Framework application.

- [ ] **Step 1: Extend and adapt the acceptance flow**

Publish `1.2.3`, `1.2.4`, and `1.10.0`. Install/update through the normal install button, then select `1.2.3` from `[data-role="installed-version"]` and click `[data-action="switch-version"]`. Assert Store active is `1.2.3`, Runtime label is `Demo Kit 1.2.3`, and the Manager window/controller identity has not changed.

- [ ] **Step 2: Run the adapted acceptance flow**

```bash
node --test scripts/lib/kit-manager-acceptance.test.mjs
```

Expected: PASS. Tasks 1–4 establish the behavior through focused RED/GREEN cycles; this step verifies the complete public workflow without adding another production behavior.

- [ ] **Step 3: Update the guide**

Document that each row exposes all retained local versions and that selection applies immediately through Framework replacement. State that the progress circle is indeterminate because Registry download does not expose byte progress.

- [ ] **Step 4: Run all focused Manager tests**

```bash
node --test scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs
```

- [ ] **Step 5: Run repository verification**

```bash
CI=1 npm run check
```

Expected: exit code 0.

- [ ] **Step 6: Start Web-first visual validation**

Render the local Manager document and verify at desktop and narrow widths: one Kit per row, no clipping, visible download spinner, correct current/abnormal version labels, keyboard focus, and reduced-motion behavior.

- [ ] **Step 7: Finish with Electron acceptance**

Launch stable Electron with the configured GitHub credential, open Kit Manager, install or reinstall an online Kit, and switch one retained version when present. Confirm Electron/Notification/Manager identities stay stable while Framework PID changes. If the live Registry contains only one version, use the three-version acceptance fixture as update/switch evidence and record that external limitation explicitly.

- [ ] **Step 8: Commit acceptance and documentation**

```bash
git add scripts/lib/kit-manager-acceptance.test.mjs docs/guides/kit-artifacts.md
git commit -m '[Bug] 验证 Kit 列表与版本切换'
```

## Completion Audit

- [ ] Compare the rendered behavior with every section of the approved design.
- [ ] Confirm no new preload/IPC method or sensitive projection field exists.
- [ ] Confirm `git status --short` is clean and review `origin/main...HEAD`.
- [ ] Run the verification-before-completion checklist with fresh output.
