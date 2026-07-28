# Kit 热更新与在线卸载设计

## 目标

Kit Manager 中的安装、更新、启用、回滚和删除操作完成后立即反映到正在运行的桌面应用，不要求用户退出或重新启动 Electron。

本设计中的“无需重启”是指 Electron 主进程、托盘和 Kit Manager 窗口不退出、不调用 `app.relaunch()`。为安全释放普通插件、application startup 插件和原生模块，Electron 可以在后台受控停止并重新启动 Framework 子进程；现有 Kit 窗口在新运行时就绪后自动重新加载。

## 用户体验

### 安装与更新

- 用户点击“安装”或“安装更新”后，Manager 下载并验证不可变 Kit 制品。
- 制品安装成功后自动成为目标版本，不再要求第二次点击“重启后启用”。
- Manager 显示“正在应用”，Framework 完成热重载后卡片显示“已启用”。
- 已打开的 Kit 窗口保留 BrowserWindow 外壳、位置和尺寸，在新 Framework 就绪后重新加载内容。
- 操作前提示所有 Kit 窗口会重新加载，页面中未持久化的状态可能丢失。含原生代码的 Kit 继续显示更高风险确认。

### 启用与回滚

- 已安装的其他版本可以立即启用。
- 回滚到 previous 版本也通过同一热重载事务立即完成。
- 成功结果统一返回 `requiresRestart: false` 和 `runtimeReloaded: true`。

### 删除

- 每个已安装 Kit 只显示一个“删除 Kit”操作；Stable 卡片优先承载该操作，没有 Stable 卡片时由 Preview 卡片承载。
- 删除操作移除该 Kit 的全部已安装版本，不允许删除 builtin Kit。
- 被删除 Kit 的窗口在确认后关闭且不恢复；其他 Kit 窗口在 Framework 热重载后自动重新加载。
- Kit 从 Catalog、托盘和 Manager 的已安装投影中立即消失；若 Registry 仍提供该 Kit，卡片回到“可安装”。
- 物理文件只在新 Framework 已成功脱离该 Kit 后删除。

## 方案选择

采用“Electron 常驻 + Framework 受控热重载”。不采用完全进程内替换，因为 Node 模块缓存、原生 addon、application startup 插件、跨 Session 注册项和插件自身外部副作用无法在当前模型中可靠原子回滚。不采用每 Kit 独立进程，因为它需要重构共享 Framework、菜单、消息和 Session 路由，超出本目标。

## 架构

### 运行时协调器

新增独立、可测试的 Kit 运行时协调器，由 Electron main process 拥有。它将所有 Kit 状态变更放入一个全局串行队列，并通过窄适配器调用以下能力：

1. 保存所有打开 Kit 窗口的边界和 Kit 名称；
2. 对删除目标关闭窗口，对其他窗口标记为等待重新加载；
3. 关闭 Application Runtime 事件客户端并优雅停止 Framework；
4. 从 Installed Store 重新计算 active sources、Catalog 和不可变 `kitSources`；
5. 使用新 `HARBORS_KIT_SOURCES` 启动 Framework；
6. 用真实 Application Runtime 与一次性 disposable Session 验证新版本；
7. 提交状态事务，刷新托盘、菜单和 Manager 投影；
8. 重新加载仍存在的 Kit 窗口。

Notification Host 和 Kit Manager 属于 Electron application scope，在 Framework 热重载期间保持运行。`startFrameworkAndTrackReadiness` 需要拆分通知服务启动与 Framework 启动，避免热重载时重复绑定 Notification Host 端口。

协调器不直接下载制品、不解析 Renderer 输入，也不直接删除任意路径。它只接收已经过 Manager、IPC 和 Store 校验的 Kit ID 与版本。

### Manager 服务边界

Registry Manager 继续负责 Registry 读取、制品解析、证明验证、下载和不可变安装。新增 live Manager facade 组合 Registry Manager、Installed Store、Uninstaller 与运行时协调器：

