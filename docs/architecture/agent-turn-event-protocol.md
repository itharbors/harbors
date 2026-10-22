# Agent Turn 事件协议

Harbors Harness 的事件以 `conversationId`、`turnId`、`itemId` 和 `requestId` 关联。`conversationId` 标识持久化会话；`turnId` 标识一次 Agent 执行；`itemId` 标识该 turn 内的消息、推理、工具或审批项；`requestId` 只用于一次定向请求及其响应（例如 Model Service 完成请求或权限审批）。

Agent 是事件序列的唯一生产者。事件提交 `agent-context-store` 并得到 Conversation 内单调递增的 `seq` 后，才通过 `agent.conversation.trace.append` 广播给 Chat。事件顶层和 `data` 同时携带关联键，便于现有消费者读取；Context Store 不再导入旧 JSONL。

Harness 的外层路由与 canonical 事件使用两种会话 ID：Chat 选择态、trace page 和 append envelope 使用 public ID `harbors:<adapterId>`；持久化事件顶层及 `data.conversationId` 保留 native `adapterId`。Chat 先以 public ID 校验 page/envelope 归属，再在正文投影边界取出 native ID，交给 canonical parser 校验事件关联；不能直接用 public ID 比较 canonical 事件，也不能移除外层会话隔离校验。

## Item 生命周期

每个新 Item 使用同一 `itemId` 依次发送：

```text
item.started -> item.delta* -> item.completed
```

`data.item.kind` 是 `message`、`reasoning`、`tool-call`、`tool-result` 或 `approval` 之一，`data.item.phase` 是上述生命周期阶段之一。`item.completed` 的 `snapshot` 是权威最终状态。缺少 started、关联键不一致、旧 seq 或未知 discriminator 的事件会被拒绝，不会静默成为成功内容。

### Chat 正文投影约定

Chat 从已提交的 canonical trace Item 重建正文：assistant message 的合法 `item.delta` 按 seq 拼接新增片段，在主聊天阅读区显示独立的实时 preview；preview 不是最终 assistant 消息，也不受过程折叠影响。中途挂载、切入进行中的会话或刷新时，同样从该会话已提交的生命周期恢复 preview，不依赖已错过的即时通知。

同一 Item 的 `item.completed.snapshot` 接管同一正文位置，清除 preview；snapshot 是完整权威值，不与旧前缀再次拼接。最终回答只显示一次；成功最终态同时需要合法 completed 快照与 completed Turn 终态。取消、失败、拒绝或超时可保留已提交前缀，但必须标识未完成；缺少合法 completed 快照时，不能仅因有文字或 Turn 已结束就升格为成功回答。非法生命周期和终态后的晚到事件不能覆盖已确定的展示。

只有没有对应 canonical Item 生命周期的旧历史才使用 legacy `assistant/message` 兼容投影；不能用 legacy 全文掩盖新生命周期异常。`agent.message.delta` 外部协议保留，但 Chat 主正文无需同时维护另一份 delta 事实源。消息链为 Model Service 增量 → Agent 接收 → Store commit → `agent.conversation.trace.append` → Chat 投影与正文；兼容的 `agent.message.delta` 仍在提交及 trace 之后发送。

这是用户可见流式的协议要求。后端持久化、trace 或 delta 通知通过，不等于真实 DOM 已在生成期间增长。Chat 展示链路前轮已通过 D9/D10 隔离 Web 验收；追加的独立浏览器复验因锁屏尚未执行，当前 Task 未完成。历史证据、当前状态与覆盖限制见 [可靠性修复 Task](../tasks/2026-10-22-agent-turn-durability/summary.md)。

## 审批与终态

Agent 先持久化并广播 `approval/asked`，其中包含完整四键关联（审批 Item 的 `itemId` 与 `requestId` 均不可省略）。Chat 只将同一 `conversationId`、`turnId`、`itemId`、`requestId` 的响应发送回 Agent。Agent 校验后广播 `approval/resolved`；`allowed-once`、`rejected`、`cancelled`、`unavailable` 和 `timed_out` 都是明确终态，重复响应幂等，超时不会留下 waiting 项。

Turn 结束使用 `turn/end` 的 `reason.kind` 表示 `completed`、`failed`、`cancelled`、`rejected` 或 `timed_out`。Model Service 的 `requestId` 保留在 `request/context` 与错误 envelope 中，但 Model Service 不直接修改 Chat Transcript。
