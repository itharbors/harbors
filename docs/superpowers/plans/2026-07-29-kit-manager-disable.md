# Kit Manager Deactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外部 Kit 在不删除任何已安装版本的前提下即时停用，并可从 Manager 重新启用最后使用的版本。

**Architecture:** 新增独立 `deactivate(id)` 调用，从 Renderer 经窄 IPC 进入 Live Kit Manager，再由 Runtime Coordinator 串行执行 Electron Framework generation 替换。Store 用原子状态转换清除 `active` 并把原版本保存在 `previous`；运行时替换失败时恢复该版本和窗口。

**Tech Stack:** Node.js ESM、Electron IPC/preload、JSDOM、`node:test`、现有 Framework generation 与 InstalledKitStore。

## Global Constraints

- 停用保留所有版本、异常标记、通道和自动更新设置，不调用 artifact uninstaller。
- 内置 Kit 不提供停用。
- IPC 只接受一个符合 scoped package 规则的 Kit ID。
- 停用、启用和删除共享同一个 FIFO Runtime Coordinator。
- 成功与失败均无需应用重启；失败必须恢复旧 Runtime 与目标窗口。
- 所有生产改动严格遵循 RED → GREEN，并使用 `[Bug] 中文摘要` 提交。

---

### Task 1: Store 停用状态与 Runtime FIFO

**Files:**
- Modify: `scripts/lib/kit-store/state.mjs`
- Test: `scripts/lib/kit-store/state.test.mjs`
- Modify: `scripts/lib/kit-runtime-coordinator.mjs`
- Test: `scripts/lib/kit-runtime-coordinator.test.mjs`

**Interfaces:**
- Produces: `InstalledKitStore.deactivate(id): Promise<{ id, version }>`
- Produces: `coordinator.applyDeactivation(id): Promise<object>`
- Consumes: 现有 `#mutateRecord`、`applyActivation` 与 `applyUninstall` 队列语义。

- [ ] **Step 1: 写 Store 失败测试**

```js
test('deactivates an active Kit while retaining every installed version', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.recordInstalled(installed('2.0.0'));
  await store.activate(id, '2.0.0');

  assert.deepEqual(await store.deactivate(id), { id, version: '2.0.0' });
  const record = (await store.snapshot()).kits[id];
  assert.equal(record.active, undefined);
  assert.equal(record.pending, undefined);
  assert.equal(record.previous, '2.0.0');
  assert.deepEqual(Object.keys(record.versions).sort(), ['1.0.0', '2.0.0']);
  assert.deepEqual(await store.listActiveSources(), []);
  await assert.rejects(store.deactivate(id), /not active/i);
});
```

- [ ] **Step 2: 验证 Store 测试因缺少 `deactivate` 失败**

Run: `node --test scripts/lib/kit-store/state.test.mjs`

Expected: FAIL，错误包含 `store.deactivate is not a function`。

- [ ] **Step 3: 实现最小 Store 转换**

```js
async deactivate(id) {
  return this.#mutateRecord(id, (record) => {
    if (!record.active) throw new Error(`Kit ${id} is not active`);
    const version = record.active;
    record.previous = version;
    delete record.active;
    delete record.pending;
    return { id, version };
  });
}
```

- [ ] **Step 4: 写 Coordinator 失败测试并扩展现有 FIFO 断言**

在 adapter 中加入 `applyDeactivation(id)`，在 activation gate 后依次提交 deactivation 与 uninstall，并断言事件顺序为 activation end → deactivation → uninstall。另在 dispose 测试中断言 `applyDeactivation` 被拒绝。

- [ ] **Step 5: 验证 Coordinator 测试因缺少方法失败**

Run: `node --test scripts/lib/kit-runtime-coordinator.test.mjs`

Expected: FAIL，错误指向缺少 `applyDeactivation` 或 coordinator 方法。

- [ ] **Step 6: 实现 FIFO 方法并跑绿**

```js
requireMethod(adapters, 'applyDeactivation');
// returned object
applyDeactivation(id) {
  return enqueue(() => adapters.applyDeactivation(id));
},
```

Run: `node --test scripts/lib/kit-store/state.test.mjs scripts/lib/kit-runtime-coordinator.test.mjs`

Expected: PASS。

- [ ] **Step 7: 提交状态层**

```bash
git add scripts/lib/kit-store/state.mjs scripts/lib/kit-store/state.test.mjs scripts/lib/kit-runtime-coordinator.mjs scripts/lib/kit-runtime-coordinator.test.mjs
git commit -m "[Bug] 支持停用已安装 Kit"
```

### Task 2: Live Manager 与窄 IPC

**Files:**
- Modify: `scripts/lib/live-kit-manager.mjs`
- Test: `scripts/lib/live-kit-manager.test.mjs`
- Modify: `scripts/lib/kit-manager-ipc.mjs`
- Test: `scripts/lib/kit-manager-ipc.test.mjs`
- Modify: `scripts/kit-manager-preload.cjs`
- Test: `scripts/lib/kit-manager-preload.test.mjs`

