# Agent Turn 事件协议

Agent Chat 的事件以 `conversationId`、`turnId`、`itemId` 和 `requestId` 关联。`conversationId` 标识持久化会话；`turnId` 标识一次 Agent 执行；`itemId` 标识该 turn 内的消息、推理、工具或审批项；`requestId` 只用于一次定向请求及其响应（例如 Model Service 完成请求或权限审批）。

Agent 是事件序列的唯一生产者。事件写入 JSONL 并得到单调递增的 `seq` 后，才通过 `agent.conversation.trace.append` 广播给 Chat。事件顶层和 `data` 同时携带关联键，便于新旧消费者共存；读取旧日志时按 `turn` 推导稳定的 `legacy-turn-<n>`，不回写原始历史内容。

## Item 生命周期

每个新 Item 使用同一 `itemId` 依次发送：

```text
item.started -> item.delta* -> item.completed
```

`data.item.kind` 是 `message`、`reasoning`、`tool-call`、`tool-result` 或 `approval` 之一，`data.item.phase` 是上述生命周期阶段之一。`item.completed` 的 `snapshot` 是权威最终状态；Chat 可以使用 delta 更新实时预览，但重建 Transcript 时只采纳 completed 快照。缺少 started、关联键不一致、旧 seq 或未知 discriminator 的事件会被拒绝，不会静默成为成功内容。

## 审批与终态

Agent 先持久化并广播 `approval/asked`，其中包含完整四键关联（审批 Item 的 `itemId` 与 `requestId` 均不可省略）。Chat 只将同一 `conversationId`、`turnId`、`itemId`、`requestId` 的响应发送回 Agent。Agent 校验后广播 `approval/resolved`；`allowed-once`、`rejected`、`cancelled`、`unavailable` 和 `timed_out` 都是明确终态，重复响应幂等，超时不会留下 waiting 项。

Turn 结束使用 `turn/end` 的 `reason.kind` 表示 `completed`、`failed`、`cancelled`、`rejected` 或 `timed_out`。Model Service 的 `requestId` 保留在 `request/context` 与错误 envelope 中，但 Model Service 不直接修改 Chat Transcript。
