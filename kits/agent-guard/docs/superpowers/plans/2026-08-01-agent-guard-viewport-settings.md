# Agent Guard Viewport and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent Guard 改为无页面滚动的三 Tab 单窗口监控台，恢复 Claude/Codex 分行历史摘要，为趋势图增加本地时间横轴，并把策略与缓存管理迁移到设置页。

**Architecture:** 保持采集、存储和 Bridge 协议不变。面板外壳负责三 Tab 与固定视口；新增纯 `history-view-model.ts` 将带来源维度的历史序列转换为 Agent 摘要和时间轴刻度，现有聚合趋势仍保持两条指标线。

**Tech Stack:** TypeScript、原生 DOM/SVG、CSS Grid/Flexbox、Vitest + jsdom、Harbors Kit Web host

## Global Constraints

- 只在现有 `kit-change/agent-guard/feature/traffic-history` worktree 工作，所有提交使用 `[Feature]`。
- `body` 不产生横向或纵向滚动；常规桌面高度不低于 680 px 时总览严格一屏显示。
- 过矮窗口、事件页和设置页只允许活动内容区内部滚动，标题与 Tab 固定。
- 历史摘要固定显示 Claude、Codex 两排；缺失显示“未采集”，实测零显示 `0`。
- 趋势图仍只有两条聚合指标线，缺失保持断点，并显示“时间（本地时区）”及真实时间刻度。
- 总览不得显示回填、缓存占用、清空历史或隐私说明；这些内容与策略统一进入设置 Tab。
- 不修改采集器、历史存储 schema、事件判定、策略协议或 Bridge 消息。
- 不新增第三方图表库；使用 `npm run dev:web` 验收，不启动 Electron。

## File Structure

- Create: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/history-view-model.ts` — Agent 维度摘要与本地时间刻度纯函数。
- Create: `kits/agent-guard/plugins/agent-guard-center/tests/history-view-model.test.ts` — 纯函数的来源聚合、缺失/零值和时间格式测试。
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts` — 三 Tab 外壳、设置页、Agent 摘要和 SVG 横轴渲染。
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css` — 固定视口网格、内部滚动、紧凑总览、设置布局和横轴样式。
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts` — 信息架构、状态保持、Agent 摘要、时间轴和管理操作回归。
- Modify: `kits/agent-guard/tests/panel-accessibility.test.ts` — 固定视口、内部滚动和三 Tab 静态约束。

---

### Task 1: 三 Tab 信息架构与设置迁移

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`

**Interfaces:**
- Consumes: existing `createIncidentLedger`, `createPolicyPanel`, `createHistoryManagement`, `createPrivacyNote`, `HistoryStatus`.
- Produces: `type DashboardTab = 'overview' | 'incidents' | 'settings'`, `createSettingsPanel()`, `.dashboard-content`, `.settings-panel`, `.settings-section`.

- [ ] **Step 1: Write failing tests for three Tab ownership**

Add tests which prove the default overview excludes management/privacy controls, events excludes policy, and settings owns every configurable item:

```ts
expect([...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.dataset.tab)).toEqual([
  'overview', 'incidents', 'settings',
]);
expect(document.querySelector('#overview-panel [data-action="toggle-backfill"]')).toBeNull();
expect(document.querySelector('#overview-panel [data-action="clear-history"]')).toBeNull();

document.querySelector<HTMLButtonElement>('[data-tab="incidents"]')!.click();
expect(document.querySelector('#incidents-panel [data-incident-id="incident-1"]')).not.toBeNull();
expect(document.querySelector('#incidents-panel .policy-panel')).toBeNull();

document.querySelector<HTMLButtonElement>('[data-tab="settings"]')!.click();
expect(document.querySelector('#settings-panel .policy-panel')).not.toBeNull();
expect(document.querySelector('#settings-panel [data-action="toggle-backfill"]')).not.toBeNull();
expect(document.querySelector('#settings-panel [data-action="clear-history"]')).not.toBeNull();
expect(document.querySelector('#settings-panel .privacy-note')).not.toBeNull();
```

Add keyboard assertions for three-item ArrowLeft/ArrowRight wrapping, Home → overview, End → settings. Add a polling regression proving settings Tab, policy draft and focused management control survive refresh.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-center/tests/panel.test.ts
```

Expected: new tests fail because only two Tabs exist and history management/policy/privacy remain in overview/events.

- [ ] **Step 3: Implement the three Tab shell and setting sections**

Extend `DashboardTab` and replace pairwise Arrow logic with ordered navigation:

```ts
const DASHBOARD_TABS: readonly DashboardTab[] = ['overview', 'incidents', 'settings'];

function adjacentTab(current: DashboardTab, direction: -1 | 1): DashboardTab {
  const index = DASHBOARD_TABS.indexOf(current);
  return DASHBOARD_TABS[(index + direction + DASHBOARD_TABS.length) % DASHBOARD_TABS.length];
}
```