**Interfaces:**
- Consumes: `coordinator.applyDeactivation(id)` from Task 1。
- Produces: `live.deactivate(id)` 与 preload `window.harborsKitManager.deactivate(id)`。
- Produces: `KIT_MANAGER_CHANNELS.deactivate = 'harbors:kit-manager:deactivate'`。

- [ ] **Step 1: 写 Live Manager 失败测试**

扩展 coordinator fixture：

```js
async applyDeactivation(id) {
  calls.push(['applyDeactivation', id]);
  return { id, version: '1.0.0', runtimeReloaded: true };
}
```

断言 `live.deactivate('@example/kit-demo')` 返回 `requiresRestart: false`，并断言内置与非法 ID 被拒绝。

- [ ] **Step 2: 验证 Live Manager 测试失败**

Run: `node --test scripts/lib/live-kit-manager.test.mjs`

Expected: FAIL，错误包含 `live.deactivate is not a function`。

- [ ] **Step 3: 实现 Live Manager 路由**

构造时要求 coordinator 同时提供 `applyActivation`、`applyDeactivation`、`applyUninstall`；新增：

```js
async deactivate(value) {
  const id = kitId(value);
  if (builtin.has(id)) throw new Error(`Kit ${id} is built into Harbors`);
  return liveResult(await coordinator.applyDeactivation(id), { includePending: false });
},
```

- [ ] **Step 4: 写 IPC 与 preload 失败测试**

将固定操作数量从六改为七，断言：

```js
await ipcMain.handlers.get(KIT_MANAGER_CHANNELS.deactivate)(event(), '@example/demo');
await exposed.value.deactivate('@example/demo');
```

并为对象、额外参数和非法路径输入断言 `INVALID_INPUT`。

- [ ] **Step 5: 验证 IPC/preload 测试失败**

Run: `node --test scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs`

Expected: FAIL，缺少 deactivate channel/API。

- [ ] **Step 6: 实现固定通道与桥接并跑绿**

在 IPC 的 channel map 与 operations map 中新增 `deactivate`，复用单 ID parser；preload channel map 与 exposed API 同步新增 `deactivate(value)`。

Run: `node --test scripts/lib/live-kit-manager.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs`

Expected: PASS。

- [ ] **Step 7: 提交接口层**

```bash
git add scripts/lib/live-kit-manager.mjs scripts/lib/live-kit-manager.test.mjs scripts/lib/kit-manager-ipc.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/kit-manager-preload.cjs scripts/lib/kit-manager-preload.test.mjs
git commit -m "[Bug] 暴露 Kit 停用操作"
```

### Task 3: Electron Runtime 停用与故障恢复

**Files:**
- Create: `scripts/lib/kit-live-deactivation.mjs`
- Test: `scripts/lib/kit-live-deactivation.test.mjs`
- Modify: `scripts/electron.mjs`
- Test: `scripts/lib/kit-manager-acceptance.test.mjs`

**Interfaces:**
- Consumes: `kitStore.deactivate(id)`、`kitStore.activate(id, version)`、`replaceFrameworkForKitMutation(operation)`。
- Produces: `createLiveKitDeactivation(adapters)` 返回 `applyLiveKitDeactivation(id): Promise<{ id, version, runtimeReloaded: true }>`。
- Produces: `restoreLiveKitDeactivation(operation, adapters)`，供普通失败与 Framework recovery 共用。
- Extends operation union with `{ kind: 'deactivation', id, version, reopenOnFailure }`。

- [ ] **Step 1: 写可执行的停用事务失败测试**

使用真实 `InstalledKitStore`，仅注入 Framework 替换与窗口边界。覆盖两条行为：成功时 Store 无 active、窗口关闭且不重开；替换失败时 Store 恢复原 active、窗口重开且原错误继续抛出。

- [ ] **Step 2: 验证事务测试因模块缺失失败**

Run: `node --test scripts/lib/kit-live-deactivation.test.mjs`

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现可注入停用事务并接入 Electron**

```js
export function createLiveKitDeactivation({ store, closeWindow, replaceFramework, openWindow, isQuitting }) {
  return async function applyLiveKitDeactivation(id) {
    const { version } = await store.deactivate(id);
    const operation = { kind: 'deactivation', id, version, reopenOnFailure: closeWindow(id) };
    try {
      await replaceFramework(operation);
    } catch (error) {
      await restoreLiveKitDeactivation(operation, { store, openWindow, isQuitting });
      throw error;
    }
    return { id, version, runtimeReloaded: true };
  };
}

export async function restoreLiveKitDeactivation(operation, { store, openWindow, isQuitting }) {
  const record = (await store.snapshot()).kits[operation.id];
  if (record && !record.active) await store.activate(operation.id, operation.version);
  if (operation.reopenOnFailure && !isQuitting()) await openWindow(operation.id);
}
```

