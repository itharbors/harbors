# Scheduler Tabler-Style Admin Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Scheduler panel as a compact Tabler-inspired administration page with operational metrics, semantic data tables, and a modal editor drawer.

**Architecture:** Keep the existing DOM-rendered TypeScript panel and Scheduler service contract. Replace card-oriented rendering with pure render helpers for summary metrics, job rows, history rows, and a fixed drawer; retain the existing action, validation, polling, and scheduling helpers. Use one local CSS token layer rather than adding Bootstrap, Tabler, or another dependency.

**Tech Stack:** TypeScript, browser DOM APIs, CSS, Vitest/jsdom, Harbors Kit tooling

## Global Constraints

- Work only in `kit-change/scheduler/feature/scheduled-scripts`.
- Do not change the Scheduler service contract, persistence format, scheduling semantics, permissions, or Kit dependencies.
- Do not import Bootstrap, Tabler CSS, or a component framework.
- Keep all new user-facing copy in Chinese except the `Scheduler` breadcrumb label.
- Keep one-time validation, missed-trigger policies, interval cadence, script selection, and polling behavior unchanged.
- Keep visible focus, 40 px touch targets, reduced motion, semantic status text, and unrestricted browser zoom.
- Use the approved tokens: canvas `#f6f8fb`, surface `#ffffff`, text `#182433`, muted `#667382`, border `#e6e7e9`, blue `#066fd1`, success `#2fb344`, warning `#f59f00`, danger `#d63939`.

---

### Task 1: Page header, operational summary, and job table

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`

**Interfaces:**
- Consumes: `SchedulerSnapshot`, existing `formatSchedule`, `formatDateTime`, `runAction`, and `openForm`
- Produces: `createSummary()`, `createMetricCard(label, value, tone)`, `createJobsSection()`, and `createJobRow(job)`

- [ ] **Step 1: Replace the first render test with failing admin-structure assertions**

Add assertions equivalent to:

```ts
expect(document.querySelector('.scheduler-breadcrumb')?.textContent).toContain('Scheduler');
expect(document.querySelectorAll('[data-testid="metric-card"]')).toHaveLength(4);
expect(metricValue('计划总数')).toBe('1');
expect(metricValue('已启用')).toBe('1');
expect(metricValue('正在运行')).toBe('0');
expect(metricValue('失败记录')).toBe('0');
expect(document.querySelector('#jobs-table')).toBeInstanceOf(HTMLTableElement);
expect(document.querySelector('#jobs-table thead')?.textContent).toContain('下次执行');
expect(document.querySelector('[data-job-id="job-1"]')?.textContent).toContain('每日汇总');
expect(document.querySelector('[data-job-id="job-1"] .status-badge')?.textContent).toBe('已启用');
```

Add a `metricValue(label: string)` helper that finds the unique metric card by its `.metric-label` text and returns `.metric-value` text.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @itharbors/kit-scheduler -- plugins/scheduler-panel/tests/panel.test.ts
```

Expected: FAIL because the breadcrumb, metric cards, table, and status badge do not exist.

- [ ] **Step 3: Implement the page hierarchy and derived metrics**

Update `renderWorkspace()` to append the skip link, header, optional alert, summary, jobs table, history table, and optional drawer in that order:

```ts
workspace.append(createSkipLink(), createHeader());
if (actionMessage) workspace.append(createActionAlert(actionMessage));
workspace.append(createSummary(), createJobsSection(), createHistory());
if (formVisible) workspace.append(createWorkbench());
```

Task 3 replaces the transitional `createWorkbench()` append with `createDrawer()` after the drawer has a failing test and implementation.

Implement metrics without new service calls:

```ts
function createSummary() {
  const failed = snapshot!.runs.filter((run) =>
    run.status === 'failed' || run.status === 'interrupted').length;
  const summary = document.createElement('section');
  summary.className = 'metric-grid';
  summary.setAttribute('aria-label', '调度概览');
  summary.append(
    createMetricCard('计划总数', snapshot!.jobs.length, 'neutral'),
    createMetricCard('已启用', snapshot!.jobs.filter((job) => job.enabled).length, 'success'),
    createMetricCard('正在运行', snapshot!.activeJobIds.length, 'warning'),
    createMetricCard('失败记录', failed, failed > 0 ? 'danger' : 'neutral'),
  );
  return summary;
}
```

Add the breadcrumb to `createHeader()` and keep `新建计划` as the single creation control.

- [ ] **Step 4: Replace job cards with a semantic table**

Make `createJobsSection()` create `table#jobs-table` with the five approved columns. Empty snapshots render one `tr[data-state="empty"] > td[colspan="5"]` with guidance and no second creation button. Convert `createJobCard(job)` to `createJobRow(job)` while preserving `data-job-id`, every existing `data-action`, the confirmation controls, and localized schedule/policy text.

Use explicit status classes:

