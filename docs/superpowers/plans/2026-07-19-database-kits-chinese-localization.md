# SQLite 与 MySQL Kit 中文化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SQLite Workbench 与 MySQL Workbench 的全部产品控制界面文案翻译为简体中文，同时保留技术术语、用户数据和数据库原始诊断。

**Architecture:** 每个 Workbench 新增独立的 `copy.ts`，集中保存静态文案和动态文案函数。面板与视图模型从该模块取文案，不引入语言切换或跨插件共享依赖。

**Tech Stack:** TypeScript、原生 DOM、Vitest、Vite 插件构建

## Global Constraints

- SQLite、MySQL、SQL、TLS、NULL、BLOB 等技术术语保持原样。
- 数据库对象名、字段名、字段值、SQL 文本、错误码和数据库驱动原始诊断保持原样。
- HTML 页面语言声明改为 `zh-CN`，所有产品控制的无障碍标签同步中文化。
- 不引入第三方 i18n 依赖，不增加语言切换功能。

---

### Task 1: SQLite Workbench 中文化

**Files:**
- Create: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/copy.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/view-model.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.html`
- Test: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`
- Test: `kits/sqlite/plugins/sqlite-workbench/tests/view-model.test.ts`

**Interfaces:**
- Produces: `sqliteCopy`, a readonly object containing static strings and functions such as `selected(name: string)`, `rowCount(count: number)`, `columnCount(count: number)`, `sqlRows(count: number, elapsedMs: number)`, and `sqlChanges(count: number, elapsedMs: number)`.
- Consumes: Existing panel state only; no new runtime dependency.

- [ ] **Step 1: Write failing Chinese interface tests**

Add a disconnected-state test and Chinese validation assertions:

```ts
it('renders product-controlled interface copy in Chinese', async () => {
  await mount();
  expect(root.textContent).toContain('数据库路径');
  expect(root.textContent).toContain('打开');
  expect(root.textContent).toContain('创建');
  expect(root.textContent).toContain('尚未连接');
  expect(root.textContent).not.toContain('Not connected');

  const path = root.querySelector<HTMLInputElement>('[data-field="database-path"]')!;
  path.value = '/tmp/example.sqlite';
  root.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
  await flush();
  expect(root.textContent).toContain('数据');
  expect(root.textContent).toContain('结构');
  expect(root.textContent).toContain('新增记录');
  expect(root.textContent).toContain('150 条记录');
});
```

Change view-model error assertions to:

```ts
expect(() => editableValueFromInput('integer', '4.2')).toThrow('请输入十进制整数');
expect(() => editableValueFromInput('real', 'Infinity')).toThrow('请输入有限实数');
```

- [ ] **Step 2: Run SQLite tests and verify RED**

Run:

```bash
npx vitest run --config kits/sqlite/vitest.config.ts \
  kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts \
  kits/sqlite/plugins/sqlite-workbench/tests/view-model.test.ts
```

Expected: FAIL because the panel and validation errors still contain English copy.

- [ ] **Step 3: Add the SQLite copy module and replace product-controlled English**

Create a readonly module organized by surface:

```ts
export const sqliteCopy = {
  brand: { aria: 'SQLite 工作台', subtitle: '工作台' },
  connection: {
    path: '数据库路径', open: '打开', create: '创建', refresh: '刷新', close: '关闭',
    disconnected: '尚未连接', enterPath: '请输入本地 SQLite 数据库路径。',
    opened: '数据库已打开', created: '数据库已创建', closed: '数据库已关闭', refreshed: '数据库已刷新',
  },
  tabs: { data: '数据', schema: '结构', sql: 'SQL' },
  actions: {
    add: '新增记录', edit: '编辑', delete: '删除', save: '保存', cancel: '取消',
    execute: '执行 SQL', previous: '上一页', next: '下一页',
  },
  validation: {
    integer: '请输入十进制整数', real: '请输入有限实数',
  },
  selected: (name: string) => `已选择 ${name}`,
  rowCount: (count: number) => `${count.toLocaleString()} 条记录`,
  columnCount: (count: number) => `${count} 个字段`,
  sqlRows: (count: number, elapsedMs: number) => `返回 ${count} 行 · ${elapsedMs} ms`,
  sqlChanges: (count: number, elapsedMs: number) => `影响 ${count} 行 · ${elapsedMs} ms`,
} as const;
```

Import `sqliteCopy` from `index.ts` and `view-model.ts`. Replace every product-controlled English label, status, empty state, confirmation, schema heading, pagination label, dialog label and accessibility label; preserve SQL, schema identifiers, values, flags and native error detail. Set `index.html` to `<html lang="zh-CN">` with `<title>SQLite 工作台</title>`.

- [ ] **Step 4: Run SQLite tests and verify GREEN**

Run:

```bash
npm run test -w @itharbors/kit-sqlite
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench
```

Expected: all SQLite tests pass and the plugin build exits 0.

- [ ] **Step 5: Commit SQLite localization**

```bash
git add kits/sqlite/plugins/sqlite-workbench
git commit -m '[Feature] 中文化 SQLite Kit'
```

---

### Task 2: MySQL Workbench 中文化

**Files:**
- Create: `kits/mysql/plugins/mysql-workbench/panel.workbench/src/copy.ts`
- Modify: `kits/mysql/plugins/mysql-workbench/panel.workbench/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-workbench/panel.workbench/src/view-model.ts`
- Modify: `kits/mysql/plugins/mysql-workbench/panel.workbench/src/index.html`
- Test: `kits/mysql/plugins/mysql-workbench/tests/panel.test.ts`
- Test: `kits/mysql/plugins/mysql-workbench/tests/view-model.test.ts`

