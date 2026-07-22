# 启动命令与默认端口调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供 `npm run start` 稳定桌面端入口，并将稳定和开发运行栈的默认端口迁移至互不冲突的高位端口。

**Architecture:** `scripts/lib/runtime-ports.mjs` 继续是两套默认端口的唯一来源；启动器通过既有的运行配置解析函数消费它。`package.json` 仅定义命令契约和开发 Web 栈的清理边界，`electron` 通过转发给 `start` 保持兼容。测试锁定端口解析、脚本值和清理范围，三份文档同步引用同一组端口。

**Tech Stack:** Node.js ESM、node:test、npm scripts、Electron、Vite。

## Global Constraints

- 稳定配置（`npm run start`）必须使用 Gateway `48380`、Server `48381`、Client `48382`、Notification Host `48383`。
- 开发配置（`npm run dev` 与 `npm run dev:web`）必须使用 Gateway `49380`、Server `49381`、Client `49382`、Notification Host `49383`。
- 仅允许 `HARBORS_GATEWAY_PORT`、`HARBORS_SERVER_PORT`、`HARBORS_CLIENT_PORT`、`HARBORS_NOTIFICATION_PORT` 覆盖端口；端口必须是 1–65535 整数，且同一配置不得重复。
- `npm run electron` 必须是 `npm run start` 的兼容别名；`npm run kill` 只能清理开发 Web 的 Gateway、Server、Client 默认端口。
- 不新增依赖、不改变现有布局或 Electron 启动参数语义。
- 每个提交使用仓库规范的 `[Feature] 中文摘要` 标题。

---

## File Structure

- `scripts/lib/runtime-ports.mjs`：稳定与开发端口的唯一默认值来源，并保留覆盖和冲突校验。
- `scripts/lib/runtime-ports.test.mjs`：验证两套精确默认值、覆盖与重复端口错误。
- `package.json`：暴露稳定 `start` 命令、兼容 `electron` 别名，并限定 `kill` 的开发 Web 清理端口。
- `scripts/lib/electron-launcher.test.mjs`：验证开发子进程拿到新端口、命令契约和清理边界。
- `readme.md`、`docs/guides/development-workflow.md`、`docs/architecture/runtime-flows.md`：面向使用者说明新的稳定入口、开发入口和端口映射。

### Task 1: 将运行时默认端口迁移到高位端口

**Files:**
- Modify: `scripts/lib/runtime-ports.mjs:1-2`
- Modify: `scripts/lib/runtime-ports.test.mjs:5-17`
- Modify: `scripts/lib/electron-launcher.test.mjs:48-60`
- Test: `scripts/lib/runtime-ports.test.mjs`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: `resolveRuntimePorts(env, profile)` 已有的 `stable` / `development` 配置选择和端口唯一性校验。
- Produces: `STABLE_PORTS` 为 `{ gateway: 48380, server: 48381, client: 48382, notification: 48383 }`，`DEVELOPMENT_PORTS` 为 `{ gateway: 49380, server: 49381, client: 49382, notification: 49383 }`。

- [ ] **Step 1: 写出新的默认端口断言**

  在 `scripts/lib/runtime-ports.test.mjs` 的第一个测试中，将两项完整对象断言替换为：

  ```js
  assert.deepEqual(STABLE_PORTS, { gateway: 48380, server: 48381, client: 48382, notification: 48383 });
  assert.deepEqual(DEVELOPMENT_PORTS, { gateway: 49380, server: 49381, client: 49382, notification: 49383 });
  ```

  将重复端口测试中的两个覆盖值改为 `49380`。在 `scripts/lib/electron-launcher.test.mjs` 的 “isolates each Web child process” 测试中，将 `stack.ports` 和子进程环境断言改为 Gateway `49380`、Server `49381`、Client `49382`、Notification `49383`。

- [ ] **Step 2: 运行测试并确认当前实现失败**

  Run: `node --test scripts/lib/runtime-ports.test.mjs scripts/lib/electron-launcher.test.mjs`

  Expected: FAIL，`runtime-ports` 的对象断言显示当前 `8080` / `18080` 等旧端口与期望端口不同。

- [ ] **Step 3: 修改唯一的端口默认值来源**

  将 `scripts/lib/runtime-ports.mjs` 前两行替换为：

  ```js
  export const STABLE_PORTS = Object.freeze({ gateway: 48380, server: 48381, client: 48382, notification: 48383 });
  export const DEVELOPMENT_PORTS = Object.freeze({ gateway: 49380, server: 49381, client: 49382, notification: 49383 });
  ```

  保持 `PORT_ENV`、`resolveRuntimeProfile`、`resolveRuntimePorts` 与 `parsePort` 的行为不变，确保所有现有启动器仍通过同一接口取得端口。

