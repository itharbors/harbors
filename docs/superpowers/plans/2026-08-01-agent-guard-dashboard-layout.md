# Agent Guard Dashboard Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent Guard 重排为稳定的“流量概览 / 事件预警”双 Tab 界面，并把全部智能体历史合并为按指标展示的两条趋势线。

**Architecture:** 保持现有 Kit 协议与轮询服务不变，在 panel 内增加持久 UI 状态和纯函数历史视图模型。页面外壳根据活动 Tab 组合现有路由、历史、事件和策略组件；每次数据刷新前后捕获并恢复焦点、滚动和表单草稿，防止当前整页替换行为破坏交互。

**Tech Stack:** TypeScript、原生 DOM/SVG、CSS Grid/Flexbox、Vitest + jsdom、Harbors Kit Web host

## Global Constraints

- 只在现有 `kit-change/agent-guard/feature/traffic-history` worktree 工作，提交标题保持 `[Feature]`。
- 不修改采集器、阈值算法、事件判定规则或 Kit 消息协议。
- 不新增第三方图表库。
- 使用 `npm run dev:web` 和浏览器完成验收，不启动 Electron。
- 页面在 320 px 至宿主全宽不产生页面级横向滚动，并至少填满可用视口。
- 缺失历史桶保持 `null` 和折线断点，不转换为零。

## File Structure

- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts` — Tab 状态、渲染外壳、历史视图模型、焦点/滚动/草稿恢复。
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css` — 全窗口布局、Tab、模型两排摘要、图例和响应式规则。
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts` — Tab 交互、轮询稳定性、合并趋势、摘要和控件回归测试。
- Modify: `kits/agent-guard/tests/panel-accessibility.test.ts` — 全窗口、无横向溢出、Tab 焦点和 reduced-motion 静态约束。

---

### Task 1: 稳定的双 Tab 页面外壳

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts:18-155, 380-500`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts:1-180`

**Interfaces:**
- Consumes: `AgentGuardSnapshot`, existing `createTrafficSection`, `createHistorySection`, `createIncidentLedger`, `createPolicyPanel`.
- Produces: `type DashboardTab = 'overview' | 'incidents'`, `createDashboardTabs(snapshot)`, `activateDashboardTab(tab, focusTab)`, and stable UI state used by later tasks.

- [ ] **Step 1: Write failing tests for information architecture and Tab behavior**

Add tests which assert the default overview contains routes/history but not incidents/policy, switching shows incidents/policy, and ARIA wiring is complete:

```ts
const overview = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="overview"]')!;
const incidents = document.querySelector<HTMLButtonElement>('[role="tab"][data-tab="incidents"]')!;
expect(overview.getAttribute('aria-selected')).toBe('true');
expect(document.querySelector('#overview-panel')).not.toBeNull();
expect(document.querySelector('[data-incident-id]')).toBeNull();
expect(incidents.textContent).toContain('1');
incidents.click();
expect(incidents.getAttribute('aria-selected')).toBe('true');
expect(document.querySelector('#incidents-panel [data-incident-id="incident-1"]')).not.toBeNull();
expect(document.querySelector('#incidents-panel .policy-panel')).not.toBeNull();
```

Add ArrowLeft/ArrowRight/Home/End keyboard assertions and a polling regression that focuses a Tab, changes a policy input, scrolls the document, advances the 2-second timer, and verifies active Tab, focus, draft value, and scroll position survive.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run --config kits/agent-guard/vitest.config.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
```

Expected: FAIL because no `[role="tab"]` elements exist and event content remains on the overview page.

- [ ] **Step 3: Implement persistent Tab and interaction state**

Add module state and reset it only on mount/unmount boundaries:

```ts
type DashboardTab = 'overview' | 'incidents';
let activeTab: DashboardTab = 'overview';
let policyDraft: { warning: string; trip: string } | null = null;

type RenderState = {
  focusAction: string | null;
  selection: [number, number] | null;
  scrollX: number;
  scrollY: number;
};
```

Create a `role="tablist"` with two buttons and matching `role="tabpanel"` containers. `activateDashboardTab` updates `activeTab`, rerenders the latest snapshot, and focuses the selected Tab only for direct keyboard/click navigation. Keyboard behavior follows ARIA Tabs: Left/Right wrap, Home selects overview, End selects incidents, Enter/Space activates.

Before `root.replaceChildren`, capture `document.activeElement` by `data-action`, input selection and `window.scrollX/Y`; capture `warning-outbound` and `trip-outbound` values into `policyDraft`. After replacement, restore the same control, selection and scroll using `window.scrollTo`. Do not restore focus when the prior element is outside the panel.

