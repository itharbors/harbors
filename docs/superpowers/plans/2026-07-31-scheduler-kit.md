# Scheduler Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个在 Harbors 应用存活期间可靠运行本地 Node.js 脚本、可视化管理计划并处理错过触发的官方 Scheduler Kit。

**Architecture:** 应用启动插件持有持久化 Scheduler Engine，普通 Panel 通过 Session 到 Application Runtime 的消息回退访问它。Engine 使用锚定时间计算、单一唤醒定时器、原子 JSON Store 和无 shell 子进程 Runner。

**Tech Stack:** Node.js 22、TypeScript、Harbors Plugin/Kit API、Vitest、jsdom、原生 CSS。

## Global Constraints

- 仅执行绝对路径 `.js`、`.mjs`、`.cjs`，使用 `process.execPath` 和 `shell: false`。
- 一次计划和固定间隔计划均存储绝对 ISO 时间；间隔范围为 60,000 至 31,536,000,000 ms。
- 超过计划时间 30,000 ms 为 misfire；策略仅为 `run-once` 或 `skip`。
- 循环补跑最多一次，后续时间锚定 `startAt`，不以实际完成时间漂移。
- 每个 stdout/stderr 保留末尾 65,536 bytes，历史最多 100 条。
- 桌面数据位于 `HARBORS_DATA_ROOT/kits/scheduler/state.v1.json`。
- 所有生产逻辑先写失败测试并确认因缺少行为而失败。
- Commit 标题使用 `[Feature] 中文摘要`，无结尾句号。

---

### Task 1: Application message fallback

**Files:**
- Modify: `packages/server/src/framework/message/index.ts`
- Modify: `packages/server/src/editor/index.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/tests/framework/message.test.ts`
- Test: `packages/server/tests/integration/application-message.test.ts`

**Interfaces:**
- Produces: `MessageModuleOptions.dispatchFallbackRequest(plugin, name, args): Promise<unknown>`
- Produces: `CreateEditorOptions.dispatchApplicationRequest(plugin, name, ...args): Promise<unknown>`
- Consumes: `ApplicationRuntime.request(plugin, method, ...args)`

- [ ] **Step 1: 写本地路由优先和缺失路由回退的失败测试**

```ts
const fallback = vi.fn(async () => 'application');
const message = new MessageModule({ dispatchFallbackRequest: fallback });
await expect(message.request('@kit/service', 'status')).resolves.toBe('application');
message.registerRequest('@kit/service', 'status', () => 'session');
await expect(message.request('@kit/service', 'status')).resolves.toBe('session');
expect(fallback).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: 运行测试并确认失败原因是无回退能力**

Run: `npx vitest run --config packages/server/vitest.config.ts packages/server/tests/framework/message.test.ts`

Expected: FAIL with `No request route registered`.

- [ ] **Step 3: 实现最小回退并把 Server Application Runtime 注入 Editor**

在 `MessageModule.request` 找不到本地 route 时调用：

```ts
if (!route && this.options.dispatchFallbackRequest) {
  return this.options.dispatchFallbackRequest(plugin, name, args);
}
```

`createApp` 创建 Editor 时传入：

```ts
dispatchApplicationRequest: (plugin, name, ...args) =>
  appOptions.applicationRuntime.request(plugin, name, ...args),
```

- [ ] **Step 4: 运行 Framework 与真实 Server 集成测试**

Run: `npx vitest run --config packages/server/vitest.config.ts packages/server/tests/framework/message.test.ts packages/server/tests/integration/application-message.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "[Feature] 打通应用插件消息回退"
```

### Task 2: 通用桌面数据根

**Files:**
- Modify: `scripts/lib/desktop-paths.mjs`
- Modify: `scripts/lib/desktop-paths.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `resolveDesktopPaths(...).dataRoot`
- Produces: `HARBORS_DATA_ROOT=<absolute Electron userData>`

- [ ] **Step 1: 写 dataRoot 路径和环境透传的失败测试**

```js
assert.equal(result.dataRoot, '/Users/me/Library/Application Support/ITHARBORS');
```

- [ ] **Step 2: 运行并确认旧桌面路径导致失败**

