# Agent Context Store

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../2026-10-22-agent-turn-durability/summary.md)。

Task ID: `2026-08-26-conversation-knowledge-base`
Type: `feature`

- 当前复核状态（2026-10-22）：implementation blocked，verification / consolidation pending；机器状态由主 Agent 通过 Task CLI 管理

## 结论

Harness Kit 已使用 `agent-context-store` Session Plugin 保存 Conversation event，并在每个模型 step 按当前目标、有效状态、近期轨迹和新发现的路径、错误或 ID 装配 Context。每 User + Plugin 一个 active SQLite Store，同 User 跨基础 Session 共享，不同 User 独立；Conversation schema 和生命周期属于 Plugin。

Agent 不再读写 JSONL 或数据库，只通过同进程同步 `callPlugin()` 调用 Context Store，复用现有 request/callers 授权。Framework 只管理 User、基础 Session、Plugin 通用身份与能力边界，不接管 Conversation；旧无 User 路径不回退。Chat、Conversation 和 Model Service 保持原有职责。

2026-10-22 复核发现：流式写入排队后立即广播、Stop 超时仍返回 true 两项 P1 实现缺口，以及 Q30 candidate 仅 89/90 可评分的严格门禁缺口。因此本 Task 不能维持“全部完成”。以下分别记录当前事实、目标设计、实现缺口与历史证据；[本轮文档核对 Task](../2026-10-22-context-store-design-reconciliation/task.md) 不授权修复代码或重新评测。

## 背景与问题

本 Task 启动前，每个 Conversation 使用一份 JSONL 保存完整事件，并在进程内折叠为模型可见 surface。该历史方案随着历史增长，会遇到：

- 恢复和查询成本持续上升；
- 难以按目标、文件、错误、工具结果、取消和替代关系检索；
- 全量提交浪费 Token，只在初始阶段检索又无法预知执行中才出现的依赖；
- 向量相似度不能可靠处理精确 ID、强约束和显式失效；
- JSONL 与数据库长期双写会产生两个运行时事实源。

因此需要把“保存历史”和“给模型装配本次 Context”统一到一个可查询、可审计的存储组件中。

## 目标

1. 用 SQLite events 替换 JSONL，成为 Conversation 内容的唯一运行时事实源。
2. 用独立 Session Plugin 隔离 Agent 与持久化、检索和历史 Context 选择。
3. 在每个模型 step 按单次输入上限动态构造 Context，并支持执行中新锚点触发历史召回。
4. 用结构化 event 和确定性 reducer 维护当前目标、约束、取消和替代关系。
5. 无损保留现有 event、surface、tool、approval、归档和审计语义。
6. 新安装直接创建空 SQLite；无论磁盘上是否存在旧 JSONL，都不扫描、不导入、不回退。

## 范围

- Framework Plugin Runtime：通用硬依赖、拓扑加载和反向卸载；
- agent-context-store Plugin：共享 SQLite、canonical API、事件与投影、检索和 Context Plan；
- Agent Plugin：存储调用切换、每 step buildContext、trace 和错误呈现；
- SQLite 空库初始化、版本指针和完整性检查；备份/恢复设想的实现边界另列，不视为已交付能力；
- Conversation 创建、读取、重命名、归档、恢复和删除；
- Context 装配差分测试和不劣化门禁；
- 针对性单元、集成和 Web 验收；
- 最终实现对应的 architecture 与 guide 文档同步。

## 非目标

- 不做跨 Conversation 或跨用户长期记忆。
- 不在 MVP 中引入外置向量库、图库、sqlite-vec、HNSW 或远端 embedding。
- 不在 MVP 中提供 recordFeedback、feedback_events 或在线权重学习。
- 不让模型分类结果直接成为有效状态；模型只能产生候选。
- 不允许 Chat、UI Plugin 或 Model Service 直接访问数据库。
- 不为 Context Store 内部状态增加广播。
- 不读取或导入任何旧 JSONL，不提供 JSONL 运行时回退或长期双写。
- 不承诺通过首次启动恢复旧 JSONL 会话；需要保留的历史数据必须在部署前另行处理。
- 不扩展“活动 Turn 接收第二条纠正消息”的输入协议。
- 不改变 Web-only 宿主边界。