- [ ] **Step 4: 运行聚焦测试并确认通过**

  Run: `node --test scripts/lib/runtime-ports.test.mjs scripts/lib/electron-launcher.test.mjs`

  Expected: PASS，两个文件中的所有测试均通过，且开发子进程环境只携带 `49380`、`49381`、`49382`、`49383`。

- [ ] **Step 5: 提交端口默认值改动**

  ```bash
  git add scripts/lib/runtime-ports.mjs scripts/lib/runtime-ports.test.mjs scripts/lib/electron-launcher.test.mjs
  git commit -m "[Feature] 调整稳定与开发默认端口"
  ```

### Task 2: 建立稳定 `start` 命令和受限清理命令

**Files:**
- Modify: `package.json:12-29`
- Modify: `scripts/lib/electron-launcher.test.mjs:77-96`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: `scripts/electron.mjs` 是稳定 Electron 启动器，`scripts/dev-electron.mjs` 是开发 Electron 启动器。
- Produces: `npm run start` 执行稳定启动器，`npm run electron` 以 `npm run start --` 转发任意参数，`npm run kill` 仅处理 `49380`、`49381`、`49382`。

- [ ] **Step 1: 先收紧命令契约测试**

  在 `scripts/lib/electron-launcher.test.mjs` 的 “keeps electron stable” 测试内，替换脚本断言为：

  ```js
  assert.equal(packageJson.scripts.start, 'electron scripts/electron.mjs');
  assert.equal(packageJson.scripts.electron, 'npm run start --');
  assert.equal(packageJson.scripts.dev, 'node scripts/dev-electron.mjs');
  ```

  在 “limits the default cleanup command” 测试内，将三项正则期望替换为 `lsof -ti:49380`、`lsof -ti:49381`、`lsof -ti:49382`，并将不得匹配的稳定端口替换为 `48380`、`48381`、`48382`。保留 Notification Host 不参与清理的约束。

- [ ] **Step 2: 运行脚本契约测试并确认失败**

  Run: `node --test scripts/lib/electron-launcher.test.mjs`

  Expected: FAIL，`packageJson.scripts.start` 为 `undefined`，且 `electron` 与 `kill` 仍引用旧脚本或旧端口。

- [ ] **Step 3: 更新 package scripts**

  在 `package.json` 的 `scripts` 对象中使用下列精确条目：

  ```json
  "start": "electron scripts/electron.mjs",
  "dev": "node scripts/dev-electron.mjs",
  "dev:web": "node scripts/dev.mjs",
  "electron": "npm run start --",
  "kill": "lsof -ti:49380 | xargs kill -9 2>/dev/null; lsof -ti:49381 | xargs kill -9 2>/dev/null; lsof -ti:49382 | xargs kill -9 2>/dev/null; echo 'development ports cleared'"
  ```

  保留 `dev` 和 `dev:web` 的现有值及其余 scripts，不让 `kill` 处理 `49383` 或任何稳定端口。

- [ ] **Step 4: 运行脚本契约测试并确认通过**

  Run: `node --test scripts/lib/electron-launcher.test.mjs`

  Expected: PASS，稳定入口为 `start`，旧 `electron` 兼容转发，清理命令只包含开发 Web 三个端口。

- [ ] **Step 5: 提交命令接口改动**

  ```bash
  git add package.json scripts/lib/electron-launcher.test.mjs
  git commit -m "[Feature] 新增稳定启动命令"
  ```

### Task 3: 同步用户文档和运行流程说明

**Files:**
- Modify: `readme.md:35-123`
- Modify: `docs/guides/development-workflow.md:18-94`
- Modify: `docs/architecture/runtime-flows.md:7-49`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: Task 1 的稳定/开发端口对象及 Task 2 的 scripts 命令契约。
- Produces: 所有面向使用者的启动说明使用 `npm run start` 表示稳定桌面端，并准确描述两套端口与 `npm run kill` 的范围。

- [ ] **Step 1: 添加文档文字契约测试**

  在 `scripts/lib/electron-launcher.test.mjs` 中新增测试，读取三个文档并使用下列关键断言：

  ```js
  test('documents the stable start command and isolated high ports', async () => {
    const documents = await Promise.all([
      readFile(new URL('../../readme.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/guides/development-workflow.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/architecture/runtime-flows.md', import.meta.url), 'utf8'),
    ]);

    for (const document of documents) {
      assert.match(document, /npm run start/);
      assert.match(document, /48380/);
      assert.match(document, /48381/);
      assert.match(document, /48382/);
      assert.match(document, /48383/);
      assert.match(document, /49380/);
      assert.match(document, /49381/);
      assert.match(document, /49382/);
      assert.match(document, /49383/);
    }
  });
  ```

  文档路径以测试文件 `scripts/lib/electron-launcher.test.mjs` 为基准，`../../` 正好定位到仓库根目录。

