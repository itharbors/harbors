# 核心设计原则

这些原则不是对目录结构的复述，而是判断新能力应放在哪里、模块边界是否被破坏的
依据。它们描述当前实现的主导方向；具体接口仍以源码为准。

## 1. 插件优先，而不是把产品能力写进 Framework

面板、菜单、消息处理器和产品功能优先通过插件贡献。Framework 负责装载、隔离、路由
和生命周期，只认识 User、Session、Plugin 等通用身份，不直接认识 Conversation、Project、
“资源库”或其他具体产品概念。业务对象的 schema、索引与生命周期留在所属 Plugin。

直接影响：

- 新功能先判断能否成为现有贡献点的数据或生命周期实现。
- 只有多个插件都需要、且无法通过当前协议表达的能力才进入 Framework API。
- 内置插件也遵循插件协议；“内置”表示装配层始终加载，不表示可以绕过生命周期。

## 2. Kit 是会话的能力边界

Kit 不是主题包，也不只是布局文件。它同时声明：

- 使用哪些外部插件；
- 提供哪些命名布局；
- 主窗口和次窗口加载哪个 HTML 入口；
- 可选的主题 token。

切换 Kit 等价于切换一个会话的产品能力集合。内置插件保持可用，旧 Kit 的外部插件及
其面板、消息和菜单贡献必须清理，再装载新 Kit。

## 3. 按会话隔离运行时状态

同一基础 Session 可以有多个 Kit runtime，每个 runtime 拥有独立 Editor。插件注册表、当前 Kit、窗口状态、
消息路由、菜单和国际化状态都挂在该 Editor 上。持久元数据保存在 SQLite，运行时对象
保存在内存注册表中；业务内容由对应 Plugin 管理。

这意味着：

- 同一进程可以承载多个相互隔离的编辑器会话。
- 面板请求必须携带 `sessionId`，不能依赖进程级“当前会话”。
- 运行时隔离与持久数据范围分别定义：默认 Plugin data/cache 属于 User + Plugin，
  sessionData/temp 属于 User + 基础 Session + Plugin；Config 和 Credentials 还包含 Kit 边界。
- 跨 User 或扩大到其他 Plugin 的共享必须有显式契约与授权，不能通过省略身份或回退公共根实现。

## 4. Server 持有权威运行时状态

Kit、插件、菜单、窗口、PanelInstance 和消息注册的权威状态在 Server。Client 在启动时
拉取 bootstrap 快照，之后通过 API 提交意图、通过 SSE 接收变化。

Client 可以保留渲染需要的局部 UI 状态，例如 divider 的即时尺寸或 tab 拖动过程，但
不能把它当作跨窗口、跨刷新可恢复的权威来源。

## 5. 布局是声明式状态，不是临时 DOM 拼装

结构布局使用 `LayoutNode` 树表达：`leaf`、`tab`、`hsplit`、`vsplit`。Server 管理
Window 和 PanelInstance 的生命周期，Client 把快照投影为 Web Components。

因此结构变化应先形成新的模型，再渲染 DOM；拖放、分割尺寸和打开面板都不能绕过
模型另建一套状态。

## 6. Request 与 Broadcast 语义分离

- request 只有一个确定目标并返回结果；没有路由时明确失败。
- broadcast 可以有多个订阅者，采用 fire-and-forget；单个处理器异常不反向破坏发送者。
- panel 方法通过消息路由转发，Panel 不直接导入其他插件或 Server 内部模块。
- 调用者由 Host 绑定。同步 `callPlugin` 与 request 使用同一份 manifest request 声明和
  callers 约束；入口不同不能扩大可调用方法或伪造 caller。

通配路由用于观察或转发，不改变 request 的唯一目标语义。

## 7. 公开资源必须显式声明且留在插件边界内

Panel 入口和公开资源来自插件 manifest。服务端解析真实路径后仍检查资源是否位于插件
目录内，避免 `..`、符号链接或任意文件路径越界。

插件构建工具同样要求 main 和 panel entry 指向 `dist/`，运行时不直接执行 `src/`。

## 8. Web 是唯一宿主边界

浏览器是唯一受支持的交互宿主。Client、Panel 与插件不得假设存在 Electron、Node renderer、
原生窗口、托盘或桌面 IPC。操作系统级能力必须先形成明确的 Web/Server 契约，并遵守权限与
部署边界。

## 9. 失败时清理所有权，而不是留下半装载状态

插件和 Kit 装载失败时，运行时按所有者清理 panel、message、menu 注册。切换 Kit 失败
时会清理已装载的新插件，并尽力恢复先前的外部插件集合。

任何新增贡献点都应具备与 attach 对称的 detach/clear-owner 路径。

## 10. 正常使用默认接口就应得到正确边界

Host 从 Session owner 绑定 User、基础 Session 和 Plugin 身份；Plugin 不从业务参数自行
拼接身份、存储根或凭据 scope。缺少必要身份时明确失败，不回退到匿名或共享范围。

- 默认范围必须与数据归属一致，并在路径、Config、Credentials 间保持可解释的一致性。
- Application 能力确实属于应用级时保留应用级范围，不伪造 User 来复用 Session 接口。
- 扩大共享是单独的能力设计，要写明参与者、授权、读写范围和通知链路；不得依赖隐式全局状态。
- 文件的归属范围与保留、清理周期分别定义；目录叫 temp 或属于 Session 不代表会自动删除。

这些约束保护受信 Plugin 正常使用公开接口时的边界，不构成 Node.js 或 OS 权限沙箱。

## 11. 写入绑定 owner，读取交付独立快照

普通 Plugin 对贡献资源的删除、重置和注销只能影响自身 owner；Host 的全局清理和贡献控制器的窄化委托
不能出现在普通 facade 中。资源名看似属于自己，也必须核对实际注册 owner。

控制面查询、注册输入和 lifecycle attach 数据不得保留可被外部修改的内部引用。
Plugin、Panel、Menu、Message、Kit 的元数据，以及 Config JSON 值在边界复制；修改读取结果
不能改变身份、归属、权限或内部状态。有效更新必须重新经过受控写接口。

## 变更检查

提出架构改动前，依次回答：

1. 这是产品能力、插件协议能力，还是 Framework 基础设施？
2. 状态属于哪个 User、基础 Session、Kit、Plugin？扩大共享是否显式授权？
3. Server 与 Client 谁持有权威状态？
4. 装载中途失败或卸载时，谁负责清理？
5. 是否扩大了 Panel、Web 页面或 Server API 的权限边界？
6. 正常使用默认接口能否保持边界？读返回值或更换调用入口能否绕过受控写入和权限？

## 源码索引

- [Editor 装配与 Kit 切换](../../packages/server/src/editor/index.ts)
- [插件运行时](../../packages/plugin/src/index.ts)
- [消息模块](../../packages/server/src/framework/message/index.ts)
- [窗口状态模型](../../packages/server/src/framework/window/index.ts)
- [插件资源路由](../../packages/server/src/routes/panel-asset.ts)
- [Web Server 入口](../../packages/server/src/start.ts)

关联阅读：[系统架构](./system-overview.md) ·
[插件运行时模型](./plugin-runtime-model.md) ·
[ADR 0001：插件优先架构](../decisions/0001-plugin-first-architecture.md) ·
[ADR 0002：单一 Web host](../decisions/0002-web-only-host.md) ·
[ADR 0005：Plugin 默认身份与所有权边界](../decisions/0005-plugin-default-boundaries.md)