Electron 构造函数注入现有依赖：

```js
const applyLiveKitDeactivation = createLiveKitDeactivation({
  store: kitStore,
  closeWindow: (id) => closeKitWindow(kitWindows, id),
  replaceFramework: (operation) => replaceFrameworkForKitMutation(operation),
  openWindow: (id) => openKit(id),
  isQuitting: () => quitting,
});
```

`recoverFrameworkMutation` 的 deactivation 分支在构建 recovery generation 前调用 `restoreLiveKitDeactivation`。普通 build failure 由外层 catch 恢复；launch failure 由 recovery 分支恢复。

在 `recoverFrameworkMutation` 的 deactivation 分支中先恢复旧 active，再构建恢复 generation；成功恢复后重新打开目标窗口。`removedKitId` 仍只用于 uninstall。

- [ ] **Step 4: 扩展 acceptance 为安装 → 停用 → 重启用 → 切换 → 删除**

Acceptance harness coordinator 增加 `applyDeactivation`，使用 Store 的 deactivate/activate 和现有 generation reload fixture。停用后断言 `active` 缺失、版本目录仍存在、Manager projection 仍列出全部版本；重新启用后断言 active 恢复。

- [ ] **Step 5: 运行 Electron 与 acceptance 测试**

Run: `node --test scripts/lib/kit-live-deactivation.test.mjs scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: PASS。

- [ ] **Step 6: 提交 Runtime 层**

```bash
git add scripts/lib/kit-live-deactivation.mjs scripts/lib/kit-live-deactivation.test.mjs scripts/electron.mjs scripts/lib/kit-manager-acceptance.test.mjs
git commit -m "[Bug] 即时卸载已停用 Kit"
```

### Task 4: Manager 停用交互与最终验证

**Files:**
- Modify: `scripts/lib/kit-manager-view.mjs`
- Test: `scripts/lib/kit-manager-view.test.mjs`
- Modify: `.superpowers/kit-manager-production-preview.html`（忽略的本地验收夹具，不提交）

**Interfaces:**
- Consumes: `api.deactivate(id)` from Task 2。
- Produces: active owner row 的 `data-action="deactivate"`；停用 owner row 的版本按钮文案 `启用此版本`。

- [ ] **Step 1: 写 View 失败测试**

给 fixture API 增加 deactivate spy，测试已启用 owner row：

```js
const deactivateButton = stable.querySelector('[data-action="deactivate"]');
assert.equal(deactivateButton.textContent, '停用');
deactivateButton.click();
await value.view.whenIdle();
assert.deepEqual(calls, [['deactivate', '@itharbors/kit-sqlite']]);
assert.match(confirmations[0], /保留全部已安装版本/);
assert.match(operationStatus.textContent, /已停用/);
```

刷新后的 projection 不含 active、含 `previous`，断言下拉选中 previous，按钮为“启用此版本”。

- [ ] **Step 2: 验证 View 测试失败**

Run: `node --test scripts/lib/kit-manager-view.test.mjs`

Expected: FAIL，API contract 或 DOM 缺少 deactivate。

- [ ] **Step 3: 实现 View 行为**

要求 API 包含 deactivate；`preferredInstalledVersion` 顺序改为 active → pending → previous → newest。新增 confirm/queue/reload 操作：

```js
async function deactivate(kit) {
  const accepted = await confirmInstall(
    `停用 ${kit.label ?? kit.id} 将关闭该 Kit 窗口并重新加载其他 Kit 窗口；全部已安装版本会保留。是否继续？`,
  );
  if (!accepted) return;
  await api.deactivate(kit.id);
  await reloadInstalledProjection();
  setOperationMessage(`已停用 ${kit.label ?? kit.id}。`);
}
```

active owner row 在 actions 中显示 secondary “停用”；没有 active 时版本按钮显示“启用此版本”，有 active 且选择其他版本时仍显示“切换到此版本”。

- [ ] **Step 4: 运行 Manager 全套专项测试**

Run: `node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-window.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs scripts/lib/live-kit-manager.test.mjs scripts/lib/kit-runtime-coordinator.test.mjs scripts/lib/kit-store/state.test.mjs scripts/lib/kit-manager-acceptance.test.mjs`

Expected: PASS。

- [ ] **Step 5: 更新本地网页夹具并走查**

让 preview API 实现 `deactivate(id)`，点击 CSV 的“停用”，确认状态变为“已安装”、文件版本仍为三个、按钮变为“启用此版本”；再次启用并确认恢复。检查 620px 无横向溢出和浏览器 warning/error 为零。

- [ ] **Step 6: 提交界面层**

```bash
git add scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m "[Bug] 增加 Kit 停用入口"
```

- [ ] **Step 7: 运行完整仓库验证并重启 Electron**

Run: `CI=1 npm run check`

Expected: exit 0。随后重启 `npm run electron`，确认 48380–48383 监听并交给用户验收。