## 当前架构与目标设计

### 组件与职责

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Framework Plugin Runtime | 通用身份与归属、Plugin 硬依赖、拓扑加载与反向卸载，切换失败时尝试恢复旧 Kit | Conversation、SQLite 和 Context 业务 |
| `agent-context-store` | Conversation 持久化、确定性状态、检索、历史 Context 选择和生命周期 | Model Service、tool loop 和 Chat trace |
| Agent | Turn/tool loop、单次输入预算、Context Store 调用、最终 Provider request、Model Service 和 trace | 数据库、历史检索和历史裁剪算法 |
| Conversation Plugin | 工作台选择态、draft、running、generation/revision 和最近项目 facade | Conversation 持久化事实和最近项目投影 |
| Chat | 用户输入和 trace 展示 | Agent 私有历史和数据库 |

Context Store 是 Agent 的硬依赖。静态预检失败不卸载旧 Kit；加载失败时新 Kit 不激活，并尝试恢复旧 Kit。只有恢复成功才可继续；恢复本身失败则 Editor 不可用并 fail closed，保留激活与恢复错误，需重建 runtime。不能保证无条件完整恢复，MVP 不新增“部分 Plugin 激活”状态。

### Context Store 的职责

`agent-context-store` 当前承担以下职责：

1. 原子保存完整 canonical event，并分配连续 Conversation seq；
2. 从结构化 state/relation event 确定性重建目标、约束、决策、阻塞、取消和替代关系；
3. 从 event 文本中按精确 path、error 和 ID 锚点召回当前 Conversation 的旧证据；
4. 按 Agent 提供的单次输入预算选择 mandatory state、当前 Turn、近期历史和相关证据；
5. 记录可清理的 Context Plan，说明本次选择、来源和排除结果；
6. 提供 Conversation 基础 metadata、trace、归档、恢复和删除；重命名、设置、权限等 facade 由 Agent 通过基础 API 组合；当前无通用备份恢复平台。

它不向 Chat 广播内部状态，也不允许 Chat、UI Plugin 或 Model Service 直接访问数据库。

### Canonical API

Store 当前公开以下 12 个方法，与 methods/manifest 一致；不要将 Agent 同名或派生 facade 当作 Store API：

| 接口组 | Methods | 用途 |
| --- | --- | --- |
| 状态 | `getStatus` | 检查 Store、schema 和数据版本是否可用 |
| Conversation | `createConversation`、`listConversations`、`loadConversation` | 管理 Conversation metadata 和列表；list 接受 active/archived 状态 |
| Trace | `appendEvent`、`getConversationTrace`、`getConversationTraceSince` | 写入和读取完整 AgentTraceEvent |
| Context | `buildContext`、`recallHistory` | 构造本 step 历史 Context，或显式召回当前 Conversation 证据 |
| 生命周期 | `archiveConversation`、`restoreConversation`、`deleteArchivedConversation` | 管理归档、恢复和永久删除 |

`listArchivedConversations`、`renameConversation`、`getConversationTracePage`、options/context/permissions 和 recent projects 等由 Agent 组合、分页或派生。Store 方法同步返回；Host 绑定真实 `agent` caller，复用 manifest request 声明与 callers 限制，不新增独立 ACL。append 使用 `idempotencyKey` 去重。完整范围见 [Agent Context Store Plugin 设计](design/agent-context-store-plugin.md)。当前没有 JSONL 导入或导出 API。

### 数据与状态

