# Kit 启动期插件与真正懒加载设计

## 背景

当前 Electron 多 Kit 模式会在应用启动时调用 `prewarmKitWindows()`，为目录中的每个有效
Kit 创建隐藏窗口。窗口加载会创建 Session、Editor 并装载 Kit 的全部插件，因此当前所谓的
“隐藏预热”并不是真正的懒加载。Notification Host 虽然已经由 Electron 在窗口创建前独立
启动，但 Notification Kit 的菜单和服务插件仍依赖对应的隐藏 Session。

框架需要让 Kit 声明少量必须随应用启动的无界面插件，同时保持 Kit 的窗口、Panel 和普通
插件只在用户首次打开该 Kit 时加载。

## 目标

1. 为每个 Kit 提供统一、业务无关的启动期插件声明。
2. 在没有创建任何 Kit Session 的情况下加载这些插件。
3. 让启动期插件能够注册应用级服务、服务端消息方法和全局菜单动作。
4. 保持 Panel、Layout、Window 和普通 Kit 插件的按需加载。
5. 移除“预热全部隐藏窗口”对常驻能力的隐式依赖。
6. 为启动失败、重复声明、应用退出和中断恢复提供确定性行为。

## 非目标

- 首版不实现完整的 `activationEvents` 系统，例如按文件类型、命令或定时事件激活。
- 首版不在关闭窗口时卸载已经打开过的 Session Runtime；它仍保持到应用退出。
- 不允许启动期插件直接注册 Panel、Layout 或浏览器端消息处理器。
- 不把任意 Kit 代码加载进 Electron 主进程；启动期插件仍运行在 Framework Server 进程。
- 不迁移 Notification Host、Toast BrowserWindow、Dock/任务栏 Badge 等 Electron Shell 能力。

## Manifest 契约

Kit 在现有 `ce-editor.kit` 下新增可选的 `startup.plugins`：

```json
{
  "ce-editor": {
    "kit": {
      "startup": {
        "plugins": [
          "@itharbors/notification-background"
        ]
      },
      "plugin": [
        "@itharbors/notification-center"
      ]
    }
  }
}
```

约束如下：

- `startup.plugins` 缺省为空数组，不改变现有 Kit。
- 插件名称使用现有 Kit `plugins/` 解析规则，不接受任意文件路径。
- 数组顺序只用于确定性加载与反向卸载，不表达插件依赖。
- 多个 Kit 声明相同 package name 和相同真实路径时，Application Runtime 只加载一个实例。
- 相同 package name 解析到不同真实路径时，应用启动报告冲突，不选择其中任意一个。
- Manifest 校验、KitCatalog 和插件构建检查必须认识并验证该字段。

不采用整个 Kit 的 `eager: true` 标记。生命周期声明只覆盖明确列出的最小后台插件，不能把
Panel 和 Session 隐式带入启动流程。

## 双运行时模型

### Application Runtime

Framework Server 启动时创建一个进程级、无 Session 的 `ApplicationRuntime`。它复用现有
PluginModule 的 definition 捕获、所有权清理和 load/unload 状态机，但使用受限的
`ApplicationPluginRuntime`：

- `service`：注册和查询应用级服务；
- `message`：注册仅在 Server 端执行的应用级 request；
- `menu`：注册应用级菜单动作；
- `host`：读取运行模式和框架提供的非敏感启动信息；
- 不提供 `window`、`panel`、`layout` 或 Session 配置。

启动插件的 manifest 可以贡献 Server request 和应用级 menu。若贡献 Panel、浏览器端
message 或其他 Session 能力，校验阶段直接失败，而不是在运行时静默忽略。

ApplicationRuntime 先加载框架内置的 application-service、application-message 和
application-menu 控制器，再加载 Kit 声明的启动插件。控制器沿用 owner 清理规则，但不加入
任何 Session Editor；启动插件之间的方法调用只能通过显式 service 或 message 标识完成。

### Session Runtime

用户首次打开 Kit 时，框架继续使用现有 SessionRuntimeRegistry 创建 Editor 并加载
`ce-editor.kit.plugin`。普通插件拥有 Panel、Window、Layout、Session Message 和 Kit 菜单。

同一个 package 不应同时出现在同一 Kit 的 `startup.plugins` 和普通 `plugin` 中；首版将其
视为 manifest 错误，避免一个模块在两个作用域持有两份状态。若未来确有共享需求，应拆成
background 和 UI 两个 package，并通过显式应用级 API 通信。

## 启动与退出流程

Electron 多 Kit 模式调整为：

1. 只读取所有有效 Kit manifest，建立 KitCatalog，不创建窗口。
2. Electron 启动 Shell 级服务，包括 Notification Host、Toast、Badge 和 Tray 基础设施。
3. Framework Server 启动并收集目录中全部有效 Kit 的 `startup.plugins`。
4. ApplicationRuntime 按 KitCatalog 顺序和数组顺序解析、去重并依次加载启动插件。
5. Framework application health 就绪后，Electron 创建默认 Kit 的可见窗口。
6. 其他 Kit 只显示在 Tray；用户首次点击时才创建 Workspace、窗口和 Session Runtime。
7. 关闭 Kit 窗口后保留已创建的 Session Runtime；再次打开复用稳定 sessionId。
8. 应用退出时先停止接受新的应用级请求，再按相反顺序卸载启动插件，最后停止 Framework
   与 Electron Shell 服务。