- `install(input)`：完成制品安装，设置目标版本，再执行热重载；
- `activate(input)`：设置目标版本并执行热重载；
- `rollback(id)`：设置 previous 为目标版本并执行热重载；
- `uninstall(id)`：暂存删除意图，执行热重载，成功后删除受控文件并提交状态；
- `list()` 与 `refresh()` 保持现有行为。

IPC 新增固定 `uninstall` channel，只接受一个合法 Kit ID。Preload 只新增 `uninstall(id)`，Renderer 仍不能提交路径、URL、摘要或删除范围。

### Installed Store 删除事务

`installed.json` 的 Kit record 新增可选 `pendingUninstall: true`。状态规则如下：

- `stageUninstall(id)` 只允许已安装且非 builtin 的 Kit，设置 `pendingUninstall`；
- `listActiveSources()` 忽略 `pendingUninstall` record，使下一次 Framework 启动不再加载它；
- 新 Framework 成功后 `pendingUninstallDirectories(id)` 返回每个版本的受控目录列表；全部目录删除成功后 `commitUninstall(id)` 才原子移除 record；
- Framework 启动失败时 `cancelUninstall(id)` 恢复旧投影，并用旧 source snapshot 再次启动 Framework；
- 应用在 staged 状态崩溃时，下次启动继续排除该 Kit，验证新 Runtime 后完成删除；不把半删除 Kit 再次加载进进程。

Uninstaller 只能删除 Store 返回且位于规范化 `kits/<encoded-id>/<version>` 根下的目录；拒绝符号链接、根目录、Store 外路径和身份不匹配。单个目录清理失败时保留 `pendingUninstall` record 并记录审计，Kit 继续从 active sources 隐藏；后续启动或显式重试继续清理。已经不存在的版本目录按幂等成功处理。

### Framework 热重载状态机

```text
idle
  -> preparing
  -> stopping
  -> starting
  -> validating
  -> committing
  -> reloading-windows
  -> idle
```

任意时刻只允许一个事务。Manager IPC 在事务完成前保持 Promise pending，Renderer 使用现有 busy 状态禁用所有操作按钮。

Framework stop 必须等待所有 Session `Editor.dispose()`、application plugin `unload` 和 HTTP drain 完成。完成后清空旧的 `frameworkProcess`、`frameworkStop`、`frameworkStopPromise`、`frameworkReadyPromise` 与 Application Runtime client，避免第二次启动复用已完成 Promise。

窗口重载使用稳定 workspace session ID 和更新后的 Kit directory URL。更新目标与其他仍存在的 Kit 窗口调用 `loadURL` 重新 bootstrap；删除目标窗口关闭。窗口尺寸由现有 WorkspaceStore 保留。

## 成功与失败事务

### 安装、更新、启用和回滚

1. 安装制品或选择已安装目标版本；
2. Store 设置 `pending`；
3. Framework 使用 staged active source 启动；
4. Catalog 与真实 Runtime 验证成功后 `commitActivation`；
5. 刷新托盘并重新加载窗口；
6. 返回无需重启的成功结果。

若目标版本 Catalog 或 Runtime 验证失败，沿用 `failActivation`：标记 bad version，并把 previous 设为 recovery pending。协调器最多再执行一次恢复热重载。恢复成功后 Manager 返回目标版本失败的明确错误，旧版本继续运行；恢复也失败时进入安全降级状态，不宣称操作成功。

### 删除

1. Store 设置 `pendingUninstall`；
2. 关闭目标窗口并用排除目标的 sources 热重载 Framework；
3. 新 Runtime 成功后删除 Store 返回的全部受控版本目录；
4. 目录删除完成后从 Store 原子移除 record；
5. 刷新 Catalog 与托盘；
6. 重新加载其他窗口并返回成功。

若排除目标后的 Runtime 无法启动，取消 staged uninstall，用旧 sources 恢复 Framework，保留 Store 与文件。只有恢复成功后才向 Manager 返回可重试失败；恢复失败进入安全降级状态。

## Catalog 与窗口一致性