- [ ] **Step 2: 运行文档契约测试并确认失败**

  Run: `node --test --test-name-pattern="documents the stable start command" scripts/lib/electron-launcher.test.mjs`

  Expected: FAIL，至少一个文档仍缺少 `npm run start` 或新的 `483xx` / `493xx` 端口。

- [ ] **Step 3: 用新的命令与端口更新全部三份文档**

  在 `readme.md`、`docs/guides/development-workflow.md` 和 `docs/architecture/runtime-flows.md` 中完成以下精确替换：

  ```text
  稳定桌面端入口：npm run start
  兼容旧入口：npm run electron
  稳定端口：Gateway 48380，Server 48381，Client 48382，Notification Host 48383
  开发端口：Gateway 49380，Server 49381，Client 49382，Notification Host 49383
  开发 Web 清理范围：49380、49381、49382
  ```

  README 的快速开始与端口表、开发工作流的命令说明与端口表、运行流程的 Mermaid 文本和说明段落都必须采用该值；不要留下 `8080`、`3000`、`5173`、`17896`、`18080`、`13000`、`15173` 或 `17897` 作为运行端口示例。

- [ ] **Step 4: 运行文档与启动器测试并确认通过**

  Run: `node --test scripts/lib/electron-launcher.test.mjs`

  Expected: PASS，新文档测试与现有 Electron 启动器测试全部通过。

- [ ] **Step 5: 提交文档同步改动**

  ```bash
  git add readme.md docs/guides/development-workflow.md docs/architecture/runtime-flows.md scripts/lib/electron-launcher.test.mjs
  git commit -m "[Feature] 更新启动命令与端口文档"
  ```

### Task 4: 执行仓库验证和开发 Gateway 连通性冒烟检查

**Files:**
- Modify: 无
- Test: `scripts/lib/runtime-ports.test.mjs`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: Task 1–3 已实现的端口解析、脚本命令和文档契约。
- Produces: 通过完整静态测试与可达的开发 Gateway `49380`，证明开发端口组可用且不触及稳定端口组。

- [ ] **Step 1: 运行完整项目检查**

  Run: `npm run check`

  Expected: exit code 0，项目的 lint、类型检查和测试均通过。

- [ ] **Step 2: 启动开发 Web 栈**

  Run: `npm run dev:web`

  Expected: 进程持续运行，并在日志中显示 Gateway `49380`、Server `49381`、Client `49382`；保留其进程标识供下一步停止。

- [ ] **Step 3: 验证开发 Gateway 可达性与端口隔离**

  Run: `curl --fail --silent http://127.0.0.1:49380/health && (lsof -nP -iTCP:48380 -sTCP:LISTEN || true)`

  Expected: `curl` 请求成功，证明 Gateway 在 `49380` 可达；该命令不约定 `/health` 的专用响应内容。`lsof` 只会显示已有稳定实例（若存在），开发 Web 栈本身不占用 `48380`。

- [ ] **Step 4: 停止开发 Web 栈并确认其端口释放**

  Run: `npm run kill && ! lsof -nP -iTCP:49380 -sTCP:LISTEN && ! lsof -nP -iTCP:49381 -sTCP:LISTEN && ! lsof -nP -iTCP:49382 -sTCP:LISTEN`

  Expected: 输出 `development ports cleared`，三个开发 Web 端口均不再监听；稳定端口和 `49383` 不在清理范围内。

- [ ] **Step 5: 检查工作树与提交历史**

  Run: `git status --short && git log --oneline origin/main..HEAD`

  Expected: 工作树干净，日志包含本计划的三个实现 `[Feature]` 提交以及设计与计划提交。

### Task 5: 消除旧端口回退并同步通知 Skill

**Files:**
- Modify: `packages/gateway/src/index.ts:4-6`
- Modify: `packages/server/src/index.ts:5`
- Modify: `packages/client/vite.config.ts:5`
- Modify: `scripts/lib/notification-host.mjs:4`
- Modify: `scripts/lib/notification-host.test.mjs:10-16`
- Modify: `.agents/skills/notify-user/scripts/notify.mjs:59-63`
- Modify: `.agents/skills/notify-user/tests/notify.test.mjs:77-101`
- Modify: `.agents/skills/notify-user/SKILL.md:57`
- Modify: `scripts/lib/electron-launcher.test.mjs:102-109`
- Modify: `docs/architecture/system-overview.md:15-46`
- Modify: `docs/guides/developing-plugins-and-kits.md:407`
- Test: `.agents/skills/notify-user/tests/notify.test.mjs`
- Test: `scripts/lib/notification-host.test.mjs`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: Task 1 的稳定端口 `{ gateway: 48380, server: 48381, client: 48382, notification: 48383 }` 与开发端口 `{ gateway: 49380, server: 49381, client: 49382, notification: 49383 }`。
- Produces: 所有可直接执行的稳定回退值和已安装通知 Skill 的默认 Notification Host 端口均为 `48383`；开发启动器仍显式注入 `49380`–`49383`。