Refactor `renderSnapshot` to append:

```ts
workspace.append(createHeader(snapshot), createDashboardTabs(snapshot));
const panel = activeTab === 'overview'
  ? createOverviewPanel(snapshot)
  : createIncidentsPanel(snapshot);
workspace.append(panel, createPrivacyNote(), createLiveStatus(snapshot));
```

Keep event commands and policy submission unchanged. Read the initial number inputs from `policyDraft` when present, otherwise from `DEFAULT_POLICY`.

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```bash
npx vitest run --config kits/agent-guard/vitest.config.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
```

Expected: all panel tests PASS, including keyboard and polling-state regressions.

- [ ] **Step 5: Commit Task 1**

```bash
git add kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git commit -m "[Feature] 重排 Agent Guard 双页签结构"
```

---

### Task 2: 合并历史趋势并重排模型摘要

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts:30-330, 590-640`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts:180-290`

**Interfaces:**
- Consumes: `TrafficHistoryResult`, `HistorySeries`, `HistoryPoint`, fixed query agents `['claude', 'codex']`.
- Produces: `type DisplayHistorySeries = Pick<HistorySeries, 'metric' | 'unit' | 'points'>`, `mergeHistorySeriesByMetric(result): DisplayHistorySeries[]`, `visibleHistoryMetrics(domain)`, chart legend, and model summary layout hooks.

- [ ] **Step 1: Write failing tests for merged two-line charts**

Extend fixtures with Claude and Codex series sharing the same time buckets. Assert agent controls are absent, query always includes both agents, and metric series combine across sources:

```ts
expect(document.querySelector('[data-action="history-agent-claude"]')).toBeNull();
expect(document.querySelector('[data-action="history-agent-codex"]')).toBeNull();
expect(document.querySelectorAll('.history-chart path')).toHaveLength(2);
expect(document.querySelector('[data-metric="bytes-in"]')?.getAttribute('data-values')).toBe('3072,null');
expect(document.querySelector('[data-metric="bytes-out"]')?.getAttribute('data-values')).toBe('1536,0');
```

Add a model-domain fixture containing five summary metrics and multiple agents. Assert the chart renders only `input-tokens` and `output-tokens`, while the summary renders input/output/cache on row one and requests/sessions on row two through `data-summary-row="primary|secondary"`.

- [ ] **Step 2: Run focused tests and verify failure**

Run the same panel test command. Expected: FAIL because agent filter buttons exist, per-agent series produce more than two paths, and model summary has no row semantics.

- [ ] **Step 3: Implement the pure history view model**

Remove `historyAgents` mutation and agent filter rendering. Continue requesting `agents: ['claude', 'codex']` for contract compatibility.

Implement metric-level merging without changing stored source series:

```ts
type DisplayHistorySeries = Pick<HistorySeries, 'metric' | 'unit' | 'points'>;

function mergeHistorySeriesByMetric(result: TrafficHistoryResult): DisplayHistorySeries[] {
  return visibleHistoryMetrics(result.domain).flatMap((metric) => {
    const inputs = result.series.filter((series) => series.metric === metric);
    if (inputs.length === 0) return [];
    const buckets = new Map<string, HistoryPoint[]>();
    for (const series of inputs) for (const point of series.points) {
      const key = `${point.start}\u0000${point.end}`;
      buckets.set(key, [...(buckets.get(key) ?? []), point]);
    }
    return [{ metric: inputs[0].metric, unit: inputs[0].unit, points:
      [...buckets.values()]
        .sort((left, right) => left[0].start - right[0].start)
        .map((points) => mergeHistoryPoints(points)) }];
  });
}
```

Import `HistoryPoint` and `HistorySeries` from `@itharbors/agent-guard-contracts`. `mergeHistoryPoints(points: HistoryPoint[]): HistoryPoint` returns `value: null` only when every source point is missing; otherwise it sums non-null values. Coverage is `complete` only when every participating point is complete, `missing` when all are missing, otherwise `partial`. Provenance/quality remain present only for non-missing values. Display series intentionally omit `agent/provider/hostname`, so the view model cannot masquerade as an individual source.

Use the merged series for SVG paths and a visible legend. Add `data-values` containing comma-separated values solely as a deterministic DOM test hook. Summary values continue to use the service-provided cross-source `result.summary`; group cards by metric:

```ts
const primary = ['input-tokens', 'output-tokens', 'cache-tokens'];
const secondary = ['requests', 'sessions'];
```

