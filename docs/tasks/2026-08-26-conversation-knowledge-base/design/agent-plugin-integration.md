# Agent Plugin 集成设计

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../../2026-10-22-agent-turn-durability/summary.md)。

## 1. 结论

Agent 只负责编排，不拥有 Conversation 存储和历史选择算法。它在 load 时确认 Context Store ready，在每个模型 step 前计算 availableInputTokens 并调用 buildContext，然后把返回结果原样交给 Model Service。

目标顺序是所有模型、tool 和 approval 事件先提交 Context Store，再发送 Chat trace。2026-10-22 源码复核确认：普通 append 的 trace listener 在提交后执行，但流式 `onDelta` 在写入排队后立即调用，Stop 收口超时仍返回 true；这两项是未完成的 P1 实现缺口，本次文档修订不修复代码。

Store 的数据范围为 User + Plugin，同 User 跨基础 Session 共享；Agent runtime 和广播仍按当前基础 Session/Kit runtime 隔离。Framework 绑定可信身份与目录，Conversation schema 和生命周期留在 Store，旧无 User 路径不回退。

## 2. 为什么这样分工

Agent 已经负责 Turn、tool loop、Model Service 和 UI trace。如果继续持有 SQLite、检索和压缩，会再次形成一个难以独立测试的大模块。

Context Store 拥有事实与 Context Plan，Agent 只决定“什么时候调用”和“如何把结果用于本 step”，可以避免两边分别裁剪和产生不一致。

## 3. Load

本节及后续正常流程描述设计职责与验收要求；已完成范围以 Task 的历史证据及明确标出的当前源码事实为准，不能将设计条款本身作为实现完成证明。

Framework 已保证 agent-context-store 先于 Agent load。Agent 启动时：

1. 调用 getStatus；
2. 确认 ready 和支持的 schema；
3. 注册现有对外 methods；
4. 不创建 JSONL writer 或 SQLite connection；
5. readiness 失败则 Agent load 失败，新 Kit 不激活，Framework 尝试恢复旧 Kit；恢复成功才继续使用，恢复失败则 fail closed 并重建 runtime，同时保留激活与恢复错误。

调用仍为同步 `callPlugin`；Host 绑定 `agent` caller，并复用 Store manifest 的 request/methods/callers 检查，不另建 ACL。

## 4. Conversation 调用

Context Store 的完整 API 以 [Agent Context Store Plugin 设计](agent-context-store-plugin.md) 为准。

Agent 保留现有对外 request/broadcast 契约，只做内部调用映射：

- listConversations/listArchivedConversations 继续对外返回完整数组，由 Store `listConversations(status)` 组合；Store 当前没有分页 API；
- getConversationTrace、getConversationTraceSince、getConversationTracePage 的字段、cursor 和完整 Turn 语义不变；
- getDraftOptions、全局 get/save/resetSettings 和 Model Service catalog 继续由 Agent 拥有；
- conversation options/context/permissions、rename 和 recent projects 是 Agent facade，由 `loadConversation`、`appendEvent`、`listConversations` 与 Model Service 信息组合，不是同名 Store methods；
- pending permission query/resolve 继续由 Agent 拥有，Store 保存 asked/resolved 事实；
- create、rename、archive、restore、delete 先调用 Store，成功后再通知 Chat；
- 不返回 Store 内部路径、connection 或数据库 row；
- 不在 Agent 中保留第二套 Conversation metadata。

Conversation Plugin 继续拥有 selectedConversationId、draft、running、generation/revision 和 listKnownProjects；Context Store 不接管工作台选择态。现有 `agent.conversation.changed` 与 `conversation.selected` 的顺序和 stale-update gate 保持不变。

## 5. Turn 与 Step

### Turn 开始

1. Chat 通过 request 调用 Agent sendMessage；
2. Agent 创建 turnId；
3. Agent 同步调用 Store appendEvent 保存 turn/start 和用户 item；
4. 进入 step loop。

### 每个模型 step

