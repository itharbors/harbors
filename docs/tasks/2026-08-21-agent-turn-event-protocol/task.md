# Agent Turn 事件协议收敛

Task ID: `2026-08-21-agent-turn-event-protocol`
Type: `refactor`

## 背景与问题

Agent Chat 当前已经通过 request/broadcast 传递消息、状态和 trace，但会话、一次模型运行、单个内容项及交互请求之间的关联关系没有形成统一协议。部分事件依赖当前活动会话或分散的字符串字段，异步 context 查询还可能造成状态乱序；工具调用、工具结果、消息、推理和审批也缺少稳定的 tagged union 结构。结果是 Chat 不能可靠地从事件重建完整 Transcript，断线、切换会话、取消或晚到事件时容易出现残留审批、错误归属或旧状态覆盖新状态。

本 Task 只收敛 Agent/Chat 的事件与请求语义，为后续真正的 Provider streaming、取消链路和装配回归提供稳定基础。

## 目标

- 建立 `conversationId`（会话）、`turnId`（一次 Agent turn）、`itemId`（turn 内内容或工具项）和 `requestId`（定向交互请求）的明确关联模型。
- 为 Item 统一提供 `started → delta → completed` 生命周期，其中 `completed` 是该 Item 的权威最终状态。
- 为消息、推理、工具调用、工具结果和审批定义可判别的 tagged union，减少对自由字符串 `type` 的隐式约定。
- 为可排序事件提供单调序列号，保证 Chat 在异步、重放和跨插件广播场景下不会用旧状态覆盖新状态。
- 让审批、拒绝、超时、取消和 Turn 结束都能进入明确的 resolved/terminal 终态，并能由请求方准确关联和恢复。
- 保持现有 JSONL trace 和已存在会话的读取兼容，使 Chat 能从旧 trace 或新事件重建等价的 Transcript。

## 范围

- Agent Plugin 与 Chat Panel/Chat Plugin 之间的会话、Turn、Item、Request 关联字段和事件类型。
- Agent Adapter 的 Item 生命周期、trace append、状态广播及审批请求/响应的协议整理。
- Chat 对事件序列、Item 生命周期、审批终态和历史 trace 的解析、排序、去重及 Transcript 重建。
- Agent 与 Chat 之间 request/broadcast 的消息顺序、触发方、接收方和终态通知；必要时同步 Agent Kit 内 Model Service 适配层的协议类型，但不改变 Provider streaming 实现。
- 新旧 JSONL trace 的兼容读取、字段缺省处理，以及覆盖正常完成、工具调用、审批、拒绝、超时、取消和失败的聚焦测试。

### 消息链路约定

1. Chat 发送用户消息时，以定向 request 调用 Agent，并携带 `conversationId`；Agent 创建 `turnId`，随后以 broadcast 通知 Turn/Item 的生命周期和 trace 追加。
2. Agent 开始一个 Item 时，向 Chat broadcast `item.started`；有增量内容时按序 broadcast `item.delta`；Item 结束时 broadcast `item.completed`。Chat 只把 `item.completed` 作为最终权威快照，同时可用 delta 更新实时视图。
3. Agent 需要模型能力时，以定向 request 调用 Model Service；模型结果或适配层事件由 Agent 归并为带上述关联键的 Agent Item 事件，再 broadcast 给 Chat。Model Service 不直接改变 Chat Transcript。
4. 工具或审批触发方为 Agent。Agent 先持久化/广播审批 `asked`（带 `conversationId`、`turnId`、`itemId`、`requestId`），Chat 接收后展示待处理项；用户操作后 Chat 以定向 request 将同一组关联键和 outcome 返回 Agent。
5. Agent 校验审批归属并继续或终止工具/Turn，随后 broadcast `approval.resolved` 和对应 Item/Turn 的终态；拒绝、超时、取消或 Turn 结束也必须产生可重放的 resolved/terminal 事件，Chat 不得保留已失效的待审批状态。
6. 事件序列号由产生并持久化事件的 Agent 侧分配，Chat 按会话和序列号应用事件，重复或更旧的事件幂等丢弃；重放历史时仍遵循同一规则。

