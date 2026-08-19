# 2026-08-19-plugin-broadcast-topic-ownership

Task ID: `2026-08-19-plugin-broadcast-topic-ownership`
Type: `feature`

## 背景与问题

插件广播（broadcast）topic 目前是任意字符串，MessageModule 仅按 topic 字符串做精确匹配（外加 `*` 通配订阅），不感知 topic 的归属插件。这导致：

- 不同插件可能使用相同 topic 字符串广播，造成语义冲突或误触发。
- 从 topic 字符串无法判断事件的归属插件，排查和调试困难。
- 调用方可以广播任意 topic，包括其他插件命名空间下的事件，缺乏基本的归属约束。

需要约定广播 topic 必须显式使用 `<插件名>.<事件名>` 格式，并在各入口校验调用方是否为 topic 前缀对应的插件，从而保证广播事件的归属清晰可追溯。

## 目标

- 约定广播 topic 格式为 `<插件名>.<事件名>`，其中 `<插件名>` 为广播该事件的插件名。
- 在 Main（会话插件运行时）、Application 子进程（应用插件运行时）、Panel（面板运行时）三个入口对广播 topic 做归属校验：topic 必须以当前插件名加 `.` 开头。
- MessageModule 保持不感知 owner，仅按 topic 字符串路由，不引入归属逻辑。
- 迁移现有不合规的广播 topic，使其符合 `<插件名>.<事件名>` 格式，并同步更新订阅方。

## 范围

- Main 入口：`packages/plugin` 中会话插件运行时的 `message.broadcast` 校验 topic 以 `ownerName.` 开头；通配符 `*` 仅允许用于订阅，不允许用于广播。
- Application 子进程入口：`packages/server/src/application/runtime.ts` 中应用插件运行时的 `broadcast` 命令校验 topic 以 `ownerName.` 开头。
- Panel 入口：面板运行时的 `ctx.message.broadcast` 校验 topic 以所属插件名加 `.` 开头。
- 迁移现有不合规 topic：
  - `plugin.selected`（`plugin-list` 广播，`plugin-list`、`plugin-detail` 订阅）改为 `plugin-list.selected`。
  - `conversation.changed`（`agent` 以 `agent.conversation.changed` 广播，`conversation`、`message-panel` 订阅）订阅方改为 `agent.conversation.changed`。
  - `conversation.trace.append`（`agent` 以 `agent.conversation.trace.append` 广播，`message-panel` 订阅）订阅方改为 `agent.conversation.trace.append`。
  - `message.delta`（`agent` 以 `agent.message.delta` 广播，`message-panel` 订阅）订阅方改为 `agent.message.delta`。
  - `message.status`（`agent` 以 `agent.message.status` 广播，`message-panel` 订阅）订阅方改为 `agent.message.status`。
- 已合规的 topic 保持不变：`log.changed`、`message-debug.messages.changed`、`conversation.selected`、`config.changed`、`agent.*`、`message-panel.link.clicked`。

## 非目标

- 不自动为调用方补全 topic 前缀；调用方必须显式写出完整 topic。
- 不改变广播 payload 的结构或内容。
- 不把该校验宣称为 Panel 服务端安全边界；该校验仅为归属约定的运行时检查，不替代鉴权。
- 不修改 request 消息的命名或校验逻辑。
- 不在 MessageModule 中引入 owner 感知或 topic 前缀解析。

## 验收标准

- 会话插件运行时调用 `runtime.message.broadcast` 时，若 topic 不以 `<ownerName>.` 开头或为 `*`，抛出明确错误。
- 应用插件运行时通过子进程命令广播时，若 topic 不以 `<ownerName>.` 开头或为 `*`，返回错误。
- 面板调用 `ctx.message.broadcast` 时，若 topic 不以所属插件名加 `.` 开头或为 `*`，抛出错误。
- MessageModule 的 `broadcast` 方法仍仅按 topic 字符串路由，不包含 owner 校验逻辑。
- 所有现有广播 topic 均符合 `<插件名>.<事件名>` 格式，订阅方 topic 与广播方一致。
- 相关单测与集成测试通过，覆盖合规 topic 通过、不合规 topic 被拒绝、通配订阅仍可接收所有广播。

## 约束

- 仅支持 Web 宿主，不加入 Electron 或桌面宿主假设。
- 校验逻辑位于各入口（plugin runtime、application runtime、panel runtime），不放入 MessageModule。
- 通配符 `*` 仅可用于 `registerBroadcast` 订阅，不可用于 `broadcast` 发送。
- 不修改 `status.json` 或 `summary.md`。

## 需求变更

本 Task 未发生需求变更。