- 每 User + Plugin 一个 active SQLite，所有业务表显式携带 `conversation_id`，默认禁止跨 Conversation 内容查询；Framework 从可信身份绑定 `runtime.paths.data`，同 User 的不同基础 Session 共享，不同 User 独立；
- `events` 保存完整 canonical envelope，是 Conversation 内容的事实源；
- `current_state` 和 Conversation metadata 都可从 events 重建；Context Plan 是可清理诊断；
- 数据放在版本目录中，`current.json` 指向唯一 active version；
- 永久删除在 SQLite 事务内检查 archived、原子写入版本目录外 tombstone、DELETE 并提交；已写 guard 不随数据库回滚撤销，当前启动与 restoreConversation 检查 guard。当前没有 operation journal 或旧版本恢复入口，不宣称 backup 恢复已验证。

只有结构化 state/relation event 能改变当前有效状态。模型或分类规则可以提出 candidate，但不能直接写入 active state；目标不明确时由 Agent 向用户确认。

Agent 为模型提供私有工具 `update_conversation_state`。模型调用只产生 candidate；Agent 校验目标类型、引用的既有 state ID、动作与字段后，才转换为 `state/set`、`state/clear`、`relation/cancel`、`relation/supersede` 或 `relation/confirm` event。引用不存在、动作含糊或字段不合法时拒绝写入并要求模型向用户确认。

### 每个模型 step 的 Context 装配

上下文按“当前状态、当前 Turn、历史 Turn”三层处理：

- **当前状态**：当前目标、有效约束、已确认决定和未完成事项，每个 step 都必须提供给模型，不依赖检索命中；
- **当前 Turn**：从本轮用户消息开始，到本轮结束前产生的 assistant message、tool call/result 和已成功加载的 Skill，按发生顺序累积到下一 step，不作为旧历史压缩；
- **历史 Turn**：`surface-v1` 继续保留现有 compaction 语义；候选模式只选择近期内容和与当前锚点相关的证据，原始 event 仍保存在 SQLite 中并可显式召回。

因此，多轮机制改变的是“后续轮次如何使用以前的内容”，不会改变同一轮内工具循环的闭包：例如本轮先后读取两个文件，第二次模型调用必须同时看到两次 tool call/result；到了第 10 轮，系统可以不携带第 1 轮文件全文，但在路径、错误码或决定重新出现时，应召回相应证据，并重新读取可能已经变化的当前文件。

1. Agent 从模型 context window 中扣除 System、tools、权限定义、输出预留和安全余量；
2. Agent 将 `availableInputTokens`、预算明细和本 step 新锚点传给 `buildContext`；
3. Context Store 依次选择 mandatory state、当前 Turn、最近 8 条 surface event 和精确 anchor 证据；
4. cancelled、superseded、expired 内容在排序前过滤；
5. tool、approval 和 item 生命周期按完整关系选择，不拆散协议；
6. 当前 Turn 未消费的 canonical tool result 和已成功加载的 Skill body 不做历史裁剪；这里的“完整”以工具层已返回并持久化的边界为准，不绕过工具与 Skill 自身的大小限制；
7. Agent 将返回的历史 messages 原样加入最终 Provider request，不再二次裁剪。

tool result 出现新的文件、命令、错误或 Task ID 后，下一 step 会用这些锚点重新召回历史，因此第一个 step 不需要预知执行过程中的全部依赖。

### 消息链与未完成的可靠性目标

1. Chat 通过 request 调用 Agent。
2. Agent 同步 callPlugin 调用 Context Store，持久化用户和 Turn 事件。
3. 每个模型 step 前，Agent 计算预算并同步调用 Store `buildContext`。
4. Agent 组装 System、tools 和 Store 返回的 messages，通过 request 调用 Model Service。
5. Agent 通过 broadcast 向 Chat 发送 trace/delta；这些通知限于当前 Session runtime，同 User 其他 Session 通过读取或刷新看到共享历史，未增加跨 Session 实时同步。