1. Agent 获取模型 context window；
2. 计算 System、tools 和权限定义占用；
3. 扣除 output reserve 与 safety margin，得到 availableInputTokens 和 budgetBreakdown；
4. 把 availableInputTokens、budgetBreakdown 和本 step anchors 传给 buildContext；
5. 将 Store 返回 messages 原样交给 Model Service request；
6. 组装最终 Provider request，并把现有 request/context 审计字段、planId、historyDigest 和 providerRequestDigest 一并持久化。

Agent 不自行删减 Store 返回的历史。如果 Model Service 报告 context overflow，允许一次有界恢复：将原 planId、Provider 错误和实际 usage 交给 Store，以更小预算重新 buildContext，生成关联的新 plan/request attempt 后重试。第二次仍溢出才结束请求；重试不得重复执行 tool。

### Tool loop

1. 模型产生 tool call；
2. Agent 处理 permission 和 tool execution；
3. tool result 通过 appendEvent 持久化；
4. 新 path、error、command、Task ID 或 entity ID 作为 anchors；
5. 下一 step 的 buildContext 使用新 anchors。

这允许 Agent 在执行中才发现“上次读取过的文件”，而不是要求第一个 step 预知全部历史。

保留现有工具失败循环 guard：连续失败或相同错误签名达到 3 次时写 `turn/stop` 并终止，不发出第 4 次模型请求；成功工具会重置对应计数。

工具副作用的目标约束：先提交 call/started 再执行。副作用已经发生但 result 无法持久化时，需要将结果呈现为未能确认并结束 Turn，禁止自动重跑 mutation 工具；并行执行只用于明确只读工具。这是故障验收要求，不宣称已有独立 outcome journal。

### Turn 结束

**当前事实**：sendMessage 的完成或异常路径尝试写入 `turn/end`，finally 释放 active Turn 并完成内存 completion。流式成功路径会等待 deltaPersistence；但 delta 回调先排队再直接 onDelta，写失败不能立即阻止已通知的 UI delta。stopConversation 对 completion 与超时做 Promise.race 后均返回 true，Agent facade 据此显示“已停止”。所以 completion 完成或 Stop 返回 true 都不足以证明 cancelled terminal 已落盘。依据：`harbors.ts` 的 sendMessage、runModelToolLoop、stopConversation，以及 Agent `index.ts` 的 delta/Stop facade。

**最小目标，尚未实现**：保留现有 Turn 执行对象、AbortController、串行写队列和外部接口，在当前 Turn 内收敛到一个终态写入点。停止接收新 delta/result 后，等待已接收队列收口，再写唯一 `turn/end`；完成与取消竞争由该写入点选择一个有效终态。内存 completion 必须携带持久终态是否成功的结果，不能仅在 finally resolve 就视为稳定停止。同步 Store 调用只能在调用边界检查取消，不能宣称 AbortSignal 可中断其内部同步执行。

保持 `stopConversation(): Promise<boolean>`：无 active Turn 返回 false；只有 cancelled `turn/end` 成功持久化才返回 true。上游不响应、收口超时或写终态失败走既有 Promise rejection 通道，明确未完成/失败并保留 requestId 和原因；facade 不广播“已停止”。重复 Stop 共享当前 Turn 的收口结果，已进入终态的 generation 拒绝晚到 delta/result，不自动重跑 mutation 工具。

## 6. recall_history

Agent 向模型提供 recall_history tool：

- 参数限于 query、anchors、seq/time range 和 limit；
- conversationId 由 Agent 注入，模型不能指定其他 Conversation；
- Agent 调用 Store recallHistory；
- 结果作为 tool result 落盘；
- 下一 step 通过当前 Turn 轨迹交给模型。

历史文件 evidence 不代替实时读取；需要文件内容时 Agent 重新调用文件工具。

## 7. Trace

普通 append 当前已采用以下顺序；流式也必须达到这一目标：

1. Context Store commit event；
2. Agent 更新当前 Turn 的临时运行状态；
3. Agent 发送现有 Chat trace；
4. trace listener 失败只记录诊断。

Context Store 不广播内部状态，Chat 不直接读取数据库。