Run: `node --test scripts/lib/desktop-paths.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: FAIL because `dataRoot` and its environment mapping are absent.

- [ ] **Step 3: 更新 desktop paths 与 Electron 环境**

两种 Electron Framework 启动环境都加入：

```js
HARBORS_DATA_ROOT: desktopPaths.dataRoot,
```

- [ ] **Step 4: 运行相关 Node 测试**

Run: `node --test scripts/lib/desktop-paths.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add .gitignore scripts
git commit -m "[Feature] 提供 Kit 通用数据目录"
```

### Task 3: Schedule 与原子 Store

**Files:**
- Create: `kits/scheduler/plugins/scheduler-service/main/src/types.ts`
- Create: `kits/scheduler/plugins/scheduler-service/main/src/schedule.ts`
- Create: `kits/scheduler/plugins/scheduler-service/main/src/store.ts`
- Create: `kits/scheduler/plugins/scheduler-service/tests/schedule.test.ts`
- Create: `kits/scheduler/plugins/scheduler-service/tests/store.test.ts`
- Create: `kits/scheduler/vitest.config.ts`

**Interfaces:**
- Produces: `normalizeJobInput(input, now): NormalizedJobInput`
- Produces: `firstRunAt(schedule): number`
- Produces: `nextIntervalAfter(schedule, timestamp): number`
- Produces: `createSchedulerStore(filePath): SchedulerStore`
- `SchedulerStore` exposes `load(): Promise<SchedulerState>` and `save(state): Promise<void>`

- [ ] **Step 1: 写计划计算和状态文件行为的失败测试**

```ts
expect(nextIntervalAfter(
  { kind: 'interval', startAt: '2026-01-01T00:00:00.000Z', everyMs: 60_000 },
  Date.parse('2026-01-01T00:02:01.000Z'),
)).toBe(Date.parse('2026-01-01T00:03:00.000Z'));
await expect(store.load()).resolves.toEqual({ schemaVersion: 1, jobs: [], runs: [] });
```

- [ ] **Step 2: 运行并确认模块不存在**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-service/tests/schedule.test.ts kits/scheduler/plugins/scheduler-service/tests/store.test.ts`

Expected: FAIL resolving `schedule.ts` and `store.ts`.

- [ ] **Step 3: 实现严格校验、锚定时间与 temp+rename 原子写入**

`nextIntervalAfter` 使用：

```ts
const elapsed = Math.max(0, timestamp - start);
return start + (Math.floor(elapsed / everyMs) + 1) * everyMs;
```

Store 只接受精确 `schemaVersion: 1` 和合法 job/run 数组；不存在文件返回空状态，其他读取错误直接抛出。

- [ ] **Step 4: 运行 Schedule/Store 测试**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-service/tests/schedule.test.ts kits/scheduler/plugins/scheduler-service/tests/store.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add kits/scheduler/plugins/scheduler-service
git commit -m "[Feature] 实现调度计划与原子状态存储"
```

### Task 4: Node script runner

**Files:**
- Create: `kits/scheduler/plugins/scheduler-service/main/src/script-runner.ts`
- Create: `kits/scheduler/plugins/scheduler-service/tests/script-runner.test.ts`

**Interfaces:**
- Produces: `createScriptRunner(options?): ScriptRunner`
- `run(runId, scriptPath): Promise<ScriptRunResult>`
- `terminate(runId): Promise<void>`
- `dispose(): Promise<void>`

- [ ] **Step 1: 用真实临时脚本写成功、失败、截断与终止测试**

```ts
await writeFile(script, 'console.log("ok")');
await expect(runner.run('run-1', script)).resolves.toMatchObject({
  exitCode: 0,
  stdout: 'ok\n',
});
```

- [ ] **Step 2: 运行并确认 Runner 模块不存在**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-service/tests/script-runner.test.ts`

Expected: FAIL resolving `script-runner.ts`.

- [ ] **Step 3: 实现无 shell spawn、tail buffer 与两阶段终止**

```ts
spawn(process.execPath, [scriptPath], {
  cwd: path.dirname(scriptPath),
  env: process.env,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

- [ ] **Step 4: 运行 Runner 测试并检查无悬挂进程**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-service/tests/script-runner.test.ts`

