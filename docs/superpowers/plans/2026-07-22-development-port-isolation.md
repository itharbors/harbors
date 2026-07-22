# 开发与稳定桌面端口隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让稳定 Electron 实例与开发 Electron/Web 实例使用不同端口组，并能够在同一台机器上并行运行。

**Architecture:** 以 `scripts/lib/runtime-ports.mjs` 作为唯一的端口配置来源，区分 `stable` 与 `development` 配置并校验显式覆盖。`scripts/dev.mjs` 只消费已组装好的子进程环境；Electron 将自身运行配置和实际 Notification Host 端口传给 Web 栈，确保窗口 URL、Gateway 和通知服务属于同一个端口组。

**Tech Stack:** Node.js ESM、npm workspaces、Electron、Vite、Node test runner。

## Global Constraints

- 稳定 `npm run electron` 默认使用 8080、3000、5173、17896。
- `npm run dev` 与 `npm run dev:web` 默认使用 18080、13000、15173；开发 Electron 的 Notification Host 使用 17897。
- 仅接受 `HARBORS_GATEWAY_PORT`、`HARBORS_SERVER_PORT`、`HARBORS_CLIENT_PORT`、`HARBORS_NOTIFICATION_PORT` 覆盖端口。
- 所有端口必须是 1–65535 的整数，Gateway、Server、Client、Notification Host 不得重复。
- 不改变 Gateway 路由、API/SSE、Kit/插件协议或现有稳定端口。
- `npm run kill` 只能释放默认开发端口，不得影响稳定端口。

---

## 文件结构

- Create: `scripts/lib/runtime-ports.mjs` — 运行配置默认端口、环境解析和唯一性校验。
- Create: `scripts/lib/runtime-ports.test.mjs` — 端口解析与错误契约测试。
- Create: `scripts/dev-electron.mjs` — 跨平台开发 Electron 包装器。
- Modify: `scripts/lib/dev-launcher.mjs` — 从端口模块生成 Gateway、Server、Vite 的独立环境。
- Modify: `scripts/dev.mjs` — 使用独立子进程环境并按 Gateway 实际端口打印链接。
- Modify: `scripts/electron.mjs` — 按运行配置构造 Gateway URL、Notification Host 和子进程环境。
- Modify: `scripts/lib/electron-launcher.test.mjs` — 验证命令语义、端口环境和 Electron 接入。
- Modify: `package.json` — 让 `dev` 使用开发 Electron 包装器、让 `kill` 只释放开发端口、纳入新测试。
- Modify: `README.md`、`docs/guides/development-workflow.md`、`docs/architecture/runtime-flows.md` — 说明稳定/开发入口、端口表和安全清理行为。

## Task 1: 建立端口配置契约

**Files:**

- Create: `scripts/lib/runtime-ports.mjs`
- Create: `scripts/lib/runtime-ports.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `resolveRuntimeProfile(value, fallback)`，返回 `'stable' | 'development'`。
- Produces: `resolveRuntimePorts(env, profile)`，返回 `{ gateway, server, client, notification }`。
- Produces: `STABLE_PORTS` 和 `DEVELOPMENT_PORTS` 常量。
- Consumed by: `scripts/lib/dev-launcher.mjs`、`scripts/electron.mjs`。

- [ ] **Step 1: 写失败测试，锁定默认值、覆盖值与非法配置**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVELOPMENT_PORTS, STABLE_PORTS, resolveRuntimePorts } from './runtime-ports.mjs';

test('keeps stable and development ports disjoint', () => {
  assert.deepEqual(STABLE_PORTS, { gateway: 8080, server: 3000, client: 5173, notification: 17896 });
  assert.deepEqual(DEVELOPMENT_PORTS, { gateway: 18080, server: 13000, client: 15173, notification: 17897 });
  assert.deepEqual(resolveRuntimePorts({}, 'development'), DEVELOPMENT_PORTS);
  assert.deepEqual(resolveRuntimePorts({}, 'stable'), STABLE_PORTS);
});

test('uses explicit Harbors port overrides and rejects collisions', () => {
  assert.deepEqual(resolveRuntimePorts({
    HARBORS_GATEWAY_PORT: '19080', HARBORS_SERVER_PORT: '19000',
    HARBORS_CLIENT_PORT: '19573', HARBORS_NOTIFICATION_PORT: '19896',
  }, 'development'), { gateway: 19080, server: 19000, client: 19573, notification: 19896 });
  assert.throws(() => resolveRuntimePorts({ HARBORS_GATEWAY_PORT: '0' }, 'development'), /HARBORS_GATEWAY_PORT/);
  assert.throws(() => resolveRuntimePorts({ HARBORS_GATEWAY_PORT: '18080', HARBORS_SERVER_PORT: '18080' }, 'development'), /unique/i);
});
```