Render a stable `.dashboard-content` wrapper after the tabs. Put inline operation errors and exactly one active panel inside it. `createIncidentsPanel` contains only `createIncidentLedger`. Implement `createSettingsPanel` with four labelled `.settings-section` regions:

```ts
panel.append(
  settingsSection('保护策略', createPolicyPanel()),
  settingsSection('历史采集', createBackfillSettings()),
  settingsSection('缓存管理', createCacheSettings()),
  settingsSection('隐私说明', createPrivacyNote()),
);
```

Split existing `createHistoryManagement` so `createBackfillSettings()` owns the toggle, while `createCacheSettings()` displays persistent/memory status, formatted storage bytes, earliest/latest local timestamps, and clear-history confirmation. Keep the same Bridge calls and confirmation payload.

Remove management from `createHistorySection` and privacy from the workspace footer. Reset `activeTab` to overview only on mount/unmount, not on polling or mutations.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-center/tests/panel.test.ts
```

Expected: all panel tests pass, including the existing mutation, focus and stale-history tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git commit -m "[Feature] 集中 Agent Guard 设置与缓存管理"
```

---

### Task 2: Agent 分行摘要与真实时间横轴

**Files:**
- Create: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/history-view-model.ts`
- Create: `kits/agent-guard/plugins/agent-guard-center/tests/history-view-model.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`

**Interfaces:**
- Consumes: `TrafficHistoryResult`, `HistorySeries`, `HistoryPoint`, `AgentId` from `@itharbors/agent-guard-contracts`.
- Produces:

```ts
export type HistoryRange = '1h' | '24h' | '7d' | '30d' | '90d' | '1y';
export interface AgentMetricSummary {
  metric: HistorySeries['metric'];
  unit: HistorySeries['unit'];
  value: number | null;
  coverageRatio: number;
}
export interface AgentHistorySummary {
  agent: AgentId;
  metrics: AgentMetricSummary[];
}
export interface HistoryAxisTick { at: number; label: string; }
export function summarizeHistoryByAgent(result: TrafficHistoryResult): AgentHistorySummary[];
export function createHistoryAxisTicks(from: number, to: number, range: HistoryRange): HistoryAxisTick[];
```

- [ ] **Step 1: Write failing pure-function tests**

Create literal fixtures with multiple provider/hostname series per Agent. Assert values are summed within the same Agent but never across Claude/Codex:

```ts
expect(summarizeHistoryByAgent(result)).toEqual([
  { agent: 'claude', metrics: [
    expect.objectContaining({ metric: 'bytes-in', value: 300, coverageRatio: 1 }),
    expect.objectContaining({ metric: 'bytes-out', value: null, coverageRatio: 0 }),
  ] },
  { agent: 'codex', metrics: [
    expect.objectContaining({ metric: 'bytes-in', value: 0, coverageRatio: 1 }),
    expect.objectContaining({ metric: 'bytes-out', value: 500, coverageRatio: 0.5 }),
  ] },
]);
```

Use fixed timestamps and mock only the timezone with `process.env.TZ = 'Asia/Shanghai'`. Assert five ticks include exact start/end timestamps and labels: `1h` uses `HH:mm`, `24h` first tick uses `MM-DD HH:mm`, `7d/30d` uses `MM-DD`, `90d/1y` uses `YYYY-MM`.

- [ ] **Step 2: Run the new test and verify RED**

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-center/tests/history-view-model.test.ts
```

Expected: FAIL because `history-view-model.ts` does not exist.

- [ ] **Step 3: Implement the pure view model**

Use fixed metric definitions per domain and fixed agent order `['claude', 'codex']`. For each Agent + metric, gather matching series points. `value` is `null` when there are no covered points, otherwise the sum of non-null values, preserving real zero. `coverageRatio` is covered point count divided by total point count across matching series; no series yields 0.

Generate five evenly spaced timestamp ticks including exact `from` and `to`. Format with `Intl.DateTimeFormat` using the runtime local timezone and the exact range-specific fields from the spec; do not derive tick positions from series array lengths.

- [ ] **Step 4: Write failing panel tests for rows and axis DOM**

Assert both Agent rows always exist and carry independent data:

```ts
expect(document.querySelector('[data-history-agent="claude"] [data-metric="bytes-in"]')?.textContent).toContain('300 B');
expect(document.querySelector('[data-history-agent="claude"] [data-metric="bytes-out"]')?.textContent).toContain('未采集');
expect(document.querySelector('[data-history-agent="codex"] [data-metric="bytes-in"]')?.textContent).toContain('0 B');
expect(document.querySelectorAll('.history-axis-tick')).toHaveLength(5);
expect(document.querySelector('.history-axis-title')?.textContent).toBe('时间（本地时区）');
```

Switch to model usage and assert each Agent row contains input/output/cache/requests/sessions while the chart remains exactly two paths.

- [ ] **Step 5: Render Agent rows and SVG time axis**