Expected: PASS and Vitest exits normally.

- [ ] **Step 5: 提交**

```bash
git add kits/scheduler/plugins/scheduler-service
git commit -m "[Feature] 安全执行本地 Node 脚本"
```

### Task 5: Scheduler engine 与应用插件

**Files:**
- Create: `kits/scheduler/plugins/scheduler-service/main/src/scheduler.ts`
- Create: `kits/scheduler/plugins/scheduler-service/main/src/index.ts`
- Create: `kits/scheduler/plugins/scheduler-service/package.json`
- Create: `kits/scheduler/plugins/scheduler-service/tests/scheduler.test.ts`
- Create: `kits/scheduler/plugins/scheduler-service/tests/plugin-main.test.ts`

**Interfaces:**
- Produces: `createScheduler({ store, runner, clock }): Scheduler`
- `initialize()`, `dispose()`, `getSnapshot()`, `saveJob(input)`, `deleteJob(id)`, `setJobEnabled(id, enabled)`, `runJobNow(id)`
- Plugin messages use one request contribution named `scheduler` with the six methods above.

- [ ] **Step 1: 写正常触发、misfire 两策略、锚定无风暴、重叠、手动与恢复测试**

```ts
clock.set('2026-01-01T00:10:00.000Z');
await scheduler.initialize();
expect(runner.calls).toHaveLength(1);
expect(scheduler.getSnapshot().jobs[0].nextRunAt)
  .toBe('2026-01-01T00:11:00.000Z');
```

- [ ] **Step 2: 运行并确认 Engine 模块不存在**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-service/tests/scheduler.test.ts kits/scheduler/plugins/scheduler-service/tests/plugin-main.test.ts`

Expected: FAIL resolving `scheduler.ts`.

- [ ] **Step 3: 实现串行状态变更、单一 wake timer 和异步并行执行**

先持久化 `running` 记录与已推进的 `nextRunAt`，再启动 Runner；Runner 完成后以同一 run id 更新结果。每次状态变化后重新安排最近未来时间点。

- [ ] **Step 4: 运行 Service 全部测试**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-service/tests`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add kits/scheduler/plugins/scheduler-service
git commit -m "[Feature] 实现错过补偿调度引擎"
```

### Task 6: Scheduler Panel

**Files:**
- Create: `kits/scheduler/plugins/scheduler-panel/package.json`
- Create: `kits/scheduler/plugins/scheduler-panel/main/src/index.ts`
- Create: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.html`
- Create: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`
- Create: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css`
- Create: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

**Interfaces:**
- Consumes: `ctx.message.request('@itharbors/scheduler-service', method, ...args)`
- Produces: Panel `@itharbors/scheduler-panel.scheduler`

- [ ] **Step 1: 写真实 DOM 的快照、表单、动作、错误与卸载测试**

```ts
await panel.mount({ message: { request } });
expect(document.querySelector('main[aria-label="脚本调度工作台"]')).not.toBeNull();
expect(document.querySelector('[data-job-id="job-1"]')?.textContent).toContain('日报');
```

- [ ] **Step 2: 运行并确认 Panel 不存在**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Expected: FAIL resolving Panel module.

- [ ] **Step 3: 实现运行时刻表 UI 与响应式样式**

Panel 只使用 `textContent` 写入用户数据；日期输入转 ISO，间隔单位显式换算；编辑过程中轮询只更新背景快照，不清空当前表单。

- [ ] **Step 4: 运行 Panel 测试**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Expected: PASS with timer cleanup.

- [ ] **Step 5: 提交**

```bash
git add kits/scheduler/plugins/scheduler-panel
git commit -m "[Feature] 构建 Scheduler 时刻表界面"
```

### Task 7: Kit assembly、文档与验收