- [ ] **Step 2: 运行测试，确认缺少模块导致失败**

Run: `node --test scripts/lib/runtime-ports.test.mjs`

Expected: FAIL，提示 `runtime-ports.mjs` 不存在。

- [ ] **Step 3: 实现严格的端口解析模块**

```js
export const STABLE_PORTS = Object.freeze({ gateway: 8080, server: 3000, client: 5173, notification: 17896 });
export const DEVELOPMENT_PORTS = Object.freeze({ gateway: 18080, server: 13000, client: 15173, notification: 17897 });

const PORT_ENV = {
  gateway: 'HARBORS_GATEWAY_PORT', server: 'HARBORS_SERVER_PORT',
  client: 'HARBORS_CLIENT_PORT', notification: 'HARBORS_NOTIFICATION_PORT',
};

export function resolveRuntimeProfile(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'stable' || value === 'development') return value;
  throw new Error('HARBORS_RUNTIME_PROFILE must be "stable" or "development"');
}

export function resolveRuntimePorts(env, profile) {
  const defaults = profile === 'stable' ? STABLE_PORTS : DEVELOPMENT_PORTS;
  const ports = Object.fromEntries(Object.entries(PORT_ENV).map(([name, envName]) => [
    name, parsePort(env[envName], defaults[name], envName),
  ]));
  if (new Set(Object.values(ports)).size !== 4) throw new Error('Harbors runtime ports must be unique');
  return ports;
}

function parsePort(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer between 1 and 65535`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}
```

- [ ] **Step 4: 运行端口模块测试，确认通过**

Run: `node --test scripts/lib/runtime-ports.test.mjs`

Expected: PASS，所有默认值、覆盖值和错误路径通过。

- [ ] **Step 5: 将端口模块测试纳入根测试命令并提交**

在 `package.json` 的 `test` 脚本中加入 `scripts/lib/runtime-ports.test.mjs`，随后运行：

```bash
node --test scripts/lib/runtime-ports.test.mjs
git add scripts/lib/runtime-ports.mjs scripts/lib/runtime-ports.test.mjs package.json
git commit -m '[Feature] 定义开发与稳定端口配置'
```

## Task 2: 为 Web 栈组装无冲突的子进程环境

**Files:**

- Modify: `scripts/lib/dev-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/dev.mjs`

**Interfaces:**

- Consumes: `resolveRuntimeProfile`、`resolveRuntimePorts`。
- Produces: `createDevStackEnvironments(baseEnv, requestedKit, profile)`，返回 `{ ports, gatewayEnv, serverEnv, clientEnv }`。
- Consumed by: `scripts/dev.mjs`。

- [ ] **Step 1: 写失败测试，断言每个子进程只收到自己的端口**

```js
import { createDevStackEnvironments } from './dev-launcher.mjs';

