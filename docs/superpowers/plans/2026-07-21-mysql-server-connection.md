# MySQL Server Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许不指定数据库连接 MySQL 服务器，并从左侧选择数据库后加载工作台对象。

**Architecture:** Core 使用可空数据库连接参数，并通过候选连接池原子切换默认数据库。Explorer 快照同时拥有数据库列表、当前数据库和当前库对象，Panel 只通过 request/broadcast 交互。

**Tech Stack:** TypeScript、mysql2、Vitest、CSS、Electron 单 Kit 开发服务器

## Global Constraints

- 数据库切换失败必须保留原连接。
- 密码不得进入快照、广播、日志或浏览器状态，disconnect/dispose 必须清除活动连接配置。
- 重复选择当前数据库不得重建连接池或递增 revision。
- 未选择数据库时不得请求 schema。

---

### Task 1: Core 可选数据库连接

**Files:**
- Modify: `kits/mysql/plugins/mysql-core/tests/protocol.test.ts`
- Modify: `kits/mysql/plugins/mysql-core/tests/mysql-driver.test.ts`
- Modify: `kits/mysql/plugins/mysql-core/tests/mysql-service.test.ts`
- Modify: `kits/mysql/plugins/mysql-core/tests/plugin-main.test.ts`
- Modify: `kits/mysql/plugins/mysql-core/main/src/protocol.ts`
- Modify: `kits/mysql/plugins/mysql-core/main/src/mysql-driver.ts`
- Modify: `kits/mysql/plugins/mysql-core/main/src/mysql-service.ts`
- Modify: `kits/mysql/plugins/mysql-core/main/src/index.ts`
- Modify: `packages/mysql-contracts/src/contracts.ts`

**Interfaces:**
- Produces: `ConnectionInput.database: string | null`, `MysqlService.getDatabases()`, `MysqlService.selectDatabase(input)`，Core 同名 request 方法与 revision 快照

- [ ] **Step 1: Write failing Core tests**

  覆盖空数据库解析、driver 省略 database、服务器级探测、数据库列表、成功/失败/重复切换，以及 Core 广播 revision。

- [ ] **Step 2: Run Core tests and verify RED**

  Run: `npm run test -w @itharbors/kit-mysql -- plugins/mysql-core/tests/protocol.test.ts plugins/mysql-core/tests/mysql-driver.test.ts plugins/mysql-core/tests/mysql-service.test.ts plugins/mysql-core/tests/plugin-main.test.ts`

- [ ] **Step 3: Implement the Core behavior**

  只实现上述接口；候选 pool 成功后交换，失败路径关闭候选，disconnect 清除活动配置。

- [ ] **Step 4: Run Core tests and verify GREEN**

  重复 Step 2 命令，Expected: PASS。

### Task 2: Explorer 数据库快照与选择

**Files:**
- Modify: `packages/mysql-contracts/src/contracts.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/tests/selection.test.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/main/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/package.json`

**Interfaces:**
- Consumes: Core `getDatabases`、`selectDatabase` 与 connection broadcast
- Produces: 包含 `database`、`databases` 的 `ObjectsSnapshot`，Explorer `selectDatabase` request

- [ ] **Step 1: Write failing Explorer main tests**

  覆盖无默认库时只读数据库列表、已有默认库时读取 schema、选择数据库、失败和迟到响应。

- [ ] **Step 2: Run Explorer main tests and verify RED**

  Run: `npm run test -w @itharbors/kit-mysql -- plugins/mysql-explorer/tests/selection.test.ts`

- [ ] **Step 3: Implement snapshot refresh and database selection**

  连接事件必须携带当前 database；刷新先读取 databases，仅在 database 非空时读取 schema。

- [ ] **Step 4: Run Explorer main tests and verify GREEN**

  重复 Step 2 命令，Expected: PASS。

### Task 3: Connection 与 Explorer Panel

**Files:**
- Modify: `kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/tests/panel.test.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.connection/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.explorer/src/index.css`
- Modify: `kits/mysql/README.md`

**Interfaces:**
- Consumes: Explorer `getObjectsSnapshot`、`selectDatabase`、`selectObject`
- Produces: “数据库（可选）”连接字段、数据库分组、未选库提示和数据库选择按钮

- [ ] **Step 1: Write failing Panel tests**

  断言空数据库连接 payload 为 `null`、连接状态文案、数据库分组、搜索禁用条件和选择请求。

- [ ] **Step 2: Run Panel tests and verify RED**

  Run: `npm run test -w @itharbors/kit-mysql -- plugins/mysql-explorer/tests/connection-panel.test.ts plugins/mysql-explorer/tests/panel.test.ts`

- [ ] **Step 3: Implement minimal Panel markup, behavior and styles**

  保留现有视觉 token；数据库项使用独立圆柱形标记，表/视图分组和主工作区不变。

- [ ] **Step 4: Run Panel tests and verify GREEN**

  重复 Step 2 命令，Expected: PASS。

### Task 4: Integration and verification

**Files:**
- Modify: `kits/mysql/tests/runtime-integration.test.ts` only if the existing fixture requires the new snapshot fields

**Interfaces:**
- Consumes: 完整 Core/Explorer/Panel 流程
- Produces: 可在单 Kit 浏览器中验证的服务器级连接体验

- [ ] **Step 1: Run MySQL Kit tests**

  Run: `npm run test -w @itharbors/kit-mysql`

- [ ] **Step 2: Build and check the changed plugins**

  Run: `node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-core && node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-explorer && node scripts/ce-plugin.mjs check kits/mysql/plugins/mysql-core && node scripts/ce-plugin.mjs check kits/mysql/plugins/mysql-explorer`

- [ ] **Step 3: Verify in the current single-Kit browser**

  使用数据库留空的真实服务器连接，确认数据库列表出现；选择数据库后确认对象列表出现，截图并读取 DOM/尺寸。

- [ ] **Step 4: Run repository verification**

  Run: `npm run check`

- [ ] **Step 5: Commit and push**

  显式暂存相关文件，提交 `[Bug] 支持 MySQL 服务器级连接`，推送 `bug/kit-lifecycle`。