**Files:**
- Create: `kits/scheduler/package.json`
- Create: `kits/scheduler/kit.json`
- Create: `kits/scheduler/layout.json`
- Create: `kits/scheduler/main.html`
- Create: `kits/scheduler/secondary.html`
- Create: `kits/scheduler/vitest.config.ts`
- Create: `kits/scheduler/README.md`
- Create: `kits/scheduler/tests/kit-manifest.test.ts`
- Modify: `scripts/lib/kit-monorepo.mjs`
- Modify: `scripts/lib/kit-monorepo.test.mjs`
- Modify: `scripts/lib/kit-ci-selection.test.mjs`
- Modify: `registry/policy.json`
- Modify: `scripts/check-kit.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/guides/developing-plugins-and-kits.md`

**Interfaces:**
- Produces: official `@itharbors/kit-scheduler` version `0.1.0-preview.1`
- Startup plugin: `@itharbors/scheduler-service`
- Session plugin: `@itharbors/scheduler-panel`
- Produces: official slug `scheduler` with runner `ubuntu-latest`

- [ ] **Step 1: 写 manifest、布局、权限、官方集合和 CI 选择失败测试**

```ts
expect(manifest['ce-editor'].kit.startup.plugins)
  .toEqual(['@itharbors/scheduler-service']);
expect(layout.windows[0].layout.panel)
  .toBe('@itharbors/scheduler-panel.scheduler');
expect(kit.permissions).toEqual([
  'application-startup', 'filesystem', 'native-code',
]);
assert.deepEqual(OFFICIAL_KIT_SLUGS, [
  'csv', 'mysql', 'notifications', 'scheduler', 'sqlite',
]);
assert.deepEqual(selectKitSlugs(['kits/scheduler/package.json']), ['scheduler']);
```

- [ ] **Step 2: 运行并确认 Kit 根文件不存在**

Run: `npx vitest run --config kits/scheduler/vitest.config.ts kits/scheduler/tests/kit-manifest.test.ts`

Expected: FAIL loading manifests.

- [ ] **Step 3: 创建 Kit 根文件、Registry entry、官方集合、README 和根锁文件**

Registry entry:

```json
"scheduler": {
  "id": "@itharbors/kit-scheduler",
  "label": "Scheduler",
  "summary": "本地 Node.js 脚本的定时、循环与错过触发管理",
  "runner": "ubuntu-latest"
}
```

Run: `npm install --package-lock-only`

Expected: lockfile contains `kits/scheduler` with matching name/version.

- [ ] **Step 4: 构建插件并运行完整 Kit 检查**

Run:

```bash
npm test -w @itharbors/kit-scheduler
npm run build -w @itharbors/kit-scheduler
node scripts/ce-plugin.mjs check kits/scheduler/plugins/scheduler-service
node scripts/ce-plugin.mjs check kits/scheduler/plugins/scheduler-panel
npm run kit:check -- scheduler --output-directory "$PWD/dist/scheduler-kit-check"
```

Expected: all commands exit 0 and produce a verified `.hkit`.

- [ ] **Step 5: 浏览器走查并提交**

Run: `npm run dev:web -- --kit ./kits/scheduler`

检查创建一次计划、创建循环计划、暂停/恢复、手动运行、失败输出、两种错过策略和窄屏布局。

```bash
git add kits/scheduler package-lock.json docs/guides/developing-plugins-and-kits.md
git commit -m "[Feature] 完成 Scheduler Kit 集成"
```

### Task 8: 最终回归

**Files:**
- Review: all files changed since `origin/main`

- [ ] **Step 1: 对照设计逐项检查需求和安全边界**

确认应用级运行、两种计划、两种 misfire、无补跑风暴、无 shell、原子持久化、历史与界面全部有测试保护。

- [ ] **Step 2: 运行格式、构建、相关测试与 Kit gate**

Run:

```bash
npm run build
npm test -w packages/server
npm test -w @itharbors/kit-scheduler
node --test scripts/lib/desktop-paths.test.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-ci-selection.test.mjs
npm run kit:check -- scheduler --output-directory "$PWD/dist/scheduler-final-check"
git diff --check origin/main...HEAD
```

Expected: every command exits 0, no test failures, no whitespace errors.

- [ ] **Step 3: 审阅最终差异和工作区**

Run: `git status --short --branch && git diff --stat origin/main...HEAD`

Expected: only Scheduler、通用消息桥、通用 data root、官方登记和对应文档发生变化；工作区干净。