For network, render the two existing summary cards in one row. For model usage, render two `.history-summary-row` containers with the specified metrics and coverage labels.

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```bash
npx vitest run --config kits/agent-guard/vitest.config.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
```

Expected: all panel tests PASS and each chart domain renders at most two metric lines.

- [ ] **Step 5: Commit Task 2**

```bash
git add kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git commit -m "[Feature] 合并 Agent Guard 历史趋势"
```

---

### Task 3: 全窗口布局、响应式和完整验收

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css:1-150`
- Modify: `kits/agent-guard/tests/panel-accessibility.test.ts:1-40`
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`

**Interfaces:**
- Consumes: Task 1 `.dashboard-tabs`, `.dashboard-panel`; Task 2 `.history-summary-row`, `.history-legend`.
- Produces: 100% host sizing, responsive layout at 980 px and 640 px, visible focus and reduced-motion behavior.

- [ ] **Step 1: Write failing static accessibility/layout tests**

Add assertions for host sizing, overflow containment and Tab focus styling:

```ts
expect(css).toMatch(/html,\s*body,\s*#guard-root\s*{[^}]*min-height:\s*100%/su);
expect(css).toMatch(/body\s*{[^}]*overflow-x:\s*hidden/su);
expect(css).toMatch(/\.dashboard-tab\[aria-selected="true"\]/u);
expect(css).toMatch(/\.dashboard-tab:focus-visible/u);
expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/u);
```

Add a panel assertion that the visible Tab panel has no `hidden` attribute and the inactive panel is not inserted into the DOM, preventing duplicate focus targets.

- [ ] **Step 2: Run accessibility and panel tests and verify failure**

Run:

```bash
npx vitest run --config kits/agent-guard/vitest.config.ts kits/agent-guard/tests/panel-accessibility.test.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
```

Expected: FAIL because full-height root, Tab, legend and summary-row CSS do not yet exist.

- [ ] **Step 3: Implement deliberate responsive styles**

Set `html`, `body`, and `#guard-root` to `width: 100%; min-height: 100%`; set `body { min-height: 100vh; overflow-x: hidden; }` and `.guard-workspace { width: 100%; min-height: 100vh; }`.

Style `.dashboard-tabs` as a restrained border-bottom navigation beneath the header. The active Tab uses the existing cyan signal color and a 2 px bottom indicator; the event badge uses copper only when the count is nonzero. Keep square corners and the existing deep-harbor palette.

Give overview sections a single vertical flow. Keep the incident page `.lower-deck` two-column at wide widths and one-column below 980 px. Render `.history-summary-row[data-summary-row="primary"]` as three equal columns and secondary as two; below 640 px both become one column. Ensure long hostnames, metric labels and controls wrap without increasing the page width.

Add a chart legend using cyan solid and copper dashed swatches. Preserve `prefers-reduced-motion` and visible keyboard focus.

- [ ] **Step 4: Run focused and full Kit tests**

Run:

```bash
npx vitest run --config kits/agent-guard/vitest.config.ts kits/agent-guard/tests/panel-accessibility.test.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
npm run test:agent-guard
```

Expected: focused tests PASS; full Agent Guard suite PASS.

- [ ] **Step 5: Validate in the Web host at desktop and narrow widths**

Reuse or start the Web server with:

```bash
npm run dev:web
```

Open the Agent Guard Kit URL and verify at approximately 1440 px, 768 px and 320 px widths: overview order, no horizontal scroll, both Tab directions and keyboard behavior, two network lines, two model lines, five model summary cards, event actions, policy draft preservation, and automatic 2-second/30-second refresh. Confirm the browser console has no application errors. Do not launch Electron.

- [ ] **Step 6: Run official Kit validation**

Run:

```bash
CHECK_DIR="$(mktemp -d /tmp/agent-guard-layout-check.XXXXXX)"
npm run kit:check -- agent-guard --output-directory "$CHECK_DIR"
```

Expected: command exits 0 and prints a built artifact with SHA256.

- [ ] **Step 7: Review diff and commit Task 3**

```bash
git diff --check
git status --short
git diff -- kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css kits/agent-guard/tests/panel-accessibility.test.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git add kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css kits/agent-guard/tests/panel-accessibility.test.ts kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts
git commit -m "[Feature] 优化 Agent Guard 全窗口布局"
```

- [ ] **Step 8: Final clean-worktree verification**

```bash
git status --short
git log -4 --oneline
```

Expected: status is empty and the three implementation commits plus the plan commit are visible.
