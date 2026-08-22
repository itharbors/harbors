# Agent Chat Kit 装配与回归边界

Agent Chat Kit 的装配来源是 `kits/agent-chat/package.json` 中声明的九个 Kit 插件：
`conversation`、`chat`、`model-service`、`agent`、`plugin`、`preview`、`debug`、`settings` 和
`mermaid`。Server Web 宿主先加载 Framework 的 `panel`、`message`、`menu`、`config` 插件，再按 Kit
声明顺序解析和加载上述插件；测试不得用孤立的消息模块替代这条装配路径。

## 消息顺序

一次普通对话的可观察链路如下：

1. Chat/Conversation 面板以定向 request 调用 `agent.createConversation` 或
   `agent.sendMessage`。
2. Agent 以定向 request 调用 `model-service.getCatalog` / `model-service.complete`；请求携带唯一
   `requestId`，流式请求还携带 `generation`。
3. Model Service 将 Provider 的流式增量以 `model-service.complete.delta` broadcast 发出。Agent 只
   接收同一 `requestId` 和 `generation` 的单调 `sequence`，再以 `agent.message.delta` broadcast
   给 Chat。
4. Agent 每次持久化 trace 后 broadcast `agent.conversation.trace.append`。Chat 以
   `conversationId`、`turnId`、`itemId` 和 `seq` 重建 Transcript；`item.completed` 的 snapshot
   是最终状态。
5. Agent 以 `agent.message.status` broadcast running / completed / error 状态，并以 `turn/end`
   记录 `completed`、`failed`、`cancelled`、`timed_out` 或 `rejected` 终态。

审批是同一条链上的定向回环：Agent 先持久化并 broadcast `approval/asked`，Chat 以相同的
`conversationId`、`turnId`、`itemId`、`requestId` 调用 `agent.resolvePermissionRequest`，Agent 再持久化
`approval/resolved`。拒绝的工具调用会成为带错误的 `tool/result`；Agent 可继续向模型请求恢复性回答，
因此拒绝本身不必然结束整个 turn。

## 回归边界

`kits/agent-chat/tests/assembly.test.ts` 使用真实 manifest、真实 PluginModule 和真实 MessageModule，
只将不可控的 Provider HTTP 响应替换为本地 `fetch` 流。它覆盖：

- 九个 Kit 插件的实际加载、Panel 贡献和 request/broadcast 路由；
- 正常流式完成、delta 与 trace 的关联键和序列；
- 工具调用触发审批、拒绝后的错误工具结果及 turn 恢复；
- Stop 通过 Agent 到 Model Service 的 cancel 链路及 `turn/end=cancelled` 终态；
- Provider 错误的关联错误 envelope 与 `turn/end=failed` 终态；
- 会话选择切换后，旧 request/generation 的重复晚到 delta 不改变当前会话历史；
- Agent 插件卸载/重新加载后的历史恢复。

浏览器验收仍属于 Web 宿主层；本测试不引入 Electron 或其他桌面宿主假设。