**Interfaces:**
- Produces: `mysqlCopy`, a readonly object containing static strings and functions such as `connected(endpoint: string, database: string)`, `selected(name: string)`, `loadedPage(page: number)`, `sqlRows(count: number, elapsed: string)`, and `sqlChanges(count: number, elapsed: string)`.
- Consumes: Existing MySQL panel state only; no new runtime dependency.

- [ ] **Step 1: Write failing Chinese interface tests**

Add a disconnected/connected-state test and Chinese validation assertions:

```ts
it('renders product-controlled interface copy in Chinese', async () => {
  await mount();
  expect(root.textContent).toContain('主机');
  expect(root.textContent).toContain('端口');
  expect(root.textContent).toContain('用户名');
  expect(root.textContent).toContain('密码');
  expect(root.textContent).toContain('连接');
  expect(root.textContent).not.toContain('No object selected');

  fillConnection();
  root.querySelector<HTMLButtonElement>('[data-action="connect"]')!.click();
  await flush();
  expect(root.textContent).toContain('数据库对象');
  expect(root.textContent).toContain('新增记录');
  expect(root.textContent).toContain('150 条记录');
});
```

Change view-model error assertions to exact Chinese messages for integer and JSON validation:

```ts
expect(() => editableValueFromInput('integer', '4.2')).toThrow('请输入十进制整数');
expect(() => editableValueFromInput('json', '{bad')).toThrow('请输入有效的 JSON');
```

- [ ] **Step 2: Run MySQL tests and verify RED**

Run:

```bash
npx vitest run --config kits/mysql/vitest.config.ts \
  kits/mysql/plugins/mysql-workbench/tests/panel.test.ts \
  kits/mysql/plugins/mysql-workbench/tests/view-model.test.ts
```

Expected: FAIL because the panel and validation errors still contain English copy.

- [ ] **Step 3: Add the MySQL copy module and replace product-controlled English**

Create a readonly module organized by surface:

```ts
export const mysqlCopy = {
  brand: { title: 'MySQL 工作台', subtitle: '直连数据库' },
  connection: {
    host: '主机', port: '端口', user: '用户名', password: '密码', database: '数据库',
    connect: '连接', disconnect: '断开连接', refresh: '刷新',
    prompt: '请输入 MySQL 连接信息以开始。', disconnected: '未连接',
    connected: (endpoint: string, database: string) => `已连接到 ${endpoint}/${database}。`,
  },
  objects: { title: '数据库对象', filter: '筛选表和视图', none: '未选择对象', tables: '表', views: '视图' },
  tabs: { data: '数据', schema: '结构', sql: 'SQL' },
  actions: {
    add: '新增记录', edit: '编辑', delete: '删除', save: '保存', cancel: '取消',
    execute: '执行 SQL', previous: '上一页', next: '下一页',
  },
  validation: { integer: '请输入十进制整数', json: '请输入有效的 JSON' },
  selected: (name: string) => `已选择 ${name}。`,
  loadedPage: (page: number) => `已加载第 ${page} 页。`,
  sqlRows: (count: number, elapsed: string) => `返回 ${count} 行 · ${elapsed}`,
  sqlChanges: (count: number, elapsed: string) => `影响 ${count} 行 · ${elapsed}`,
} as const;
```

Import `mysqlCopy` from `index.ts` and `view-model.ts`. Replace every product-controlled English label, status, empty state, capability notice, confirmation, schema heading, pagination label, dialog label and accessibility label; preserve endpoint/database values, SQL, object identifiers, values, flags, MySQL error codes and driver detail. Set `index.html` to `<html lang="zh-CN">` with `<title>MySQL 工作台</title>`.

- [ ] **Step 4: Run MySQL tests and verify GREEN**

Run:

```bash
npm run test -w @itharbors/kit-mysql
node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-workbench
```

Expected: all MySQL tests pass and the plugin build exits 0.

- [ ] **Step 5: Commit MySQL localization**

```bash
git add kits/mysql/plugins/mysql-workbench
git commit -m '[Feature] 中文化 MySQL Kit'
```

---

### Task 3: 双 Kit 回归与页面验收

**Files:**
- Verify only; no planned production file changes.

**Interfaces:**
- Consumes: Localized SQLite and MySQL plugin bundles from Tasks 1 and 2.
- Produces: Verification evidence for tests, builds, source copy scan and rendered pages.

- [ ] **Step 1: Run full Kit regression tests**

```bash
npm run test -w @itharbors/kit-sqlite
npm run test -w @itharbors/kit-mysql
```

Expected: both Vitest suites report all tests passing with zero failures.

- [ ] **Step 2: Rebuild both plugins**

```bash
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench
node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-workbench
```

Expected: both commands exit 0.

- [ ] **Step 3: Scan localized surfaces for stale product copy**

```bash
rg -n "Not connected|Database path|Open the file|Add row|Read-only view|No object selected|direct database access|Filter tables and views|Rows per page|Working" \
  kits/sqlite/plugins/sqlite-workbench/panel.workbench/src \
  kits/mysql/plugins/mysql-workbench/panel.workbench/src
```

Expected: no matches. SQL, protocol identifiers and native diagnostic strings are allowed.

- [ ] **Step 4: Inspect both rendered pages**

Start or reuse the development server with the relevant Kit, open `http://localhost:8080/`, and verify the connection surface, object rail, tabs, empty state, status area and record dialog. Repeat after restarting with the other Kit. Expected: Chinese copy fits without clipping; SQLite/MySQL/SQL/TLS/NULL/BLOB and database content remain unchanged.

- [ ] **Step 5: Verify repository state**

```bash
git diff --check
git status --short --branch
git log -5 --oneline
```

Expected: no whitespace errors, no unintended files, and the design, plan, SQLite and MySQL commits are visible.