目标要求第 5 步先完成 Store 持久化，再广播；终态必须等待已接收队列收口并保存唯一 `turn/end`。当前普通 append 的 trace listener 在提交后执行，但流式回调写入排队后即 onDelta/broadcast，尚不满足该目标；Stop 也可能等待超时后返回 true，不能证明 cancelled terminal 已落盘。

最小目标机制保持既有同步 Store、delta 回调、broadcast 及 `stopConversation(): Promise<boolean>`：将 onDelta 放入串行写队列中，append 成功后才通知；首个写失败关闭 generation 并取消上游，晚到 delta/result 被拒绝。终态等待队列收口，由当前 Turn 的唯一写入点产生。Stop 无 active Turn 返回 false，只有 cancelled `turn/end` 持久化成功才 true；超时或持久化失败走既有 rejection 通道，不广播“已停止”。完整机制与延迟/失败/终态竞态/重复 Stop 故障门禁见 [Agent 集成设计](design/agent-plugin-integration.md)。本次仅完善目标，不宣称代码已修复。

### 首次初始化与 Context 切换

首次启动只创建一个空的版本化 SQLite，完成 schema、metadata 和完整性检查后，通过一次原子 `current.json` 写入激活。初始化过程不得枚举 `runtime.paths.legacyData`、`storage-v1`、`.jsonl`、旧 archive 或旧 `.deleted` marker；这些文件即使存在也不影响新 Store。

已有 `current.json` 时只打开其指向的 SQLite，不重复初始化，也不读取 JSONL。版本目录、初始化锁和 journal 只负责 SQLite 自身的原子发布与崩溃恢复，不承担旧数据导入。

Context Builder 的 `surface-v1` 与 `candidate-v1` 用于模型输入差分和紧急诊断，不代表存储回退。当前代码默认使用 candidate-v1，但 Q30 严格门禁尚未闭环，不能把默认值解释为 P100/Q30/全部故障验收已通过；本次不改变代码默认值。

## 核心对话测试用例

| 用例 | 场景 | 必须证明 |
| --- | --- | --- |
| S1 单轮状态 | 用户给出一个目标和明确约束 | goal/constraint 正确进入 mandatory state，不引入无关历史 |
| S2 单 Turn 文件累积 | 同一 Turn 依次读取两个文件并执行工具 | 下一 step 保留用户消息、两个 tool call/result 和顺序，不把当前 Turn 当旧历史压缩 |
| M3 多轮纠正 | 第 1 Turn 提出动作，第 2 Turn 明确取消并替换，第 3 Turn 继续 | 旧动作被 cancelled/superseded，后续只执行新目标 |
| M10 十轮延迟召回 | 第 1 Turn 读取文件并形成决定，第 2～9 Turn 处理其他内容，第 10 Turn 通过路径、错误或工具结果重新关联 | 下一 step 召回第 1 Turn 的相关证据，同时重新读取当前文件，不使用过期文件正文 |
| N10 错误召回 | 历史中存在名称相似但无关的文件、错误和已取消目标 | 无关或失效内容不进入最终 Context |
| L20 长对话 | 20 个以上 Turn，包含 checkpoint、大 tool result 和多次继续 | 当前状态和当前 Turn 完整；候选模式可排除旧正文，但 source seq 可追溯并能显式召回原文 |
| O1 超预算 | 当前 Turn、Skill 和历史证据共同接近模型窗口 | 优先移除低优先级旧历史；当前 Turn 不被静默裁剪；最多一次有界重建且不重复工具副作用 |
| P100 性能增长 | 使用 1、10、50、100 Turn 的固定 fixture 执行同类查询 | 独立 benchmark 记录机器、Node、SQLite 配置和原始样本；输入 Token 受预算约束，固定 fixture 的候选来源不超过 9；同机 100 Turn 候选 P95 不超过当前 surface-v1 的 2 倍，且不超过 10 Turn 候选 P95 的 4 倍 |
| Q30 真实模型质量 | 10 个单轮目标/约束、10 个多轮纠正、10 个延迟召回用例 | 独立 eval runner 固定模型配置并逐例对比当前基线；缺少 Provider 凭据时明确跳过而不伪造通过；不得出现新增高严重度错误动作 |