## 非目标

- 不实现 Provider 的真正 HTTP streaming、token 级流式传输、背压或断线续流。
- 不设计或修改 Framework 的消息总线、runtime API、宿主模型或存储抽象。
- 不修复文件工具 workspace 越界、`web_fetch` SSRF、Model Service caller ACL 或其他安全问题。
- 不重做会话存储迁移、跨会话写队列、trash 策略或插件 unload/reload 生命周期。
- 不改变现有模型 Provider 的能力范围、计费策略、模型选择或用户界面视觉设计。
- 不删除或破坏旧 trace；若旧记录缺少新字段，按兼容规则读取，不要求历史文件回写升级。

## 验收标准

- 协议类型和聚焦测试明确区分四种关联键的作用；所有新 Agent/Chat 事件带所属会话和 Turn，Item 事件带 `itemId`，定向交互请求及其结果带 `requestId`。
- 普通用户消息、模型消息、推理、工具调用、工具结果和审批事件均可通过 discriminator/tagged union 判别，非法或未知 tag 不会被静默当作成功消息。
- 每个正常 Item 均遵循 `item.started →（零个或多个 item.delta）→ item.completed`；Chat 使用 completed 快照收敛最终内容，重复 delta、缺失 completed 或不属于当前 generation 的事件不会污染最终 Transcript。
- 事件携带作用域内单调序列号；同一会话的重排、重复和旧事件处理结果可验证，旧状态不能覆盖已应用的新状态。
- Chat 可仅凭新事件流重建包含消息、推理、工具调用和工具结果的 Transcript；读取既有 JSONL trace 时能兼容缺省的新关联字段，并保留原有可见内容和状态。
- 审批请求创建时生成并广播完整关联键；只有同一组关联键的响应才可 resolve。批准、拒绝、超时、取消和 Turn 结束均产生唯一终态，重复响应幂等，Chat 不残留 waiting 状态。
- Agent、Chat 和 Model Service 之间的 request/broadcast 顺序符合本 Task 的消息链路约定，并有测试覆盖发送、正常完成、工具审批、拒绝、异常、取消和历史恢复。
- 不引入 Provider streaming 或 Framework 改动；变更文件保持在 Agent Kit 相关 Plugin/Kit 范围内，超出范围的需求记录为后续 Task。
- 运行目标 Plugin/Kit 的聚焦类型检查、构建和测试通过；`node scripts/task-status.mjs check 2026-08-21-agent-turn-event-protocol` 通过。

## 约束

- 遵循 Harbors 的 request/broadcast 消息交互约定：定向 request 用于有明确调用方和响应的操作，broadcast 用于状态、生命周期和 trace 通知；不得以共享可变内存替代消息关联。
- 以当前 Agent Kit 已有 JSONL trace 和消息命名为兼容基线，新增字段应可选读取、明确默认值，并避免改变已有客户端能理解的终态语义。
- 事件序列号必须在持久化/广播前确定，不能由各个 Chat renderer 或异步 context 查询自行生成。
- 取消、失败、超时和拒绝必须是显式终态，不能通过未发送事件或通用 `UNKNOWN` 状态隐式表示。
- 只修改 Agent Kit 相关边界；若实现需要 Framework、其他 Kit 或跨插件目录之外的改动，先暂停并建立独立 Task。
- 文档和协议说明使用中文；测试覆盖乱序、重复、旧事件和晚到审批响应等边界情况。

## 需求变更

- 原始审查提出了 Session/Turn/Item/Request、事件生命周期、审批终态、序列号和 trace 重建等改进项；本 Task 将其合并为 Agent/Chat 事件协议重构。
- 为保持边界清晰，真正的 Provider streaming 与完整取消实现明确拆到后续 `agent-streaming-cancellation` Task；Framework 能力和运行时存储改造也不纳入本 Task。
