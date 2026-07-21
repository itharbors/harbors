# Kit 懒加载与托盘切换设计

## 背景

Electron 多 Kit 工作台当前在启动时调用 `prewarmKitWindows()`：它为目录中的每个 Kit
创建 workspace 和 `BrowserWindow`，执行 `loadURL()`，最后显示第一个成功加载的窗口。系统托盘
在全部预热完成后才创建。

这一流程导致三个直接问题：用户看不到明确的 Kit 选择入口；无参数启动会自动打开目录中的
第一个 Kit；所有 Kit 都在尚未被选择时创建 session 并装载插件、Panel 和菜单。

## 目标

1. 无参数启动只创建系统托盘，不打开默认 Kit 窗口。
2. 托盘菜单列出所有可用 Kit；选择一个 Kit 即打开或聚焦它，从而提供明确的切换入口。
3. Kit 严格按需加载：只有用户首次选择它时，才创建 workspace、session、窗口并请求 Kit 页面。
4. 保留各 Kit 独立窗口、稳定 session、窗口 bounds 和运行时隔离。
5. 保留显式 `--kit <name-or-path>` 直达行为；该参数代表用户已经作出选择。

本文中的“任务栏图标”统一落实为 Electron `Tray`：macOS 显示在菜单栏状态区，Windows 和
Linux 显示在系统托盘区域。

## 方案选择

采用“托盘目录 + 独立懒加载窗口”。托盘是 application scope 的 Kit 目录；Kit 窗口仍按
Kit 隔离。相比单窗口热切换，这一方案不需要卸载当前窗口中的插件和 UI 状态，也允许用户
并行使用多个 Kit。相比新增选择器窗口，它满足启动时不显示内容窗口的要求。

## 启动流程

### 无参数多 Kit 模式

1. Electron ready 后解析参数并扫描 Kit manifest。扫描只读取静态元数据，不装载 Kit。
2. 创建 `WorkspaceStore`，仅通过 `list()` 读取已有记录，以便标记已移除的 Kit；不得调用
   `getOrCreate()`。
3. 创建 Tray 和上下文菜单，使 Kit 选择入口尽快可用。
4. 启动 Web framework，并用一个共享 readiness promise 跟踪 Gateway 就绪状态。
5. 启动流程到此结束，不创建 `BrowserWindow`，不创建新 workspace/session，不执行
   `createKitWindowUrl()` 或 `loadURL()`。

Tray 必须早于 Gateway readiness 完成而可见。用户在服务就绪前选择 Kit 时，选择操作等待
同一个 readiness promise；界面不会创建一个注定加载失败的空窗口。

### 显式单 Kit 模式

`--kit` 仍先创建 Tray，再启动 framework。Gateway 就绪后自动执行一次该 Kit 的打开操作。
因此显式选择保留直达体验，同时所有加载仍经过统一的按需路径。

### 应用激活

macOS Dock 激活或等价的 `app.activate` 不再选择目录中的第一个 Kit。应用只弹出 Tray 菜单；
如果平台不允许主动弹出，则保持驻留，等待用户从 Tray 选择。

## Kit 选择与加载流程

Tray 的可用 Kit 条目直接调用 `openKit(kitName)`。选择语义如下：

1. 已存在且未销毁的窗口：必要时 restore，然后 show、focus；不重新加载 Kit。
2. 尚未加载的 Kit：等待 Gateway ready，调用 `WorkspaceStore.getOrCreate()` 获取稳定
   sessionId，创建隐藏窗口并执行 `loadURL()`；加载成功后 show、focus。
3. 正在加载的 Kit：复用同一个进行中 promise。快速双击或多个入口同时选择时只创建一个
   workspace 和一个窗口。
4. 已关闭的 Kit：窗口注册表已移除，再次选择时复用持久 workspace/sessionId 创建新窗口。

`kitWindows` 只保存已经成功创建的窗口；新增 `kitWindowLoads` 保存每个 Kit 的进行中创建
promise。promise 无论成功或失败都从 `kitWindowLoads` 清理，避免失败后永久无法重试。

