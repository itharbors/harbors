# MySQL Operation Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MySQL kit 的所有远端操作提供即时、可访问、可防重的忙碌反馈，并让连接与断开操作严格二选一。

**Architecture:** 各 iframe 面板维护自己的语义化 activity 状态，在请求发出前渲染并禁用冲突控件；现有 revision/sequence 继续拒绝迟到响应。状态不跨插件持久化，不修改 MySQL 服务协议，失败时保留已有权威快照。

**Tech Stack:** TypeScript、Vitest、JSDOM、原生 DOM/CSS、Harbors plugin message API

## Global Constraints

- 使用现有 `bug/kit-lifecycle` 工作树和 `[Bug]` 中文提交格式。
- 不增加第三方依赖，不改变 MySQL 请求协议或凭据生命周期。
- 所有生产行为必须先有失败测试，并确认失败原因是行为缺失。
- 保留现有深海蓝视觉令牌；活动标记使用 `#76d0ec`。
- 所有忙碌动画支持 `prefers-reduced-motion`。

---

### Task 1: 连接栏状态与二选一操作

**Files:**
- Modify: `kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.connection/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.connection/src/index.css`

**Interfaces:**
- Consumes: `ConnectionSnapshot` 与现有 `requestCore` / `requestExplorer`。
- Produces: `ConnectionActivity = 'hydrate' | 'connect' | 'disconnect' | 'refresh' | null`，以及按钮上的 `.activity-spinner`。

- [ ] **Step 1: 写连接栏失败测试**

增加未决 Promise 测试，断言未连接只存在 `[data-action="connect"]`，已连接只存在 disconnect/refresh；连接中按钮文本为“连接中…”，表单 `aria-busy="true"`，所有字段禁用，重复点击只有一次 connect 请求。分别覆盖断开中和刷新中。

```ts
expect(document.querySelector('[data-action="disconnect"]')).toBeNull();
connectButton.click();
expect(connectButton.textContent).toContain('连接中…');
expect(document.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
expect(request).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm test -w @itharbors/kit-mysql -- connection-panel.test.ts`
Expected: FAIL，原因是当前同时渲染 connect/disconnect，且按钮没有活动文案。

- [ ] **Step 3: 实现语义化连接活动状态**

将 `busy: boolean` 替换为：

```ts
type ConnectionActivity = 'hydrate' | 'connect' | 'disconnect' | 'refresh' | null;
let activity: ConnectionActivity = null;

async function runAction(kind: Exclude<ConnectionActivity, null>, action: (token: ActionToken) => Promise<void>) {
  if (activity !== null) return;
  activity = kind;
  error = null;
  const token: ActionToken = {
    mountGeneration,
    actionSequence: ++actionSequence,
    requestSequence: ++requestSequence,
  };
  activeAction = token;
  render();
  try {
    await action(token);
  } catch (caught) {
    if (isCurrentActionResult(token)) error = panelError(caught);
  } finally {
    if (!isCurrentAction(token)) return;
    activeAction = null;
    activity = null;
    render();
  }
}
```

按 `connection.connected` 只渲染一组合法按钮；字段在 connected 或 activity 非空时加 `disabled`。按钮内部加入 `.activity-spinner` 和动作文案，form 添加 `aria-busy`。

- [ ] **Step 4: 添加活动标记样式并验证 GREEN**

在连接 CSS 中加入 12px 环形 spinner、`@keyframes activity-spin`、按钮内间距和 reduced-motion 静止样式。

Run: `npm test -w @itharbors/kit-mysql -- connection-panel.test.ts`
Expected: PASS。

### Task 2: 数据库对象栏选择防重

**Files:**
- Modify: `kits/mysql/plugins/mysql-explorer/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.css`

**Interfaces:**
- Consumes: `ObjectsSnapshot` 与 `SelectionSnapshot`。
- Produces: `ExplorerActivity = { kind: 'hydrate' | 'database' | 'object'; name?: string } | null`。

- [ ] **Step 1: 写切库与选表失败测试**

使用未决 `selectDatabase` / `selectObject` Promise，断言目标行出现 `.activity-spinner`、对象栏 `aria-busy="true"`、搜索和全部行禁用，连续点击只调用一次 request；拒绝后旧选中项仍为 pressed。

```ts
databaseButton.click();
databaseButton.click();
expect(databaseButton.querySelector('.activity-spinner')).not.toBeNull();
expect(document.querySelector('.object-rail')?.getAttribute('aria-busy')).toBe('true');
expect(request.mock.calls.filter((call) => call[1] === 'selectDatabase')).toHaveLength(1);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm test -w @itharbors/kit-mysql -- panel.test.ts`
Expected: FAIL，原因是当前没有 activity、未禁用行且会产生多次请求。

- [ ] **Step 3: 实现对象栏 activity**

在 `chooseDatabase` / `chooseObject` 请求前设置 activity 并 render；activity 非空时入口直接返回。在权威快照到达、当前请求失败或卸载时清除。渲染目标行 spinner、实时状态文案和 disabled 属性。

- [ ] **Step 4: 添加对象栏忙碌样式并验证 GREEN**

让 spinner 占用原图标位置，避免行文字跳动；禁用行保持可读但不可点击。

Run: `npm test -w @itharbors/kit-mysql -- panel.test.ts`
Expected: PASS。

### Task 3: 数据加载、分页与修改反馈

**Files:**
- Modify: `kits/mysql/plugins/mysql-data/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-data/panel.data/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-data/panel.data/src/index.css`

