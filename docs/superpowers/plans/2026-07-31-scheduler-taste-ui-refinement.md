# Scheduler Taste UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Scheduler Panel 优化为克制、高密度的开发者工具后台，并补齐统计带、空状态、加载骨架屏、表单分组和交互状态。

**Architecture:** 保留现有 Panel 的单文件 DOM 构建方式和 Scheduler Service 协议，只在 `createSummary`、`createJobsSection`、`createJobForm` 和 `renderLoading` 周边做局部语义调整。视觉优化集中在 Panel CSS，不引入依赖、不改数据流、不拆分现有大文件。

**Tech Stack:** TypeScript DOM API、CSS、Vitest、JSDOM、Harbors Panel runtime、in-app browser 视觉验收。

## Global Constraints

- 保留现有信息架构、文案、表单字段名、字段顺序、默认值、校验规则和消息协议。
- 使用 `DESIGN_VARIANCE 4`、`MOTION_INTENSITY 3`、`VISUAL_DENSITY 7`。
- 页面锁定浅色工具主题，单一蓝色作为交互强调，绿、黄、红仅表达真实状态。
- 容器圆角 `10px`，表单控件和按钮圆角 `6px`，状态标记才使用全圆角。
- 不新增第三方包，不手写 SVG，不使用 emoji，不改变 Scheduler Service。
- hover 不位移表格行，自动动画只用于层级、反馈和真实运行状态，并尊重 `prefers-reduced-motion`。
- 当前分支为 `kit-change/scheduler/feature/scheduled-scripts-admin`，所有新提交继续使用 `[Feature]` 标签。

---

### Task 1: 统计带和空状态行为

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`

**Interfaces:**
- Consumes: `openForm(jobId, returnFocusTarget)` 和现有 `createMetricCard` 数据输入。
- Produces: `.summary-strip`、`.summary-stat`、`[data-action="empty-new-job"]` 和与页头相同的新建抽屉行为。

- [ ] **Step 1: Write the failing summary and empty-state tests**

在现有“renders the admin summary”测试中增加单表面断言，并新增空状态操作测试：

```ts
expect(document.querySelector('.summary-strip')).not.toBeNull();
expect(document.querySelectorAll('.summary-strip .summary-stat')).toHaveLength(4);