单 Kit 模式只收集被选择 Kit 的启动插件。Web 调试模式同样创建 ApplicationRuntime，但
`host.mode` 为 `web`；依赖桌面服务的插件必须返回明确的“桌面模式不可用”错误。

## 应用级菜单与请求

ApplicationRuntime 维护独立于任何 Session 的 application menu tree。Framework 首版增加：

- `GET /api/application/bootstrap`：返回 Runtime 阶段、启动插件状态和全局菜单树；
- `POST /api/application/menu/trigger`：只携带 menuId，以菜单 ID 调用对应插件方法；
- `/sse/application`：承载应用级 menu change 和 Runtime 状态事件，不复用 Session SSE。

Electron 把该菜单树合并到固定 `APP` 根菜单。全局动作不依赖当前聚焦窗口，也不借用任意
Kit 的 sessionId。SessionRuntime 继续只产生对应 Kit 的菜单树；两套路由在协议上保持分离。

Electron 等待 `/api/application/bootstrap` 进入 `ready` 或 `degraded` 后才创建默认窗口；基础
`/api/health` 只证明进程存活，不能再作为启动插件已经完成加载的证据。

首版应用级菜单只支持调用 Server 方法。打开具体 Kit 或 Panel 仍由 Electron Shell 和
Session 菜单负责，避免 ApplicationRuntime 反向依赖某个尚未创建的 Session。

## Notification Kit 拆分

Notifications 使用两个插件 package：

### `@itharbors/notification-background`

声明在 `startup.plugins`，负责：

- “Install or Update Codex Notification Skill…”全局菜单；
- Codex Skill 安装、更新、冲突保护和安装结果通知；
- 与 Electron Notification Host 通信的应用级服务方法；
- 不贡献 Panel，也不调用 `window.openPanel()`。

### `@itharbors/notification-center`

保留在普通 `plugin`，负责：

- Notification Center Panel；
- 通知列表、已读、全部已读和删除等 UI 请求；
- 仅在 Notifications Kit 已打开时存在的 Kit 菜单动作。

Notification Host、Toast 队列、任务栏/Dock Badge 和 Tray 未读数继续属于 Electron Shell，
随应用启动，不依赖任何 Kit Runtime。这样外部 Agent 从应用 Ready 起即可发送通知，而通知
中心 UI 仍保持懒加载。

## 失败策略

- 单个启动插件加载失败不会阻止 Framework 和其他 Kit 启动；ApplicationRuntime 记录
  `failed` 状态、错误摘要和插件归属 Kit。
- 失败插件产生的 service、message 和 menu 贡献必须按 owner 完整回滚。
- Electron 在日志和应用状态中暴露降级信息，但不弹出依赖故障插件本身的通知。
- 重复 package 路径冲突属于 catalog 错误，对冲突插件全部拒绝加载，其他插件继续。
- 应用级请求在 Runtime 未就绪、正在退出或目标插件失败时返回稳定错误码。
- unload 失败不阻止后续插件卸载；最终通过 AggregateError 汇总并记录。

## 兼容与迁移

- 现有 Kit 未声明 `startup` 时行为保持不变，只是不会再被隐藏窗口预热。
- 默认 Kit 仍在应用启动后自动打开，因此其普通 UI 行为不变。
- 已打开过的 Kit 继续使用 WorkspaceStore 中的稳定 sessionId 和窗口 bounds。
- Notification Skill 的安装目录、菜单文案和外部通知 HTTP API 不变。
- 当前 `prewarmKitWindows()` 替换为“打开默认 Kit”，Tray 的 `openKit()` 保持按需创建能力。

## 测试策略

### Manifest 与发现

- 接受缺省或合法 `startup.plugins`，拒绝非数组、空名称和 startup/普通插件重复。
- 多 Kit 相同启动插件同路径去重，不同路径冲突。
- 单 Kit 模式只收集被选择 Kit 的启动插件。

### Application Runtime

- 无 Session 时加载、调用和反向卸载启动插件。
- 拒绝 Panel、browser message、Window 和 Layout 贡献。
- lifecycle 或 attach 失败时清理 owner 资源并继续加载其他插件。
- 应用级菜单更新和触发路由不要求 sessionId。

### Electron 懒加载

- 启动时只创建默认 Kit 窗口，不为其他 Kit 创建隐藏窗口。
- Tray 首次点击创建目标 Kit，后续点击聚焦或恢复已有窗口。
- Notification Host 在默认窗口创建前就绪。
- 全局启动菜单在没有 Notifications Session 时可触发。

### Notification 拆分

- background package 不贡献 Panel，启动时可安装 Skill 并发送结果通知。
- center package 只在 Notifications Kit Session 中加载，Panel 行为保持不变。
- 外部通知在 Notifications Kit 从未打开时仍能产生 Toast、Badge 和未读计数。

## 验收标准

1. 应用启动后，除默认 Kit 外不存在其他 Kit BrowserWindow 或 Session Runtime。
2. 所有合法 `startup.plugins` 在第一个 Kit 窗口显示前完成加载或进入可观测失败状态。
3. Notifications Kit 从未打开时，外部通知和安装 Skill 全局菜单仍可使用。
4. 用户首次点击任意 Kit 后才加载它的普通插件和 Panel；再次打开复用稳定 Session。
5. 启动插件无法注册 Session/Panel 能力，失败不会污染其他插件或阻止应用启动。
6. 应用退出时启动插件按反向顺序卸载，Shell 服务和 Framework 不遗留监听端口。