**Interfaces:**
- Consumes: 现有 rows/schema CRUD 方法。
- Produces: `DataActivity = 'load' | 'page' | 'save' | 'delete' | null` 与 `.data-activity-layer`。

- [ ] **Step 1: 写分页和修改失败测试**

断言翻页请求未决时 view-host `aria-busy="true"`、页大小 select 与行选择禁用、状态为“正在加载下一页…”；保存未决时弹窗字段和取消按钮禁用、保存按钮显示“保存中…”；连续触发不增加请求。

```ts
nextButton.click();
expect(document.querySelector('.view-host')?.getAttribute('aria-busy')).toBe('true');
expect(document.querySelector<HTMLSelectElement>('[data-action="page-size"]')?.disabled).toBe(true);
expect(document.querySelector('[role="status"]')?.textContent).toContain('正在加载下一页');
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm test -w @itharbors/kit-mysql -- plugins/mysql-data/tests/panel.test.ts`
Expected: FAIL，原因是页大小和弹窗控件仍可操作，状态文案只有“处理中…”。

- [ ] **Step 3: 实现数据 activity 与安全分页**

使用语义化 activity 替换 `busy` 展示逻辑；`changePage` 先检查 activity，再在 runAction 内更新目标页。渲染数据活动层，busy 时不绑定行选择，并禁用 page-size、弹窗字段、取消和保存。

```ts
async function changePage(delta: number) {
  if (activity !== null) return;
  const nextPage = Math.max(1, page + delta);
  await runAction('page', async () => {
    page = nextPage;
    await loadRows();
  });
}
```

- [ ] **Step 4: 添加轻量阻挡层并验证 GREEN**

活动层覆盖 `.view-host`，保留表格可见，使用 `pointer-events: auto` 阻止交互；spinner 与文案居中但不遮盖页头。

Run: `npm test -w @itharbors/kit-mysql -- plugins/mysql-data/tests/panel.test.ts`
Expected: PASS。

### Task 4: 关系图与 SQL 的完整操作状态

**Files:**
- Modify: `kits/mysql/plugins/mysql-relationships/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-relationships/panel.relationships/src/index.css`
- Modify: `kits/mysql/plugins/mysql-sql/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-sql/panel.sql/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-sql/panel.sql/src/index.css`
- Modify: `kits/mysql/plugins/mysql-schema/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-schema/panel.schema/src/index.ts`

**Interfaces:**
- Consumes: `getRelationshipGraph`、Explorer `selectObject`、`executeSql`。
- Produces: relationship activity 与 SQL `.activity-spinner`。

- [ ] **Step 1: 写关系图和 SQL 失败测试**

关系图测试断言重试后错误立即消失、加载文案出现、连续重试只有一次请求；打开表未决时图区域 busy。SQL 测试断言执行未决时 textarea disabled、按钮含 spinner、状态为“正在执行 SQL…”，连续点击只有一次请求。结构面板测试断言加载时 view-host `aria-busy="true"`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm test -w @itharbors/kit-mysql -- plugins/mysql-relationships/tests/panel.test.ts plugins/mysql-sql/tests/panel.test.ts plugins/mysql-schema/tests/panel.test.ts`
Expected: FAIL，原因是关系图重试可重复、SQL 编辑器未锁定、结构区没有 aria-busy。

- [ ] **Step 3: 实现关系图 activity 和错误恢复**

`loadGraph` 在请求前检查 activity、清空 error、设置 `{kind:'load'}`；`openTable` 使用 `{kind:'open', name}` 并捕获错误。render 为 host 设置 `aria-busy`，open 期间用 CSS 禁止关系节点交互。

- [ ] **Step 4: 完善 SQL 与结构加载反馈**

SQL 执行期间设置 textarea.disabled，按钮渲染 spinner，状态使用动作文案。结构面板在 `schema === null` 且已连接并选中对象时设置 `aria-busy="true"`。

- [ ] **Step 5: 运行任务测试并确认 GREEN**

Run: `npm test -w @itharbors/kit-mysql -- plugins/mysql-relationships/tests/panel.test.ts plugins/mysql-sql/tests/panel.test.ts plugins/mysql-schema/tests/panel.test.ts`
Expected: PASS。

### Task 5: 整体回归与真实页面验证

**Files:**
- Modify only if verification reveals a covered regression.

**Interfaces:**
- Consumes: Tasks 1–4 的全部面板状态。
- Produces: 可提交、可在现有 PR 中复核的完整变更。

- [ ] **Step 1: 运行 MySQL kit 全量测试**

Run: `npm run test -w @itharbors/kit-mysql`
Expected: 所有非跳过测试通过，0 failures。

- [ ] **Step 2: 构建并检查 MySQL 插件**

Run: `npm run build -w @itharbors/mysql-contracts && node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-explorer && node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-data && node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-relationships && node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-schema && node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-sql && node scripts/ce-plugin.mjs check --all`
Expected: exit 0。

- [ ] **Step 3: 运行整仓检查**

Run: `npm run check`
Expected: exit 0。

- [ ] **Step 4: 单 kit 真实服务器回归**

保持 `npm run dev -- --kit @itharbors/kit-mysql` 运行，在内置浏览器验证：连接/断开按钮二选一；连接、切库、选表、翻页、SQL 执行在请求完成前可见活动反馈；重复点击不产生第二个请求；失败后保留旧状态。

- [ ] **Step 5: 显式暂存、提交并推送**

逐个 `git add` 本计划列出的相关文件，运行 `git diff --cached --check`，提交：

```bash
git commit -m '[Bug] 完善 MySQL 操作反馈'
git push origin bug/kit-lifecycle
```