确定性测试必须断言最终 `BuildContextOutput`、source seq、Context Plan、状态 digest 和 Model Service input；真实模型只用于小规模检查继续任务成功率、约束遵循、重复工作和错误工具调用。

### 历史验证记录（2026-08，非本轮重验）

- 确定性用例已覆盖单轮状态 candidate 的校验与持久化、同 Turn tool call/result 闭包、三轮纠正、十轮精确锚点召回、相似负例排除、长对话显式召回和预算溢出。
- P100 在 Apple M3 Pro、Node 22.19.0 上按 1/10/50/100 Turn、每种 build 30 个样本执行，三项门禁全部通过；100 Turn 的候选来源为 9，没有随 100 条历史全文增长。原始样本见 [P100 结果](artifacts/p100-result.json)。
- Q30 使用 Harness 正式 `model-service.complete` 消息链和 `alwaysday1`，三类各 10 例、每例 3 次。v2 保持原有业务意图，只明确最终状态字段和值类型，并将失效旧值限定到对应状态字段；等价表达、标量/单元素数组和否定句不再误判。2026-08-29 原始结果为 current 90/90 可评分且 90/90 通过，candidate 89/90 可评分且 89/89 通过；candidate M09 repeat 1 在有限补跑后仍为 Provider 空响应，报告 `regressions` 保留该次记录。已评分答案没有语义失败，但严格门禁要求 candidate 全部 90 次可评分、通过数不低于 current、无同 case/repeat 新增回归，当前未通过。原始数据不改写，`status: completed` 仅表示 runner 结束，见 [Q30 结果](artifacts/q30-result.json)。
- Q30 注入期望最终有效 state（oracle state），只隔离比较 Context 装配。模型产生和 Agent 接受 state candidate 的协议由独立确定性 Agent 集成测试覆盖其范围；不能把 Q30 外推为真实模型状态抽取准确率或完整工具链路通过。
- Harness 单元测试 325/325、assembly 10/10、Plugin smoke 3/3、Framework Plugin 47/47、Kit Core 113/113、Server 797/797 均通过；隔离 data root 的 Web 宿主加载 14/14 Plugin，并创建共享 SQLite 与 current pointer。2026-08-29 已在完整备份后迁移真实 data root：journal 为 `accepted`，SQLite `integrity_check=ok`，共 11 个 Conversation、49,725 个 event，连续 seq 异常为 0；6 个 active/available、1 个 active/unavailable 和 4 个 archived Conversation 均被保留，旧 `storage-v1` 与迁移前备份逐文件哈希一致。
- 仓库全局 `check:preflight` 仍被 4 个本 Task 未修改的既有边界问题阻断：3 个 `prompt-eval` 测试跨 Kit import，以及 `kit-picker.test.ts` 的静态 Kit identity 列表；除该静态架构检查外，其余 preflight 用例通过。

## 模块详细设计

1. [Framework Plugin Runtime](design/framework-plugin-runtime.md)：依赖声明、加载、卸载、回滚和 Framework 错误。
2. [Agent Context Store Plugin](design/agent-context-store-plugin.md)：完整 API、数据模型、事务、reducer、检索、Budget 和 Context Plan。
3. [Agent Plugin 集成](design/agent-plugin-integration.md)：调用时机、Turn/tool loop、trace 和错误呈现。
4. [初始化与运行保障](design/migration-and-operations.md)：空库初始化、发布、生命周期、故障边界与未实现的备份恢复需求。
5. [兼容性与不劣化门禁](design/compatibility-and-regression.md)：现有行为基线、分阶段切换、差分测试和 Web 验收。

这些文件共同属于本 Task。实现完成后，稳定架构事实必须同步到 docs/architecture。

## 可靠性与取舍