每次热重载必须重新调用与桌面启动相同的 `discoverKits` 路径，不能增量修改旧 Catalog。生成的新 `kitCatalog`、`installedKits` 和 `kitSources` 只在 Framework 启动与验证成功后整体替换。

热重载期间菜单动作暂停分发。新 Application Runtime bootstrap 到达后重建 application menu tree、托盘和 Session 菜单投影。旧 Session 菜单在窗口重新加载前清空，避免向已停止 Framework 发送动作。

## UI 文案

- `重启后启用` 改为 `立即启用`；
- 安装新 Kit 显示 `正在安装…`，随后显示 `正在应用…`；
- 更新显示 `正在安装更新…` 与 `正在应用更新…`；
- 删除按钮为 `删除 Kit`，确认文案明确“将关闭该 Kit 窗口并删除全部已安装版本”；
- 热重载成功显示 `已安装并启用…`、`已更新并启用…`、`已删除…`；
- 失败区分下载/验证失败、Runtime 应用失败、旧版本恢复失败和文件清理失败；
- 不再展示“重启后生效”或 `requiresRestart=true` 成功状态。

## 并发与退出

- 下载、安装、启用、回滚、删除共用一个运行时事务队列；同一 Kit 的 Registry 队列继续保留。
- 用户退出 Electron 时，现有 before-quit gate 等待 Manager IPC drain 和当前热重载事务结束，再停止服务。
- 热重载期间若收到退出请求，不启动新的窗口重载；完成当前 Store 事务后进入正常退出。
- 后台 Registry refresh 不触发 Runtime 热重载，只有用户发起的状态变更才会应用。

## 安全边界

- 下载、证明、摘要、兼容性、原生代码风险确认保持现有强度；热更新不得绕过验证。
- Framework 子进程是唯一加载 Kit JavaScript 和 native addon 的进程；通过进程替换清空模块缓存。
- Renderer 永远不能控制 Framework 命令、环境变量、目录或删除路径。
- 删除不使用未解析环境变量、glob 或宽目录；所有目标必须来自已持久化、再次校验的版本记录。
- builtin、development 和 explicit sources 不由 Manager 删除。

## 测试与验收

### Store 与文件

- staged uninstall 从 active sources 隐藏目标；commit、cancel 与崩溃恢复状态正确；
- 删除全部版本但不影响其他 Kit；
- Store 外路径、符号链接、目录身份漂移和重复调用全部 fail closed；
- 文件清理失败可审计、可重试且不会恢复已删除 Kit。

### 协调器

- 安装新 Kit、更新 active Kit、启用其他版本和回滚均只热重载 Framework，不调用 Electron relaunch；
- 更新目标窗口与其他窗口重新加载，删除目标窗口关闭；
- Catalog、source snapshot、Application Runtime、托盘和菜单在事务后属于同一代；
- 并发操作串行；Framework stop/start Promise 不跨代复用；
- 目标版本失败自动恢复 previous；删除启动失败取消删除并恢复旧 Runtime；恢复失败报告降级。

### Manager、IPC 与视图

- install/update 自动启用，结果 `requiresRestart=false`；
- uninstall 输入严格、sender ownership 不变、preload bridge 保持窄接口；
- 页面按钮、确认、busy 状态和成功/失败文案符合中文交互；
- builtin 无删除按钮，每个已安装 Kit 只有一个删除按钮。

### 端到端

使用临时 Store 与可发布 fixture Kit 启动真实 Electron/Framework：

1. Manager 安装新 Kit 后不退出 Electron，Tray 与 Server Catalog 立即出现该 Kit，窗口可打开；
2. 安装更高版本后同一窗口外壳重新加载，Server Catalog 与窗口资源来自新版本；
3. 删除 Kit 后目标窗口关闭、Tray 与 Server Catalog 立即移除、目录清理完成；
4. 注入新版本 Runtime load 失败，验证旧版本自动恢复且 Electron 仍运行；
5. 全流程断言未调用 `app.relaunch()`，没有要求用户重启。

最后运行相关单元/集成测试、`CI=1 npm run check`，并在开发 Electron 中实际走查安装、更新和删除操作。
