# 核心设计原则

这些原则不是对目录结构的复述，而是判断新能力应放在哪里、模块边界是否被破坏的
依据。它们描述当前实现的主导方向；具体接口仍以源码为准。

## 1. 插件优先，而不是把产品能力写进 Framework

面板、菜单、消息处理器和产品功能优先通过插件贡献。Framework 负责装载、隔离、路由
和生命周期，不直接认识“资源库”“层级树”或其他具体产品概念。

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

Server 以 `sessionId` 为键创建一个 Editor 实例。插件注册表、当前 Kit、窗口状态、
消息路由、菜单和国际化状态都挂在该 Editor 上。SQLite 只保存会话元数据；运行时对象
保存在内存中的 Editor map。

这意味着：

- 同一进程可以承载多个相互隔离的编辑器会话。
- 面板请求必须携带 `sessionId`，不能依赖进程级“当前会话”。
- 真正需要跨会话共享的数据必须通过明确的共享存储表达。目前 config 模块的 shared
  layer 是少数显式共享点之一。

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

通配路由用于观察或转发，不改变 request 的唯一目标语义。

## 7. 公开资源必须显式声明且留在插件边界内

Panel 入口和公开资源来自插件 manifest。服务端解析真实路径后仍检查资源是否位于插件
目录内，避免 `..`、符号链接或任意文件路径越界。

插件构建工具同样要求 main 和 panel entry 指向 `dist/`，运行时不直接执行 `src/`。

## 8. Web 工作台与 Electron 宿主保持薄边界

浏览器和 Electron 使用同一 Client。Electron 负责启动开发栈、发现 Kit、维护托盘与每 Kit
窗口、同步原生菜单和打开外部 HTTP(S) 链接；业务状态和插件运行时仍在各 session 的
Server Editor 中。

preload bridge 开启 context isolation、关闭 Node integration，并只暴露有限方法。新增
桌面能力时应继续通过窄桥接接口，而不是把 Node 能力暴露给页面或 Panel iframe。

## 9. 失败时清理所有权，而不是留下半装载状态

插件和 Kit 装载失败时，运行时按所有者清理 panel、message、menu 注册。切换 Kit 失败
时会清理已装载的新插件，并尽力恢复先前的外部插件集合。

任何新增贡献点都应具备与 attach 对称的 detach/clear-owner 路径。

## 变更检查

提出架构改动前，依次回答：

1. 这是产品能力、插件协议能力，还是 Framework 基础设施？
2. 状态属于单个 session、单个 Kit、单个插件，还是明确共享层？
3. Server 与 Client 谁持有权威状态？
4. 装载中途失败或卸载时，谁负责清理？
5. 是否扩大了 Panel、Web 页面或 Electron bridge 的权限边界？

## 源码索引

- [Editor 装配与 Kit 切换](../../packages/server/src/editor/index.ts)
- [插件运行时](../../packages/server/src/framework/plugin/index.ts)
- [消息模块](../../packages/server/src/framework/message/index.ts)
- [窗口状态模型](../../packages/server/src/framework/window/index.ts)
- [插件资源路由](../../packages/server/src/routes/panel-asset.ts)
- [Electron 宿主](../../scripts/electron.mjs)
- [Electron preload](../../scripts/electron-preload.cjs)

关联阅读：[系统架构](./system-overview.md) ·
[插件运行时模型](./plugin-runtime-model.md) ·
[ADR 0001：插件优先架构](../decisions/0001-plugin-first-architecture.md)