- **SQLite 成为关键事实源**：当前有完整性检查；一致快照备份、新版本恢复与对象校验仍未实现，若成为需求需单独明确，不用历史一次性迁移代替当前能力。
- **硬依赖扩大 Kit 切换故障面**：Context Store 故障阻止新 Kit 激活；旧 Kit 仅在恢复成功时可继续，恢复失败须 fail closed 并重建 runtime。
- **共享数据库存在并发竞争**：必须验证多个 Editor Runtime 的 WAL、transaction 和 lease。
- **首次 step 可能没有全部历史**：依靠 mandatory state、近期 surface、新锚点和 `recall_history` 补足。
- **旧 JSONL 不会自动出现**：这是明确的产品取舍；部署方若仍需要旧会话，必须在启用新版前另行处理。

## 验收标准

- SQLite events 是唯一运行时事实源；首次启动、重启和正常运行都不访问 JSONL。
- Agent 只通过 Context Store canonical API 操作 Conversation。
- 硬依赖缺失、成环或加载失败时新 Kit 不激活；旧 Kit 恢复成功才可继续，恢复失败则 fail closed，保留激活/恢复错误并重建 runtime。
- current_state 可由结构化 state/relation events 确定性重建。
- 每个 Model Service step 前重新 buildContext，新锚点可影响下一 step。
- Agent 只计算 availableInputTokens，不二次裁剪 Context Store 结果。
- assistant tool call 与 tool result 不被拆散，排除的旧正文仍可按 source seq 追溯。
- cancelled、superseded、expired 历史内容在排序前过滤。
- 每次模型请求有 Context Plan ID 和可解释选择记录。
- 空库初始化使用版本目录和单一原子 current 指针，崩溃后可判定恢复。
- 当前启动与 restoreConversation 应用外部 tombstone guard；不宣称已具备通用旧版本恢复能力。
- 多 Runtime 并发、数据库损坏和初始化崩溃恢复有自动化测试。
- Context Builder 必须通过完整差分门禁才可判定受控切换完成；当前代码已默认 candidate-v1 与门禁未闭环的差距不得隐去。
- S1、S2、M3、M10、N10、L20、O1 和 P100 的历史测试只证明各自覆盖范围；Q30 必须 candidate 全部 90 次可评分、通过数不低于 current 且无同 case/repeat 新增回归，目前缺 1 次 Provider 空响应。
- 流式必须持久化成功后才广播，写失败停止 generation；终态等待队列收口；Stop 仅在 durable cancelled terminal 后成功。上述故障验收当前未完成。
- Harness Kit 针对性测试与 Web 浏览器验收通过。

## 约束

- Harbors 只支持 Web 宿主。
- Plugin 是独立业务单元；Framework 不承载 Context Store 业务。
- 对外业务继续使用现有 request/broadcast；内部高频调用使用现有 callPlugin。
- 共享可见行为必须执行 Web 浏览器验收。
- 当前实现依据：[agent-turn-event-protocol](../../architecture/agent-turn-event-protocol.md)、[plugin-runtime-model](../../architecture/plugin-runtime-model.md)、[kit-and-session-model](../../architecture/kit-and-session-model.md)；[旧 JSONL Task](../2026-08-23-agent-jsonl-v1/task.md) 仅作历史格式背景。
- 开发与测试依据：[developing-plugins-and-kits](../../guides/developing-plugins-and-kits.md)、[testing](../../guides/testing.md)。

## 需求变更

- 2026-08-29：取消首次 JSONL 迁移。新安装直接创建空 SQLite，旧 JSONL 不扫描、不导入，也不作为运行时回退。
- 2026-10-22：按当前代码、ADR 0005 和原始评测复核文档；撤下 JSONL 导出承诺，校正 User+Plugin 与 callers、运维和回滚边界，将流式、Stop 及严格 Q30 重新列为未完成。此次为文档核对，不新增代码实现或模型评测授权。