选择另一个 Kit 不销毁当前 Kit。它会打开或聚焦另一个独立窗口，这就是本次定义的“切换”。

## 菜单与运行时状态

Tray 菜单始终来自静态 Kit catalog，因此未加载 Kit 也可选择。已持久化但当前不存在的 Kit
继续显示为禁用的 `Unavailable` 条目。

应用菜单只聚合已经加载并完成 `ce:menu-sync` 的 session。未使用的 Kit 没有 session 菜单，
也不会为了填充应用菜单而被预加载。首次加载新 Kit 并同步菜单后，现有多 Kit 菜单组合逻辑
自动纳入该 session。

Tray 的单击事件在支持的平台调用 `popUpContextMenu()`；标准右键上下文菜单仍保留。这样 Kit
列表既可发现，也兼容各桌面平台习惯。

## 错误处理与退出

- Kit 加载失败时销毁半创建窗口、清除进行中 promise 并记录错误；Tray 和其他 Kit 保持可用，
  用户可以再次选择重试。
- Framework 启动失败时沿用应用退出行为，因为此时任何 Kit 都无法工作。
- 退出时只持久化实际存在且未销毁的 Kit 窗口 bounds；从未加载的 Kit 不产生新记录。
- `window-all-closed` 继续不退出应用，生命周期由 Tray 管理。

## 代码边界

- `scripts/electron.mjs`：负责启动顺序、framework readiness、Tray 事件、Kit 窗口注册表和
  Electron 生命周期；删除全量预热路径。
- `scripts/lib/electron-launcher.mjs`：保留可独立测试的参数、Tray template、URL 和窗口
  open/focus helper；扩展 helper 以对同一 Kit 的并发首次打开去重。
- `scripts/lib/electron-launcher.test.mjs`：覆盖启动契约、Tray 选择、并发首次打开、失败重试和
  已加载窗口聚焦。
- `docs/architecture/*` 与 `docs/guides/development-workflow.md`：把“预热全部 Kit”改为“Tray
  选择后按需加载”，并说明切换方式。

不引入新的 renderer 页面、IPC channel、持久化格式或 Server API。

## 测试策略

严格执行 RED → GREEN：

1. 增加启动源码契约测试，证明无参数启动不再调用预热函数，Tray 在任何自动打开操作之前
   创建，且只有 `requestedKit` 存在时才自动调用 `openKit()`。
2. 扩展窗口 helper 测试，两个并发的首次选择必须只调用一次创建函数并返回同一个窗口。
3. 增加失败重试测试，第一次创建失败后第二次选择必须重新调用创建函数并成功打开。
4. 保留并扩展已有测试，证明现有窗口仍只执行 restore/show/focus。
5. 运行 Electron launcher focused tests、Client/Server 测试、插件检查和根 `npm run check`。

其中源码契约测试只验证启动接线，窗口 helper 测试验证懒加载去重的行为。两类证据结合，避免
仅凭源码文本或仅凭孤立 helper 推断完整启动行为。

## 验收标准

1. `npm run dev` 启动完成后存在 Tray，`BrowserWindow.getAllWindows()` 为空，且没有新 Kit
   workspace/session 记录。
2. Tray 明确列出 Default、SQLite 和 MySQL；选择条目可在它们之间打开或聚焦。
3. 首次选择一个 Kit 只创建该 Kit 的 workspace、session 和窗口；其他 Kit 保持未加载。
4. 重复选择同一 Kit 不重复创建窗口；并发选择也只创建一次。
5. 关闭窗口后从 Tray 重开，复用此前稳定 sessionId 和 bounds。
6. `npm run dev -- --kit <kit>` 仍在服务就绪后直接打开指定 Kit，且不加载其他 Kit。
7. 一个 Kit 加载失败不关闭 Tray 或其他 Kit，之后可以重试。

## 非目标

- 在同一个 BrowserWindow 内热切换 Kit。
- 卸载仍保持打开的 Kit runtime 或自动休眠长期不用的 Kit。
- 在线安装、移除或刷新 Kit catalog。
- 修改 Server session、Kit resolver 或 workspace 持久化格式。