test('isolates each Web child process from inherited legacy port variables', () => {
  const stack = createDevStackEnvironments({ PORT: '8080', SERVER_PORT: '3000', CLIENT_PORT: '5173' }, '', 'development');
  assert.deepEqual(stack.ports, { gateway: 18080, server: 13000, client: 15173, notification: 17897 });
  assert.equal(stack.gatewayEnv.PORT, '18080');
  assert.equal(stack.gatewayEnv.SERVER_PORT, '13000');
  assert.equal(stack.gatewayEnv.CLIENT_PORT, '15173');
  assert.equal(stack.serverEnv.PORT, '13000');
  assert.equal(stack.serverEnv.SERVER_PORT, undefined);
  assert.equal(stack.clientEnv.CLIENT_PORT, '15173');
  assert.equal(stack.clientEnv.PORT, undefined);
});
```

- [ ] **Step 2: 运行测试，确认导出尚不存在**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: FAIL，提示 `createDevStackEnvironments` 未导出。

- [ ] **Step 3: 在启动器中组装独立环境，并接入 dev.mjs**

```js
export function createDevStackEnvironments(baseEnv, requestedKit, profile = 'development') {
  const runtimeProfile = resolveRuntimeProfile(baseEnv.HARBORS_RUNTIME_PROFILE, profile);
  const ports = resolveRuntimePorts(baseEnv, runtimeProfile);
  const common = { ...baseEnv, HARBORS_RUNTIME_PROFILE: runtimeProfile };
  delete common.PORT; delete common.SERVER_PORT; delete common.CLIENT_PORT;
  return {
    ports,
    gatewayEnv: { ...common, PORT: String(ports.gateway), SERVER_PORT: String(ports.server), CLIENT_PORT: String(ports.client) },
    serverEnv: { ...createDevServerEnv(common, requestedKit), PORT: String(ports.server) },
    clientEnv: { ...common, CLIENT_PORT: String(ports.client) },
  };
}
```

在 `scripts/dev.mjs` 中以 `createDevStackEnvironments` 取代共享 `baseEnv`：Gateway 使用 `gatewayEnv`、Server 使用 `serverEnv`、Client 使用 `clientEnv`，并用 `stack.ports.gateway` 打印页面地址。移除本地 `parsePort`。

- [ ] **Step 4: 运行启动器测试，确认通过**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: PASS，包括既有 Kit 参数与新端口隔离断言。

- [ ] **Step 5: 提交 Web 栈隔离改动**

```bash
git add scripts/lib/dev-launcher.mjs scripts/dev.mjs scripts/lib/electron-launcher.test.mjs
git commit -m '[Feature] 隔离 Web 开发子进程端口'
```

## Task 3: 分离稳定 Electron 与开发 Electron 启动

**Files:**

- Create: `scripts/dev-electron.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `package.json`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**

- Consumes: `resolveRuntimeProfile`、`resolveRuntimePorts` 和 `createDevStackEnvironments`。
- Produces: `npm run dev` 的跨平台开发 Electron 入口。
- Preserves: `npm run electron` 的稳定端口语义。

- [ ] **Step 1: 写失败测试，锁定命令语义和 Electron 端口接入**

```js
test('keeps electron stable and makes dev an isolated Electron entry', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));
  assert.equal(packageJson.scripts.electron, 'electron scripts/electron.mjs');
  assert.equal(packageJson.scripts.dev, 'node scripts/dev-electron.mjs');
  const electronSource = await readFile(new URL('../electron.mjs', import.meta.url), 'utf8');
  assert.match(electronSource, /resolveRuntimePorts/);
  assert.match(electronSource, /HARBORS_RUNTIME_PROFILE/);
});
```

- [ ] **Step 2: 运行测试，确认现有 `dev` 仍是 `electron` 别名而失败**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: FAIL，`packageJson.scripts.dev` 与预期不同。

- [ ] **Step 3: 实现开发 Electron 包装器与 Electron 配置传递**

`scripts/dev-electron.mjs` 使用 npm 的本地 Electron CLI，并保留用户传入的 Kit 参数：

```js
import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCommand, ['exec', 'electron', '--', 'scripts/electron.mjs', ...process.argv.slice(2)], {
  env: { ...process.env, HARBORS_RUNTIME_PROFILE: 'development' }, stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
```

在 `scripts/electron.mjs` 中：

```js
const runtimeProfile = resolveRuntimeProfile(process.env.HARBORS_RUNTIME_PROFILE, 'stable');
const runtimePorts = resolveRuntimePorts(process.env, runtimeProfile);
const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${runtimePorts.gateway}/`;
```

Notification Host 使用 `runtimePorts.notification` 作为解析后的默认端口。`startFramework()` 的子进程环境必须传递 `HARBORS_RUNTIME_PROFILE`、三个 `HARBORS_*_PORT` 值，以及 Notification Host 实际绑定后的 `HARBORS_NOTIFICATION_PORT`；这样 `dev.mjs` 会使用与 Electron URL 一致的端口组。

- [ ] **Step 4: 运行启动器与通知相关单测，确认通过**

Run: `node --test scripts/lib/electron-launcher.test.mjs scripts/lib/notification-host.test.mjs`

Expected: PASS，稳定/开发命令与 Notification Host 端口契约均通过。

- [ ] **Step 5: 提交 Electron 隔离改动**

```bash
git add scripts/dev-electron.mjs scripts/electron.mjs package.json scripts/lib/electron-launcher.test.mjs
git commit -m '[Feature] 分离稳定与开发 Electron 端口'
```

## Task 4: 更新安全清理与开发文档

**Files:**

- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/guides/development-workflow.md`
- Modify: `docs/architecture/runtime-flows.md`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**