it('opens the same creation drawer from the plans empty state', async () => {
  const request = vi.fn(async () => ({
    now: snapshot.now,
    serviceError: null,
    activeJobIds: [],
    jobs: [],
    runs: [],
  }));
  await panel.mount({ message: { request } });

  click('[data-action="empty-new-job"]');

  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('#job-form-title')?.textContent).toBe('新建计划');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -w @itharbors/kit-scheduler -- --run plugins/scheduler-panel/tests/panel.test.ts
```

Expected: FAIL because `.summary-strip`, `.summary-stat`, and `empty-new-job` do not exist.

- [ ] **Step 3: Implement the compact summary and empty action**

将 `createSummary()` 容器类改为 `summary-strip`，将单项类改为 `summary-stat summary-<tone>`，保留 `data-testid="metric-card"` 作为测试和数据语义契约。在计划空单元格中追加：

```ts
const emptyAction = createButton('新建计划', 'empty-new-job', () => {
  openForm(null, { action: 'new-job' });
}, 'button-quiet button-inline-primary');
emptyCell.append(emptyTitle, emptyDetail, emptyAction);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 focused command again. Expected: all Panel tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts
git commit -m '[Feature] 优化调度概览与空状态'
```

### Task 2: 加载骨架屏和抽屉分组

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`

**Interfaces:**
- Consumes: `definition.mount()` 中现有 `renderLoading()` 时机和 `createJobForm()` 的现有控件节点。
- Produces: `.loading-shell`、`.loading-summary`、`.loading-table`、三个 `.form-group` 和稳定的 `aria-labelledby` 分组。

- [ ] **Step 1: Write the failing loading and form-group tests**

```ts
it('shows a layout-shaped loading skeleton until the first snapshot resolves', async () => {
  let resolveSnapshot: ((value: typeof snapshot) => void) | undefined;
  const pending = new Promise<typeof snapshot>((resolve) => { resolveSnapshot = resolve; });
  const request = vi.fn(async () => pending);

  const mounting = panel.mount({ message: { request } });
  expect(document.querySelector('.loading-shell')).not.toBeNull();
  expect(document.querySelectorAll('.loading-summary__item')).toHaveLength(4);
  expect(document.querySelectorAll('.loading-table')).toHaveLength(2);

  resolveSnapshot?.(structuredClone(snapshot));
  await mounting;
});
```

在抽屉可访问性测试中增加：

```ts
expect([...document.querySelectorAll('.form-group > h3')].map((node) => node.textContent))
  .toEqual(['基础信息', '时间安排', '错过触发']);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the Panel focused test. Expected: FAIL because the loading skeleton and form groups do not exist.

- [ ] **Step 3: Implement the loading skeleton**

令 `renderLoading()` 构建与最终页面相同的外壳：

```ts
const loading = document.createElement('main');
loading.className = 'scheduler-workspace loading-shell';
loading.setAttribute('aria-label', '正在读取调度时刻表');
loading.setAttribute('aria-busy', 'true');
// append header lines, four summary skeleton items, and two table skeleton regions
root.replaceChildren(loading);
```

骨架元素使用 `aria-hidden="true"`，同时保留一个 `.sr-only[role="status"]` 文案“正在读取调度时刻表”。

- [ ] **Step 4: Group the existing form nodes without changing order**

新增小工具函数：

```ts
function createFormGroup(id: string, title: string, ...children: HTMLElement[]) {
  const group = document.createElement('section');
  group.className = 'form-group';
  group.setAttribute('aria-labelledby', id);
  const heading = document.createElement('h3');
  heading.id = id;
  heading.textContent = title;
  group.append(heading, ...children);
  return group;
}
```

按原顺序组装基础信息 `name.field, script.field`，时间安排 `scheduleField, once.field, intervalGroup, preview`，错过触发 `policyField`。

- [ ] **Step 5: Remove emoji from script entries**

将文件按钮文案从 emoji 前缀改为纯文件名，保留 `data-entry-kind` 供 CSS 显示 `DIR` 或 `JS` 类型标记：

```ts
const button = createButton(entry.name, 'browse-script-entry', handler, 'script-browser__entry');
button.dataset.entryKind = entry.kind;
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the Panel focused test. Expected: all tests PASS with no unhandled rejection or warning.

- [ ] **Step 7: Commit Task 2**

```bash
git add -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts
git commit -m '[Feature] 完善调度界面加载与编辑层级'
```

### Task 3: 视觉令牌和完整交互状态

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css`
- Test: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `.summary-strip/.summary-stat/.button-inline-primary` 和 Task 2 的 `.loading-* / .form-group / [data-entry-kind]`。
- Produces: 统一 CSS 令牌、桌面与小屏布局、hover/active/focus/disabled/reduced-motion 状态。

- [ ] **Step 1: Recalibrate the root tokens and geometry**

使用冷灰画布 `#f4f6f8`、主文字 `#17202b`、次文字 `#5e6b7a`、边界 `#dde2e8`、强调蓝 `#1769aa`。容器圆角统一为 `10px`，按钮和表单控件为 `6px`，主容器去除投影。将 `.scheduler-workspace` 的 `min-height` 改为 `100dvh`。

- [ ] **Step 2: Style the summary strip and tables**

使用一个 `.summary-strip` 网格表面承载四个数据，单项之间仅有单侧分隔线。中性零值不显示彩色边条，`.summary-warning .metric-value` 和 `.summary-danger .metric-value` 只在相应语义下使用状态色。表格标题区、表头、行高和空状态按设计说明收紧。

- [ ] **Step 3: Style action hierarchy and hover/focus cycles**

页头按钮保持实心蓝；`.button-inline-primary` 和行内“立即运行”使用浅蓝表面；安静按钮使用中性边界；删除默认为中性文字，hover/focus 才进入红色风险状态。所有按钮 active 保留 `translateY(1px)`，focus-visible 使用一致的蓝色环。

- [ ] **Step 4: Style the loading shell, form groups, and script browser**

骨架屏形状对应页头、统计带和两个表格。只在 `prefers-reduced-motion: no-preference` 中添加低对比度 shimmer。表单分组使用间距和单个分隔线，不添加额外卡片。脚本条目的 `::before` 根据 `data-entry-kind` 显示 `DIR` 或 `JS`。

- [ ] **Step 5: Preserve responsive and reduced-motion behavior**

将 `900px` 以下统计带变为两列并修正分隔线，`620px` 以下变为紧凑两列。保留 `760px` 表格转卡片和全宽抽屉逻辑。`prefers-reduced-motion: reduce` 继续关闭所有动画与过渡。

- [ ] **Step 6: Build and run focused tests**

```bash
npm run build -w @itharbors/kit-scheduler
npm run test -w @itharbors/kit-scheduler -- --run plugins/scheduler-panel/tests/panel.test.ts
git diff --check
```

Expected: build succeeds, all Panel tests pass, and whitespace check is clean.

- [ ] **Step 7: Perform browser visual verification**

启动隔离开发端口，打开 Scheduler，检查：

1. `1280x720` 下页头、统计带、空计划和运行记录。
2. 新建抽屉的三个分组、固定操作栏和脚本目录浏览器。
3. 主按钮、安静按钮、表格行和脚本条目的 hover、active 和 focus-visible。
4. `760px` 和 `620px` 以下的单列转换，确认没有水平溢出。
5. reduced motion 媒体查询存在且骨架 shimmer、抽屉和脉冲均可停止。

- [ ] **Step 8: Commit Task 3**

```bash
git add -- kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css
git commit -m '[Feature] 统一调度后台视觉与交互反馈'
```

### Task 4: 完整回归与现有 PR 更新

**Files:**
- Modify: `/tmp/harbors-scheduler-pr-body.md`
- Verify only: all files changed since `origin/main`

**Interfaces:**
- Consumes: Tasks 1-3 的已提交 Panel 实现。
- Produces: 清洁的当前分支、通过的 Scheduler Kit 制品检查和已更新的 PR #34。

- [ ] **Step 1: Run the complete Scheduler regression**

```bash
npm run test -w @itharbors/kit-scheduler
```

Expected: all Scheduler tests PASS.

- [ ] **Step 2: Run the targeted Kit artifact check**

```bash
artifact_dir="$(mktemp -d /tmp/harbors-scheduler-check.XXXXXX)"
npm run kit:check -- scheduler --output-directory "$artifact_dir"
```

Expected: build, tests, pack, inspect, checksum, manifest permissions, and artifact output all succeed.

- [ ] **Step 3: Inspect final history and workspace**

```bash
git status --short
git diff --check origin/main...HEAD
git log --format='%h %s' origin/main..HEAD
```

Expected: clean worktree; all commits use `[Feature]`; no whitespace error.

- [ ] **Step 4: Push and verify the existing PR**

```bash
git push origin kit-change/scheduler/feature/scheduled-scripts-admin
gh pr view 34 --json number,title,url,state,isDraft,baseRefName,headRefName,statusCheckRollup
```

Expected: PR #34 remains OPEN, non-draft, targets `main`, and points at the updated head branch.