```ts
const status = running
  ? { label: '运行中', tone: 'running' }
  : job.enabled
    ? { label: '已启用', tone: 'enabled' }
    : { label: '已暂停', tone: 'paused' };
badge.className = `status-badge status-${status.tone}`;
badge.textContent = status.label;
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Task 1 command. Expected: the new structure test and existing action tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts
git commit -m '[Feature] 重构定时任务后台列表'
```

### Task 2: Semantic run-history table

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`

**Interfaces:**
- Consumes: `JobRun`, `snapshot.jobs`, `triggerLabel`, `runStatusLabel`, and `formatDateTime`
- Produces: semantic `createHistory()`, `createRunRow(run)`, and `formatDuration(run)`

- [ ] **Step 1: Write failing history-table tests**

Assert:

```ts
expect(document.querySelector('#history-table')).toBeInstanceOf(HTMLTableElement);
expect(document.querySelector('#history-table thead')?.textContent).toContain('触发来源');
expect(document.querySelector('[data-run-id="run-1"]')?.textContent).toContain('定时触发');
expect(document.querySelector('[data-run-id="run-1"]')?.textContent).toContain('1 秒');
expect(document.querySelector('[data-run-id="run-1"] details pre')?.textContent).toContain('done');
```

Keep the deleted-job assertion and update its selector to the table row.

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 1 test command. Expected: FAIL because history still renders articles and no duration column exists.

- [ ] **Step 3: Implement the history table and duration helper**

Create table columns `运行结果`, `触发来源`, `执行时间`, `耗时`, and `输出`. Return `运行中` for unfinished active runs, `—` when timestamps are incomplete, `< 1 秒` below 1000 ms, and rounded seconds otherwise:

```ts
function formatDuration(run: JobRun) {
  if (run.status === 'running') return '运行中';
  if (!run.startedAt || !run.finishedAt) return '—';
  const elapsed = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  return elapsed < 1_000 ? '< 1 秒' : `${Math.round(elapsed / 1_000)} 秒`;
}
```

Keep native `details`/`summary`, the dark `pre`, and `已删除计划` fallback.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 test command. Expected: all history and retained-history tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts
git commit -m '[Feature] 重构脚本运行记录表格'
```

### Task 3: Accessible plan-editor drawer

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`

**Interfaces:**
- Consumes: existing `createJobForm()`, form validation, preview, `runAction('saveJob')`, and polling preservation
- Produces: `createDrawer()`, `requestCloseForm()`, `closeForm()`, `formDirty`, and focus restoration state

- [ ] **Step 1: Write failing drawer and focus tests**

Open the form and assert:

```ts
const opener = document.querySelector<HTMLButtonElement>('[data-action="new-job"]')!;
opener.click();
const drawer = document.querySelector('[role="dialog"]');
expect(drawer?.getAttribute('aria-modal')).toBe('true');
expect(drawer?.getAttribute('aria-labelledby')).toBe('job-form-title');
expect(document.querySelector('.drawer-backdrop')).not.toBeNull();
expect(document.querySelector('[data-action="close-form"]')?.getAttribute('aria-label'))
  .toBe('关闭计划编辑器');
```

Add separate tests that Escape closes a pristine drawer and restores focus to the newly rendered `新建计划` button, while a dirty drawer calls `window.confirm('放弃未保存的更改？')` and remains open when it returns `false`.

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 1 test command. Expected: FAIL because the current workbench has no dialog, backdrop, close control, or dirty-close logic.

- [ ] **Step 3: Add drawer presentation state and lifecycle cleanup**

Add:

```ts
let formDirty = false;
let returnFocusTarget: { action: 'new-job' | 'edit-job'; jobId?: string } | null = null;
```

Reset both values during mount/unmount and after successful save. Update `openForm(jobId, target)` to initialize them before rendering.

- [ ] **Step 4: Implement close confirmation and focus restoration**

Use one close path for Cancel, the close button, Escape, and backdrop:

```ts
function requestCloseForm() {
  if (actionBusy) return;
  if (formDirty && !window.confirm('放弃未保存的更改？')) return;
  closeForm();
}

function closeForm() {
  const target = returnFocusTarget;
  formVisible = false;
  editingJobId = null;
  formDirty = false;
  returnFocusTarget = null;
  renderWorkspace();
  const row = target?.jobId
    ? [...document.querySelectorAll<HTMLElement>('[data-job-id]')]
      .find((element) => element.dataset.jobId === target.jobId)
    : null;
  const focusTarget = row?.querySelector<HTMLElement>('[data-action="edit-job"]')
    ?? document.querySelector<HTMLElement>('[data-action="new-job"]');
  focusTarget?.focus();
}
```

- [ ] **Step 5: Implement dialog, backdrop, Escape, and focus containment**

`createDrawer()` returns a `.drawer-backdrop` containing `aside.scheduler-drawer[role="dialog"][aria-modal="true"]`. Backdrop clicks close only when `event.target === backdrop`. Escape calls `requestCloseForm()`. Tab/Shift+Tab wraps between enabled buttons, inputs, selects, summaries, and textareas. The close button is:

```ts
const close = createButton('×', 'close-form', requestCloseForm, 'drawer-close');
close.setAttribute('aria-label', '关闭计划编辑器');
```

Mark `formDirty = true` on user `input` and `change`; do not mark dirty during initial field synchronization. Route the existing Cancel action through `requestCloseForm()`.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the Task 1 test command. Expected: drawer, focus, dirty-close, validation, preview, polling, and pending-save tests pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts
git commit -m '[Feature] 增加计划编辑抽屉交互'
```