最小流式目标：复用每个 request/generation 的串行持久化链，将 `onDelta` 放进队列任务，在 append 成功及 trace listener 执行后才调用，形成 `SQLite commit → trace → agent.message.delta`。沿用 requestId/generation/sequence 过滤；首个持久化失败立即关闭该 generation、取消上游，后续队列任务及回调不得再发送成功 delta。completed、step/end 和 turn/end 必须等待已接收队列收口；Provider 错误与写入错误同时发生时保留主要持久化错误和安全 cause。此目标不需要改变同步 Store API、delta 回调签名或 broadcast 协议。

Approval 的目标约束：pending registry 按 conversation/turn/item/request 四键定位，approval/asked 持久化后才开放按钮；resolved 选择唯一终态，先持久化 resolved/completed snapshot，再清理 pending、广播状态和执行或拒绝工具。重复、过期、Stop 后响应不得再次执行；这些须按故障门禁验证，不能由正常审批单测推断全部完成。

## 8. 错误呈现

| 来源 | Agent 行为 |
| --- | --- |
| Framework dependency/load | 新 Kit 不激活；旧 Kit 恢复成功可继续，恢复失败时 Editor 不可用并要求重建 runtime，保留两类错误 |
| Store not ready/schema/corrupt | 结束请求，显示“上下文存储不可用”，保留 code |
| Conversation busy/archived/deleted | 显示对应状态，不自动重试 mutation |
| Projection unavailable | 显示历史检索暂不可用，不伪装为空结果 |
| Context budget exceeded | 显示强制上下文本身超限，保留 Plan 诊断 |
| Model Service error | 沿用现有模型错误路径 |

Agent 不解析错误字符串，也不把 Store 故障转换成新建空 Conversation。

## 9. 临时内存

Agent 可以保留当前 active Turn 的执行对象、AbortController、stream delta、pending resolver、loadedSkills 和 tool guard 状态，但它们不是第二份 Conversation 事实。Conversation metadata、events、surface 和历史 Context 不再由 Agent 维护权威缓存。

## 10. 验证

以下为目标验收清单；历史单测或正常路径通过不能替代故障验收，2026-10-22 未重跑产品测试。

- Agent load 必须先确认 Store ready；
- 所有 Conversation 能力只调用 canonical API；
- 每个模型 step 计算 availableInputTokens 并调用 buildContext；
- Agent 不二次裁剪 messages；
- tool result 新锚点影响下一 step；
- 当前 Turn 大 tool result 和 loaded Skill 原文进入下一 step；
- overflow 只进行一次 Store 驱动的有界重建；
- recall_history 不跨 Conversation；
- append 成功后才发送 trace；
- delta generation/sequence、Stop settlement、approval 四键和工具失败 guard；
- Model Service NeutralMessage 在 OpenAI/Anthropic、图片和并行 tool call 下无损；
- context usage、conversation options/permissions 和 pending approval 刷新后保持；
- Store 错误 code 到用户可读消息的映射；
- 刷新后从 Store 恢复；
- Web 中连续对话、工具、审批、停止和故障状态。

### 尚待实现的故障门禁

| 注入点 | 必须证明 |
| --- | --- |
| delta append 延迟 | commit 前没有对应 trace/delta 广播；completed/step/end/turn/end 不越过已接收队列 |
| delta append 失败且上游继续发 chunk | 立即关闭 generation 并取消上游；失败项和后续项不广播成功，错误可见，不重跑副作用 |
| 最后 delta 与 completed、Provider 错误或 Stop 竞争 | 已接收事件先收口，只选择一个有效 terminal，持久化失败不会被 Provider 错误或 finally completion 掩盖 |
| Stop 后上游不响应或 terminal append 失败 | 超时或失败不返回 true、不显示稳定停止；durable cancelled terminal 成功后才返回 true |
| context/model/tool/approval/append 五个等待阶段 Stop | 边界取消检查、重复 Stop、晚到 delta/result 和审批响应不产生第二终态或重复执行工具；同步 Store 不虚构可中断接口 |