- [ ] **Step 1: 添加防回归断言**

  在 `.agents/skills/notify-user/tests/notify.test.mjs` 的通知发送测试旁新增：

  ```js
  test('uses the stable Notification Host port by default', async () => {
    const calls = [];
    await sendNotification({ title: 'Default port' }, {
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ id: 'default-port' }), { status: 201 });
      },
    });
    assert.deepEqual(calls, ['http://127.0.0.1:48383/v1/notifications']);
  });
  ```

  将 `scripts/lib/notification-host.test.mjs` 的无输入端口断言改为 `48383`。在 `scripts/lib/electron-launcher.test.mjs` 的清理命令测试增加：

  ```js
  assert.doesNotMatch(packageJson.scripts.kill, /lsof -ti:48383(?:\s|$)/);
  ```

- [ ] **Step 2: 运行聚焦测试并确认当前实现失败**

  Run: `node --test .agents/skills/notify-user/tests/notify.test.mjs scripts/lib/notification-host.test.mjs scripts/lib/electron-launcher.test.mjs`

  Expected: FAIL，通知 Skill 与 Notification Host 的无覆盖默认端口仍是 `17896`，新通知 Skill URL 断言期望 `48383` 不匹配。

- [ ] **Step 3: 更新所有可执行稳定回退值**

  将以下回退值替换为稳定默认端口，保留相应环境变量优先级、校验与启动器显式注入逻辑：

  ```ts
  // packages/gateway/src/index.ts
  const PORT = parseInt(process.env.PORT || '48380', 10);
  const SERVER_PORT = parseInt(process.env.SERVER_PORT || '48381', 10);
  const CLIENT_PORT = parseInt(process.env.CLIENT_PORT || '48382', 10);

  // packages/server/src/index.ts
  const PORT = parseInt(process.env.PORT || '48381', 10);

  // packages/client/vite.config.ts
  port: parseInt(process.env.CLIENT_PORT || '48382', 10),
  ```

  在 `scripts/lib/notification-host.mjs` 中设定：

  ```js
  const DEFAULT_PORT = 48383;
  ```

  在 `.agents/skills/notify-user/scripts/notify.mjs` 的 `sendNotification` 默认解构中设定：

  ```js
  port = process.env.HARBORS_NOTIFICATION_PORT || '48383',
  ```

- [ ] **Step 4: 同步用户文档与清理边界**

  将 `.agents/skills/notify-user/SKILL.md` 和 `docs/guides/developing-plugins-and-kits.md` 中的 Notification Host 默认值更新为 `48383`。将 `docs/architecture/system-overview.md` 的稳定运行拓扑更新为 Notification Host `48383`、Gateway `48380`、Server `48381`、Client `48382`，并修正 Gateway 描述表中的端口。不要修改历史的 `docs/superpowers/specs` 或 `docs/superpowers/plans`。

- [ ] **Step 5: 运行聚焦验证并确认通过**

  Run: `node --test .agents/skills/notify-user/tests/notify.test.mjs scripts/lib/notification-host.test.mjs scripts/lib/electron-launcher.test.mjs && rg -n '17896|8080|3000|5173' .agents/skills/notify-user packages/gateway/src/index.ts packages/server/src/index.ts packages/client/vite.config.ts scripts/lib/notification-host.mjs docs/architecture/system-overview.md docs/guides/developing-plugins-and-kits.md`

  Expected: node 测试全部通过；`rg` 对这些可执行回退和当前用户文档无匹配（测试中传入的非默认示例端口不计入检索范围）。

- [ ] **Step 6: 提交端口回退修复**

  ```bash
  git add packages/gateway/src/index.ts packages/server/src/index.ts packages/client/vite.config.ts scripts/lib/notification-host.mjs scripts/lib/notification-host.test.mjs .agents/skills/notify-user/scripts/notify.mjs .agents/skills/notify-user/tests/notify.test.mjs .agents/skills/notify-user/SKILL.md scripts/lib/electron-launcher.test.mjs docs/architecture/system-overview.md docs/guides/developing-plugins-and-kits.md
  git commit -m "[Feature] 同步端口回退与通知默认值"
  ```
