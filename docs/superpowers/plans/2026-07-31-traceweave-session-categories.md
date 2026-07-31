# TraceWeave Session Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TraceWeave 只列出 Codex 顶层会话，并把它们按 Active 与 Archived 分组。

**Architecture:** Core 发现器在读取首条 `session_meta` 时识别 rollout 来源，排除 `exec` 和 `source.subagent`，但保留缺少来源的历史格式。Panel 的 RunRail 只消费现有 `RunSummary.archived`，在视图层分组并管理归档折叠状态，不扩大消息协议。

**Tech Stack:** TypeScript、React 19、Vitest、Harbors message bridge

## Global Constraints

- 不读取 Codex Home 以外的文件，不修改任何 Codex rollout。
- 子 Agent 继续作为父会话中的执行证据，不作为顶层会话。
- Active 默认展开，Archived 默认折叠。
- 保持键盘可操作、`aria-expanded` 与 reduced-motion 行为。
- 不新增运行时依赖。

---

### Task 1: 修正顶层会话发现边界

**Files:**
- Modify: `kits/traceweave/plugins/traceweave-core/tests/helpers/codex-home.ts`
- Modify: `kits/traceweave/plugins/traceweave-core/tests/discovery.test.ts`
- Modify: `kits/traceweave/plugins/traceweave-core/main/src/codex-discovery.ts`

**Interfaces:**
- Consumes: `session_meta.payload.source`, `session_meta.payload.id`, `session_meta.payload.session_id`
- Produces: `discoverCodexRuns(codexHome): Promise<DiscoveredRun[]>`，只包含顶层会话

- [ ] **Step 1: 写失败测试**

在 discovery fixture 中增加一个 `source: "exec"` rollout 和一个 `source.subagent.thread_spawn` rollout，并断言二者不出现在结果中；另断言同时包含 `id: "child-id"` 与 `session_id: "parent-id"` 的记录使用 `id`。

- [ ] **Step 2: 验证测试因当前平铺行为失败**

Run: `npm exec vitest run -- --config kits/traceweave/vitest.config.ts kits/traceweave/plugins/traceweave-core/tests/discovery.test.ts`

Expected: FAIL，结果仍包含 `exec` 或 `subagent` rollout。

- [ ] **Step 3: 实现最小过滤**

在发现器中加入纯函数：

```ts
function isTopLevelRun(payload: Record<string, unknown>): boolean {
  if (payload.source === 'exec') return false;
  if (payload.source !== null && typeof payload.source === 'object' && !Array.isArray(payload.source)) {
    return !('subagent' in payload.source);
  }
  return true;
}
```

先过滤非顶层 rollout，再创建 `DiscoveredRun`；会话 ID 按 `payload.id`、`payload.session_id`、文件名的顺序解析。

- [ ] **Step 4: 验证聚焦测试通过**

Run: `npm exec vitest run -- --config kits/traceweave/vitest.config.ts kits/traceweave/plugins/traceweave-core/tests/discovery.test.ts`

Expected: PASS。

### Task 2: 将 RunRail 分成 Active 与 Archived

**Files:**
- Create: `kits/traceweave/plugins/traceweave-view/tests/run-rail.test.tsx`
- Modify: `kits/traceweave/plugins/traceweave-view/panel.trace/src/run-rail.tsx`
- Modify: `kits/traceweave/plugins/traceweave-view/panel.trace/src/index.css`

**Interfaces:**
- Consumes: `RunSummary[]` 与 `RunSummary.archived`
- Produces: `RunRail`，包含 Active 与 Archived 两个可识别分组

- [ ] **Step 1: 写失败的分组交互测试**

渲染两个 active 和一个 archived fixture，断言：

```ts
expect(screen.getByRole('button', { name: 'Active sessions, 2' })).toHaveAttribute('aria-expanded', 'true');
expect(screen.getByRole('button', { name: 'Archived sessions, 1' })).toHaveAttribute('aria-expanded', 'false');
expect(screen.queryByText('Archived task')).toBeNull();
```

点击 Archived 后断言归档任务出现并可触发 `onSelect`。

- [ ] **Step 2: 验证测试因缺少分组失败**

Run: `npm exec vitest run -- --config kits/traceweave/vitest.config.ts kits/traceweave/plugins/traceweave-view/tests/run-rail.test.tsx`

Expected: FAIL，找不到 Active/Archived 分组按钮。

- [ ] **Step 3: 实现分组与折叠状态**

RunRail 用 `useState` 管理两个分组；Active 初始展开，Archived 初始折叠。若 `selectedId` 属于归档会话，归档分组自动展开。分组按钮使用 `aria-controls`、`aria-expanded` 和可见数量。

- [ ] **Step 4: 增加与现有观测台一致的分组样式**

分组标题采用 30px 高度、等宽 9px 标签、细分隔线；展开箭头只在允许动画时旋转。会话行样式保持不变。

- [ ] **Step 5: 验证 UI 聚焦测试通过**

Run: `npm exec vitest run -- --config kits/traceweave/vitest.config.ts kits/traceweave/plugins/traceweave-view/tests/run-rail.test.tsx kits/traceweave/plugins/traceweave-view/tests/panel.test.tsx kits/traceweave/plugins/traceweave-view/tests/accessibility.test.tsx`

Expected: PASS。

### Task 3: 真实数据与 Kit 门禁

**Files:**
- Modify: `kits/traceweave/scripts/verify-real-session.ts`
- Modify: `kits/traceweave/README.md`

**Interfaces:**
- Consumes: 过滤后的 `discoverCodexRuns`
- Produces: 仅聚合的 `sessions=<n> active=<n> archived=<n>` 验证输出

- [ ] **Step 1: 更新验证测试，要求分类聚合且总数相等**

Run: `npm exec vitest run -- --config kits/traceweave/vitest.config.ts kits/traceweave/tests/verify-real-session.test.ts`

Expected: 首次 FAIL，因为输出尚无 active/archived 聚合。

- [ ] **Step 2: 更新真实验证与 README**

验证器计算 `active` 与 `archived`，断言 `active + archived === runs.length`；README 说明左侧只展示顶层会话，归档默认折叠。

- [ ] **Step 3: 运行完整聚焦验证**

Run: `npm run test -w @itharbors/kit-traceweave`

Run: `npm run verify:real -w @itharbors/kit-traceweave`

Run: `npm run kit:check -- traceweave --output-directory "$(mktemp -d)"`

Expected: 全部 PASS，真实输出中顶层会话数量显著小于原始 rollout 数量，且 `source_unchanged=true`。

- [ ] **Step 4: UI 验收**

在当前 Harbors Electron 窗口刷新 TraceWeave，确认 Active 默认可见、Archived 默认折叠、目标会话仍可从对应分组选择，控制台无错误。

- [ ] **Step 5: 提交**

仅暂存本计划列出的实现、测试和文档文件，提交信息使用：

```text
[Bug] 修正 TraceWeave 会话分类与数量
```
