# Database Kit Product Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 SQLite 首次文件浏览起点和结构空状态，并为 MySQL 连接必填参数提供即时中文校验。

**Architecture:** SQLite 默认目录由拥有 Node 能力的 core service 提供，Panel 只负责选择最近目录或请求默认目录；结构提示继续保留在独立 Schema Panel。MySQL 校验保留在 connection Panel 作为即时反馈，core 仍是最终输入校验边界。

**Tech Stack:** TypeScript、Vitest、jsdom、Harbors plugin request API

## Global Constraints

- 不改变 Kit 布局、数据库协议、连接安全策略、SQLite 默认只读行为或 MySQL 可选 database 流程。
- 不新增依赖，不进行两套 Kit 的功能对齐或视觉重做。
- 每项行为先写失败测试，再写最小实现。
- 分支提交标题使用 `[Bug]` 和无句号的简短中文摘要。

---

### Task 1: SQLite 首次文件浏览目录

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts`
- Modify: `kits/sqlite/plugins/sqlite-core/main/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-core/tests/sqlite-service.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-explorer/tests/connection-panel.test.ts`

**Interfaces:**
- Produces: `SqliteService.getDefaultDirectory(): string`
- Produces: SQLite core request `getDefaultDirectory(): string`
- Consumes: existing `getRecentDatabases(): string[]` and `listDirectory({ path, showAll })`

- [ ] **Step 1: Write failing service, plugin and Panel tests**

Add a service assertion that `getDefaultDirectory()` equals `os.homedir()`, require `getDefaultDirectory` in the plugin method list, and add an empty-recents Panel case:

```ts
if (method === 'getRecentDatabases') return [];
if (method === 'getDefaultDirectory') return '/Users/demo';
if (method === 'listDirectory') return {
  currentPath: '/Users/demo', parentPath: '/Users', entries: [],
};

expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getDefaultDirectory', undefined);
expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'listDirectory', {
  path: '/Users/demo', showAll: false,
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm run test -w @itharbors/kit-sqlite -- --run \
  plugins/sqlite-core/tests/sqlite-service.test.ts \
  plugins/sqlite-core/tests/plugin-main.test.ts \
  plugins/sqlite-explorer/tests/connection-panel.test.ts
```

Expected: FAIL because `getDefaultDirectory` does not exist and the Panel still lists `.`.

- [ ] **Step 3: Implement the core request and Panel fallback**

Import `homedir` from `node:os`, then add:

```ts
getDefaultDirectory(): string {
  return homedir();
}
```

Expose it from plugin main:

```ts
getDefaultDirectory: () => callService('getDefaultDirectory'),
```

Update the Panel selection without changing recent-path behavior:

```ts
const recentDirectory = recentPaths[0]?.replace(/[\\/][^\\/]+$/, '');
const initialPath = recentDirectory || await requestCore<string>('getDefaultDirectory');
if (!isCurrentActionResult(token)) return;
const listing = await listDirectory(initialPath, false);
```

- [ ] **Step 4: Run tests to verify GREEN**

Run the Step 2 command. Expected: all selected SQLite tests pass.

- [ ] **Step 5: Commit**

```bash
git add kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts \
  kits/sqlite/plugins/sqlite-core/main/src/index.ts \
  kits/sqlite/plugins/sqlite-core/tests/sqlite-service.test.ts \
  kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts \
  kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.ts \
  kits/sqlite/plugins/sqlite-explorer/tests/connection-panel.test.ts
git commit -m '[Bug] 优化 SQLite 首次文件浏览目录'
```

### Task 2: SQLite 结构页前置状态

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-schema/panel.schema/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-schema/tests/panel.test.ts`

**Interfaces:**
- Consumes: existing `ConnectionSnapshot.connected` and `SelectionSnapshot.objectName`
- Produces: 独立的空状态和状态栏文案，不新增跨插件接口

- [ ] **Step 1: Write the failing Panel test**

Mount once with a disconnected connection and once with a connected connection plus null selection. Assert these distinct pairs:

```ts
expect(document.querySelector('.view-host')?.textContent).toContain('请先打开 SQLite 数据库。');
expect(document.querySelector('.status-bar')?.textContent).toContain('等待数据库连接');

expect(document.querySelector('.view-host')?.textContent).toContain('请从资源管理器选择一个数据库对象。');
expect(document.querySelector('.status-bar')?.textContent).toContain('等待选择数据库对象');
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run test -w @itharbors/kit-sqlite -- --run plugins/sqlite-schema/tests/panel.test.ts
```

Expected: FAIL because both states currently render `请先连接数据库并选择对象。`.

- [ ] **Step 3: Split the render branches**

Replace the combined branch with:

```ts
else if(!connection?.connected){
  content='<div class="empty-state">请先打开 SQLite 数据库。</div>';
}
else if(!selection.objectName){
  content='<div class="empty-state">请从资源管理器选择一个数据库对象。</div>';
  status='等待选择数据库对象';
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run the Step 2 command. Expected: all SQLite schema Panel tests pass.

- [ ] **Step 5: Commit**

```bash
git add kits/sqlite/plugins/sqlite-schema/panel.schema/src/index.ts \
  kits/sqlite/plugins/sqlite-schema/tests/panel.test.ts
git commit -m '[Bug] 区分 SQLite 结构页前置状态'
```

### Task 3: MySQL 连接参数即时校验

**Files:**
- Modify: `kits/mysql/plugins/mysql-explorer/panel.connection/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts`

**Interfaces:**
- Produces: local `validateConnectionForm(): { field: 'host' | 'port' | 'user'; message: string } | null`
- Consumes: existing `connect()` and connection readout error slot

- [ ] **Step 1: Write failing Panel tests**

Use table-driven invalid inputs and verify no core connection request occurs, the correct Chinese message appears, the input has `aria-invalid="true"`, receives focus, and the password remains intact:

```ts
it.each([
  ['host', '   ', '请输入 MySQL 主机。'],
  ['port', '0', '端口必须是 1 到 65535 之间的整数。'],
  ['user', '   ', '请输入 MySQL 用户名。'],
] as const)('validates %s before connecting', async (field, value, message) => {
  setValue('password', 'secret');
  setValue(field, value);
  (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(message));
  expect(request.mock.calls.filter((call) => call[1] === 'connect')).toHaveLength(0);
  expect(document.querySelector(`[data-field="${field}"]`)).toHaveAttribute('aria-invalid', 'true');
  expect(document.activeElement).toBe(document.querySelector(`[data-field="${field}"]`));
  expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('secret');
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run test -w @itharbors/kit-mysql -- --run plugins/mysql-explorer/tests/connection-panel.test.ts
```

Expected: FAIL because invalid values currently reach core and display English protocol errors.

- [ ] **Step 3: Implement validation, focus and invalid state**

Track `invalidField`, validate before `runAction`, render `required` and `aria-invalid`, and focus after rendering:

```ts
type RequiredConnectionField = 'host' | 'port' | 'user';
type ConnectionValidation = { field: RequiredConnectionField; message: string };

let invalidField: RequiredConnectionField | null = null;

function validateConnectionForm(): ConnectionValidation | null {
  if (form.host.trim() === '') return { field: 'host' as const, message: '请输入 MySQL 主机。' };
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { field: 'port' as const, message: '端口必须是 1 到 65535 之间的整数。' };
  }
  if (form.user.trim() === '') return { field: 'user' as const, message: '请输入 MySQL 用户名。' };
  return null;
}

async function connect(): Promise<void> {
  const validation = validateConnectionForm();
  if (validation) {
    invalidField = validation.field;
    error = { message: validation.message };
    render();
    queueMicrotask(() => root
      ?.querySelector<HTMLInputElement>(`[data-field="${validation.field}"]`)
      ?.focus());
    return;
  }
  invalidField = null;
  const input = {
    host: form.host,
    port: Number(form.port),
    user: form.user,
    password: form.password,
    database: form.database.trim() || null,
    tls: form.tls,
  };
  await runAction('connect', async (token) => {
    const pendingConnection = requestCore<ConnectionSnapshot>('connect', input);
    form.password = '';
    render();
    const next = await pendingConnection;
    if (!isCurrentAction(token)) return;
    if (!isCurrentActionResult(token) || isStale(next)) return;
    acceptConnection(next);
  });
}
```

In `field(...)`, append these attributes for required fields:

```ts
function field(
  name: keyof Omit<ConnectionForm, 'tls'>,
  label: string,
  value: string,
  type: string,
  autocomplete: string,
  className = '',
  disabled = false,
): string {
  const required = name === 'host' || name === 'port' || name === 'user';
  const invalid = invalidField === name;
  return `<label${className ? ` class="${className}"` : ''}>${label}<input data-field="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}"${name === 'port' ? ' min="1" max="65535"' : ''}${name === 'database' ? ' placeholder="连接后选择…"' : ''}${required ? ' required' : ''}${invalid ? ' aria-invalid="true"' : ''}${disabled ? ' disabled' : ''}></label>`;
}
```

Clear the local validation marker when the affected input changes:

```ts
if (invalidField === name) {
  invalidField = null;
  error = null;
  render();
  queueMicrotask(() => root?.querySelector<HTMLInputElement>(`[data-field="${name}"]`)?.focus());
}
```

Reset `invalidField` in `resetState()` and `unmount()`. Do not change optional database, password clearing after request, TLS or core validation.

- [ ] **Step 4: Run test to verify GREEN**

Run the Step 2 command. Expected: all MySQL connection Panel tests pass, including blank optional database.

- [ ] **Step 5: Commit**

```bash
git add kits/mysql/plugins/mysql-explorer/panel.connection/src/index.ts \
  kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts
git commit -m '[Bug] 增加 MySQL 连接参数即时校验'
```

### Task 4: Integrated verification

**Files:**
- Verify only; no planned source changes

**Interfaces:**
- Consumes: all three tasks
- Produces: build, plugin-check, Kit test and repository-check evidence

- [ ] **Step 1: Run both Kit suites**

```bash
npm run test -w @itharbors/kit-sqlite
npm run test -w @itharbors/kit-mysql
```

Expected: both suites pass; the environment-gated live MySQL test may remain skipped when `MYSQL_TEST_URL` is absent.

- [ ] **Step 2: Build and check affected plugins**

```bash
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-core
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-explorer
node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-schema
node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-explorer
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-core
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-explorer
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-schema
node scripts/ce-plugin.mjs check kits/mysql/plugins/mysql-explorer
```

Expected: every command exits 0.

- [ ] **Step 3: Run repository verification**

```bash
npm run check
```

Expected: build, all tests, plugin checks and change-workflow tests pass.

- [ ] **Step 4: Review the branch**

```bash
git status --short
git diff origin/main...HEAD --check
git log --oneline origin/main..HEAD
```

Expected: clean worktree, no whitespace errors, and only focused `[Bug]` commits for this product polish.