- Consumes: 稳定与开发端口表。
- Produces: 面向用户的安全启动/清理说明。

- [ ] **Step 1: 写失败测试，确保默认清理命令不再引用稳定端口**

```js
test('limits the default cleanup command to development ports', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));
  assert.match(packageJson.scripts.kill, /18080/);
  assert.doesNotMatch(packageJson.scripts.kill, /8080|3000|5173/);
});
```

- [ ] **Step 2: 运行测试，确认当前 `kill` 仍引用稳定端口而失败**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: FAIL，`kill` 脚本仍包含 8080、3000、5173。

- [ ] **Step 3: 修改命令和文档**

- 将 `kill` 改为只对 18080、13000、15173 执行既有 `lsof | xargs kill` 流程，并把输出改为 `development ports cleared`。
- README 增加稳定/开发端口表、`npm run electron` 与 `npm run dev` 的职责，以及四个 `HARBORS_*_PORT` 覆盖变量。
- 开发指南将原先“dev 与 electron 等价”的描述替换为“electron 稳定、dev 隔离开发”，并声明 `kill` 不会关闭稳定实例。
- 运行流程图和文字将开发 Gateway/Server/Vite 端口改为 18080/13000/15173，并单独说明稳定 Electron 保持旧端口、开发 Electron Notification Host 使用 17897。

- [ ] **Step 4: 运行文档/命令契约测试，确认通过**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: PASS，默认清理命令只包含开发端口。

- [ ] **Step 5: 提交文档与安全清理改动**

```bash
git add package.json README.md docs/guides/development-workflow.md docs/architecture/runtime-flows.md scripts/lib/electron-launcher.test.mjs
git commit -m '[Docs] 说明开发端口隔离方式'
```

## Task 5: 端到端并行运行验证

**Files:**

- Modify: `docs/guides/development-workflow.md`（仅在实际验证命令或预期结果需要澄清时）

**Interfaces:**

- Consumes: 已实现的稳定/开发端口配置。
- Produces: 稳定实例不会被开发实例影响的运行时证据。

- [ ] **Step 1: 检查稳定实例端口仍被主仓库占用**

Run:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:17896 -sTCP:LISTEN
```

Expected: 四个稳定端口仍由主仓库的日常 Electron 实例监听。

- [ ] **Step 2: 从本 worktree 启动浏览器开发栈**

Run: `npm run dev:web -- --kit @itharbors/kit-mysql`

Expected: Gateway、Server、Vite 分别报告 18080、13000、15173；命令不报告 `EADDRINUSE`。

- [ ] **Step 3: 验证两个端口组并存且开发健康检查可用**

Run:

```bash
lsof -nP -iTCP:18080 -sTCP:LISTEN
lsof -nP -iTCP:13000 -sTCP:LISTEN
lsof -nP -iTCP:15173 -sTCP:LISTEN
curl --fail http://localhost:18080/api/health
```

Expected: 三个开发端口都有监听者，`/api/health` 返回成功；步骤 1 中的稳定端口仍保持监听。

- [ ] **Step 4: 停止仅本次开发栈并复查稳定端口未受影响**

向本次开发栈发送 SIGINT；不得执行 `npm run kill`。随后重复步骤 1 的四个 `lsof` 命令。

Expected: 开发端口关闭，稳定端口继续监听。

- [ ] **Step 5: 运行仓库级验证并提交最终验证材料**

Run: `npm run check`

Expected: PASS。

```bash
git status --short
git diff --check
```

Expected: 只有已提交的本任务文件；无空白错误。
