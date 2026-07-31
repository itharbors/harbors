# Kit Manager Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved compact Dock inventory design to the production Kit Manager while preserving every existing install, version-switch, and security behavior.

**Architecture:** Keep `createKitManagerView` as the only renderer and retain the existing four-region Kit row DOM. Add one sanitized installed-Kit count to the existing header, refine current-version/delete copy, and implement the visual direction primarily through local HTML/CSS so no IPC or Registry contracts change.

**Tech Stack:** Local HTML/CSS, Node.js ESM, JSDOM, `node:test`, Electron.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-29-kit-manager-visual-polish-design.md`.
- Do not add external fonts, images, scripts, preload methods, IPC channels, or public Registry fields.
- Preserve Stable/Preview grouping, native-code risk signaling, historical version switching, the indeterminate install spinner, keyboard focus, and reduced-motion behavior.
- Desktop layout uses a 68px berth rail and approximately 118px Kit rows; below 980px use two columns and below 680px use one column.
- Keep commits focused and use `[Bug]` Chinese titles on `bug/source-kit-runtime-version`.

---

### Task 1: Compact the navigation rail and header console

**Files:**

- Modify: `scripts/kit-manager.html`
- Modify: `scripts/kit-manager.css`
- Modify: `scripts/lib/kit-manager-view.mjs`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**

- Consumes: the existing sanitized `snapshot.kits` array.
- Produces: `#installed-count` text containing the count of unique records with `kit.installed`; no new public API.

- [ ] **Step 1: Add failing header behavior tests**

Extend the view test fixture with four installed Kits and assert:

```js
assert.equal(document.querySelector('#installed-count').textContent, '4 个已安装');
view.render(snapshot({ kits: [] }));
assert.equal(document.querySelector('#installed-count').textContent, '0 个已安装');
```

Parse the stylesheet through JSDOM and assert the rendered shell has a `68px minmax(0, 1fr)` grid and the header remains a two-column grid at desktop width.

- [ ] **Step 2: Run the focused view test and verify RED**

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

Expected: FAIL because `#installed-count` and the compact rail contract are absent.

- [ ] **Step 3: Implement the compact header and rail**

Replace the large vertical title structure with:

```html
<aside class="dock-mark" aria-label="ITHARBORS">
  <span class="dock-mark__monogram" aria-hidden="true">H</span>
  <span class="dock-mark__track" aria-hidden="true"></span>
  <span class="dock-mark__caption">VERIFIED KITS</span>
</aside>
```

Add `<span id="installed-count" class="installed-count">0 个已安装</span>` beside the header lede. In `render(snapshot)`, set it with:

```js
const installedCount = new Set(
  (snapshot?.kits ?? []).filter((kit) => kit.installed).map((kit) => kit.id),
).size;
installedCountNode.textContent = `${installedCount} 个已安装`;
```

Apply the approved 68px rail, restrained grid background, compact title scale, and 70px Registry console from the design spec.

- [ ] **Step 4: Run the focused test and verify GREEN**

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

- [ ] **Step 5: Commit the header change**

```bash
git add scripts/kit-manager.html scripts/kit-manager.css scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m '[Bug] 收紧 Kit 管理器首屏布局'
```

### Task 2: Refine Kit-row hierarchy and operation weight

**Files:**

- Modify: `scripts/lib/kit-manager-view.mjs`
- Modify: `scripts/kit-manager.css`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**

- Consumes: the existing `.kit-row__identity`, `.kit-row__release`, `.kit-row__installed`, and `.kit-row__actions` regions.
- Produces: compact `.kit-row` styling, `.button--current`, and `.button--danger`; event handlers and action payloads remain unchanged.

- [ ] **Step 1: Add failing operation-copy and style tests**

For an installed active version assert:

```js
assert.equal(row.querySelector('[data-action="switch-version"]').textContent, '当前已启用');
assert.equal(row.querySelector('[data-action="uninstall"]').textContent, '删除');
assert.equal(row.querySelector('[data-action="uninstall"]').classList.contains('button--danger'), true);
```

After selecting another version and dispatching `change`, continue to assert the existing `切换到此版本` or `重试此版本` copy and exact activation payload.

Create a JSDOM style sample and assert `.kit-row` computes to `display: grid`, `min-height: 118px`, and a `4px` left border.

- [ ] **Step 2: Run the view test and verify RED**

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

Expected: FAIL on current-version copy, delete copy/class, and old row dimensions.

- [ ] **Step 3: Implement compact action semantics**

Extend `createButton` options with `danger` and render its class as `button--danger`. In `syncSwitchButton`, use `当前已启用` when the selected value equals active, otherwise retain `重试此版本` or `切换到此版本`. Render uninstall with label `删除` and `{ secondary: true, danger: true }`.

Implement the approved four-column row, 118px minimum height, compact tags/selects/buttons, two-line summary clamp, and quieter shadows. Keep orange only for native-code berth stripes, risk permissions, keyboard focus, and destructive text.

- [ ] **Step 4: Implement responsive layout and accessibility polish**

At `max-width: 980px`, collapse rows to two equal columns. At `max-width: 680px`, collapse the rail to a 48px horizontal bar and rows to one column. Retain full-width controls at the narrow breakpoint and stop spinner/transform motion under `prefers-reduced-motion: reduce`.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-window.test.mjs
```

- [ ] **Step 6: Commit the row polish**

```bash
git add scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs scripts/kit-manager.css
git commit -m '[Bug] 优化 Kit 管理列表视觉层级'
```

### Task 3: Validate browser preview and native Electron window

**Files:**

- Modify only if a visual defect is found: `scripts/kit-manager.html`, `scripts/kit-manager.css`, `scripts/lib/kit-manager-view.mjs`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**

- Consumes: the production Manager document and the existing Electron process.
- Produces: review evidence only; no debug-only production switches or additional dependencies.

- [ ] **Step 1: Run all focused Manager tests**

```bash
node --test scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs scripts/lib/kit-manager-window.test.mjs
```

- [ ] **Step 2: Run repository verification**

```bash
CI=1 npm run check
```

- [ ] **Step 3: Review the production UI at desktop and narrow widths**

Confirm in the browser preview and Electron window:

- Registry status, Stable state, and at least two Preview rows are visible at 1440×900;
- no horizontal clipping at the Electron launch width;
- long version labels and multi-permission rows remain bounded;
- version selection, Preview disclosure, Refresh, install progress, and delete retain visible focus and disabled states;
- reduced motion stops the spinner animation.

- [ ] **Step 4: Commit any verification fixes**

If Task 3 requires production changes, stage only the changed Manager files and commit:

```bash
git commit -m '[Bug] 修正 Kit 管理器视觉细节'
```

If no production changes are needed, do not create an empty commit.

## Completion Audit

- [ ] Compare each visual requirement with the approved preview and design spec.
- [ ] Confirm the preload/IPC surface and sanitized Registry projection are unchanged.
- [ ] Confirm `git status --short` is clean and review `origin/main...HEAD`.
- [ ] Run the verification-before-completion checklist with fresh output.