### Task 4: Tabler-inspired visual system and responsive states

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css`
- Test: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

**Interfaces:**
- Consumes: semantic classes from Tasks 1–3
- Produces: the approved token system, table/card/drawer layout, and complete interaction states

- [ ] **Step 1: Add structural accessibility assertions before CSS replacement**

Assert the skip link targets `#jobs-table`, status badges contain visible text, the close control has an accessible label, and tables have captions or `aria-labelledby` relationships. These assertions must fail if Tasks 1–3 omitted the required semantics.

- [ ] **Step 2: Replace the stylesheet with the approved token system**

Define tokens in `:root`, then style:

```css
:root {
  --tblr-canvas: #f6f8fb;
  --tblr-surface: #fff;
  --tblr-text: #182433;
  --tblr-muted: #667382;
  --tblr-border: #e6e7e9;
  --tblr-blue: #066fd1;
  --tblr-success: #2fb344;
  --tblr-warning: #f59f00;
  --tblr-danger: #d63939;
}
```

Use a centered 1280 px page, four-column metric grid, white 8 px table cards, 44–52 px rows, compact badges, tabular number columns, and the system Chinese font stack. Do not add gradients, glass blur, decorative grids, or default panel shadows.

- [ ] **Step 3: Implement precise interactive states**

Inside `@media (hover: hover)`, increase contrast for primary/secondary/danger buttons, inputs, summaries, and table rows without translating rows. Use `transform: translateY(1px)` only for button `:active`. Keep a three-pixel focus-visible ring. Reveal danger emphasis only on the delete control's hover/focus, not on the whole row.

- [ ] **Step 4: Implement drawer and responsive CSS**

Use fixed full-viewport backdrop, 480 px right drawer, opacity backdrop entry, and horizontal drawer entry. Below 760 px, convert table rows to labeled stacked grids using `td::before { content: attr(data-label) }`; below 620 px, make the drawer full width and stack the header/metric grid. Add `overscroll-behavior: contain` to the drawer body and disable transitions/animations under `prefers-reduced-motion: reduce`.

- [ ] **Step 5: Run tests and build**

Run:

```bash
npm run test -w @itharbors/kit-scheduler -- plugins/scheduler-panel/tests/panel.test.ts
npm run build -w @itharbors/kit-scheduler
```

Expected: both exit 0.

- [ ] **Step 6: Commit Task 4**

```bash
git add kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts
git commit -m '[Feature] 应用后台管理视觉系统'
```

### Task 5: Verification and local walkthrough

**Files:**
- Verify: `kits/scheduler/**`
- Verify: `docs/superpowers/specs/2026-07-31-scheduler-tabler-redesign-design.md`

**Interfaces:**
- Consumes: completed redesign
- Produces: verified Kit artifact and a live user-facing preview

- [ ] **Step 1: Run official verification**

Create an isolated temporary output directory and run the checks:

```bash
SCHEDULER_CHECK_DIR="$(mktemp -d /tmp/harbors-scheduler-tabler.XXXXXX)"
npm run test -w @itharbors/kit-scheduler
npm run kit:check -- scheduler --output-directory "$SCHEDULER_CHECK_DIR"
git diff --check
```

Expected: 43 or more Scheduler tests pass, Kit check exits 0, and no whitespace errors are reported.

- [ ] **Step 2: Inspect repository state**

Run `git status --short`, `git log --oneline -8`, and inspect every remaining diff. Expected: only intended Scheduler files or plan-checkbox updates remain; the worktree is clean after final commits.

- [ ] **Step 3: Walk through the local UI**

Keep the existing 49380 dev stack running or restart it with:

```bash
npm run dev:web -- --kit /Users/bytedance/Project/harbors/.worktrees/kit-scheduler-feature-scheduled-scripts/kits/scheduler
```

In the browser verify desktop and narrow layouts, summary metrics, empty and populated job tables, row/button/input hover, keyboard focus, drawer open/cancel/Escape, dirty-close confirmation, interval preview, validation, delete confirmation, and history disclosure. Confirm there are no browser console errors.

- [ ] **Step 4: Save and show the final screenshot**

Capture the live desktop page with the drawer open, save it under the active Codex visualization directory, leave the Scheduler tab open as a deliverable, and include the image in the final response.