Replace the aggregate history summary cards with `.agent-history-list` containing two `.agent-history-row` elements. Each row includes Agent identity and the fixed domain metrics from `summarizeHistoryByAgent`.

In `createHistoryChart`, reserve SVG height for the x-axis. Render five `<text class="history-axis-tick">` elements positioned by `(tick.at - result.from) / (result.to - result.from)`, plus a centered `.history-axis-title`. Keep the existing paths and legend. Update the chart accessible label to include the active time range.

- [ ] **Step 6: Run Task 2 tests and commit**

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts plugins/agent-guard-center/tests/history-view-model.test.ts plugins/agent-guard-center/tests/panel.test.ts
git add kits/agent-guard/plugins/agent-guard-center/panel.guard/src/history-view-model.ts kits/agent-guard/plugins/agent-guard-center/tests/history-view-model.test.ts kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git commit -m "[Feature] 展示 Agent Guard 分项历史与时间轴"
```

Expected: both test files pass; the network/model chart still has only two metric paths.

---

### Task 3: 固定视口布局与 Web 验收

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`
- Modify: `kits/agent-guard/tests/panel-accessibility.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts` only if a DOM class contract needs coverage.

**Interfaces:**
- Consumes: `.dashboard-content`, `#overview-panel`, `#incidents-panel`, `#settings-panel`, `.agent-history-row`, `.history-axis-tick`.
- Produces: fixed viewport grid, page-level overflow lock, regular-height overview fit, active-panel internal scrolling.

- [ ] **Step 1: Write failing layout contract tests**

Add static assertions tied to the real DOM classes:

```ts
expect(css).toMatch(/html,\s*body,\s*#guard-root\s*{[^}]*height:\s*100%/su);
expect(css).toMatch(/body\s*{[^}]*overflow:\s*hidden/su);
expect(css).toMatch(/\.guard-workspace\s*{[^}]*height:\s*100dvh[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\)/su);
expect(css).toMatch(/\.dashboard-content\s*{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/su);
expect(css).toMatch(/#incidents-panel[^}]*overflow-y:\s*auto/su);
expect(css).toMatch(/#settings-panel[^}]*overflow-y:\s*auto/su);
expect(css).toMatch(/@media\s*\(max-height:\s*679px\)/u);
```

- [ ] **Step 2: Run accessibility tests and verify RED**

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts tests/panel-accessibility.test.ts
```

Expected: FAIL because current layout uses `min-height: 100vh` and allows body vertical overflow.

- [ ] **Step 3: Implement the viewport grid and compact overview**

Set `html, body, #guard-root { width: 100%; height: 100%; }`, `body { overflow: hidden; }`, and:

```css
.guard-workspace {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.dashboard-content { min-width: 0; min-height: 0; overflow: hidden; }
#overview-panel { height: 100%; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
#incidents-panel, #settings-panel { height: 100%; min-height: 0; overflow-y: auto; }
```

Reduce header, section and route padding so two route rows plus history fit at 680 px. Make `.history-deck` a grid whose chart row is `minmax(110px, 1fr)`; set SVG to fill available height rather than enforce 180 px. Agent summary rows remain horizontal on desktop and wrap below 980 px. Under `@media (max-height: 679px)` make `.dashboard-content` internally scrollable and allow overview intrinsic height; never restore body scrolling.

- [ ] **Step 4: Run focused and full verification**

```bash
npx vitest run --root kits/agent-guard --config vitest.config.ts tests/panel-accessibility.test.ts plugins/agent-guard-center/tests/history-view-model.test.ts plugins/agent-guard-center/tests/panel.test.ts
npm run test:agent-guard
git diff --check
```

Expected: focused tests and all Agent Guard tests pass with clean output.

- [ ] **Step 5: Run official Kit validation**

```bash
CHECK_DIR="$(mktemp -d /tmp/agent-guard-viewport-check.XXXXXX)"
npm run kit:check -- agent-guard --output-directory "$CHECK_DIR"
```

Expected: exit 0 with artifact SHA256.

- [ ] **Step 6: Validate the Web host**

Reuse `npm run dev:web`; do not launch Electron. At a regular desktop viewport at least 680 px high, verify:

- `document.documentElement.scrollHeight === window.innerHeight` and scroll width equals viewport width.
- overview shows route then history, Claude/Codex summary rows, five local-time ticks and no management footer.
- events contains no policy; settings contains policy, backfill, cache dates/size, clear action and privacy copy.
- event/settings overflow occurs inside the active panel only.
- network/model switches preserve two chart paths and show the correct per-Agent metrics.
- browser console contains no application errors.

- [ ] **Step 7: Commit Task 3**

```bash
git add kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css kits/agent-guard/tests/panel-accessibility.test.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git commit -m "[Feature] 固定 Agent Guard 单窗口布局"
```

- [ ] **Step 8: Confirm clean branch state**

```bash
git status --short
git log -6 --oneline
```

Expected: status is empty and all three implementation commits use `[Feature]`.
