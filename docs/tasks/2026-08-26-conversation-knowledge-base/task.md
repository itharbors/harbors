# Conversation Knowledge Base 设计

Task ID: `2026-08-26-conversation-knowledge-base`
Type: `feature`

- 状态：需求已定义，设计待评审，尚未进入实现

## 背景与问题

Agent 当前以每个 Conversation 一份 JSONL 保存完整事件，并从中折叠出供模型使用的对话表面。随着对话增长，把全部历史持续提交给模型会增加 Token、延迟和噪声；只依赖向量召回又可能漏掉当前意图、约束、撤销关系和精确标识符。

本 Task 设计一个 Conversation 级小型知识库。它负责识别知识、维护知识生命周期、组合模型上下文，并清理可重建的过期投影；JSONL 仍是唯一事实源，SQLite、FTS 和向量索引均为可重建投影。

这里所说的 Session 对应 Agent 的 `conversation_id`，不是 Framework Session Runtime。后文统一称为 Conversation。

## 目标

1. 每个 Conversation 独立管理 JSONL、知识投影、附件和产物，并可整体归档或删除。
2. 区分“当前仍有效”“被撤销/替代”“长期未使用”“允许物理清理”，避免仅凭时间错误删除知识。
3. 高频且确实有用的知识逐步增强；长期不用的知识降低召回权重，但不自动等同于失效。
4. 在减少上下文 Token 的同时，保证当前意图、强约束、未完成事项和工具状态不依赖 RAG 的偶然命中。
5. 所有知识均可追溯到 JSONL 事件，SQLite 损坏或删除后能够完整重建。
6. 为“前面的事情算了”“我说错了”等修正建立显式关系，确保旧意图不会被再次召回并执行。

## 范围

本 Task 覆盖 Harness Kit 的 Agent Plugin 内部 Conversation 知识投影、上下文装配、检索、生命周期维护、独立存储目录及 v1 到 v2 迁移设计；涉及共享可见行为时，覆盖既有 Chat → Agent → Model Service 消息链路和 Web 验收，但不改变其他 Plugin 的事实所有权。

## 非目标

- 不把 Conversation 知识直接晋升为跨 Conversation 的用户长期记忆。
- 不在第一阶段自动物理改写或裁剪 JSONL。
- 不把 Token 压缩等同于知识生命周期管理。
- 不在未明确平台约束前引入带原生二进制的向量扩展。
- 不改变 Chat 对 Agent 存储的所有权边界。

## 核心判断

### 1. JSONL 与 SQLite 的职责

| 数据 | 职责 | 何时使用 |
| --- | --- | --- |
| JSONL | 唯一事实源、事件顺序、原始消息、工具调用与结果、撤销和替代关系 | 写入、审计、精确回退、重建、导出、迁移 |
| SQLite 结构化表 | 当前知识状态、关系、权重、TTL、来源位置、维护队列 | 每轮上下文装配、过滤、排序、维护 |
| FTS/向量索引 | 候选召回 | 相关历史无法由近期窗口和强制状态覆盖时 |
| Checkpoint/Surface | 最近一次可验证的对话折叠结果 | 快速恢复、近期窗口、Token 压缩 |

SQLite 不能成为第二事实源。任何会改变知识有效性的操作都必须先形成 JSONL 事件，再由投影器更新 SQLite；否则重建索引时已删除的知识会“复活”。

### 2. 三个正交维度

知识不能只用一个 `weight` 表达全部状态：

- `validity`：`active | cancelled | superseded | expired`
- `retention`：`normal | pinned`
- `temperature`：`hot | warm | cold`

`pinned` 只表示保留和优先展示，不覆盖有效性。`cancelled`、`superseded`、`expired` 在召回排序前硬过滤。

### 3. 降权不等于删除

- 长期未使用：降低温度和召回分数。
- 明确取消：立即变为 `cancelled`。
- 新版本取代旧版本：旧知识变为 `superseded`，并记录替代关系。
- 到达明确 TTL、来源失效或复核失败：变为 `expired`。
- 只有派生索引经过宽限期后允许物理清理；原始 JSONL 默认保留到整个 Conversation 被归档或删除。

## 需求

### R1. Conversation 独立存储

采用“一 Conversation 一目录”的目标布局，使数据库、JSONL、附件和产物能够一起迁移、归档和删除：

```text
<agent-data>/storage-v2/
├── conversations/<conversation-id>/
│   ├── events.jsonl
│   ├── context.sqlite
│   ├── attachments/
│   ├── artifacts/
│   └── manifest.json
├── tombstones/<conversation-id>.json
└── .harbors-trash/<conversation-id>-<time>-<random>/
```

`manifest.json` 只记录格式版本和重建检查点，不保存不可恢复的业务事实。

### R2. 知识与意图生命周期

投影器至少识别以下对象：

- 当前目标与子目标
- 用户约束和偏好
- 已确认决策
- 实体、文件、路径、ID 和错误信息
- 未完成动作、工具状态和阻塞项
- 可复用事实及其证据
- 意图之间的取消、替代、细化和恢复关系

建议事件：

```text
intent/created
intent/relation
knowledge/created
knowledge/updated
knowledge/cancelled
knowledge/superseded
knowledge/expired
knowledge/reactivated
knowledge/used
knowledge/compacted
knowledge/index-purged
```

事件载荷必须包含 `knowledgeId`、`sourceEventSeqs`、时间、原因和版本；关系事件还应包含 `fromId`、`toId`、`relation`。现有开放字符串 payload 类型允许先在 Agent Plugin 内扩展，无需把知识状态塞进封闭的 Record 类型。

### R3. 修正和取消

当用户说“前面的事情算了”时，系统不能靠语义相似度猜测要跳过什么：

1. 根据当前活动意图栈、最近 Turn 和显式指代解析目标意图。
2. 产生 `intent/relation(relation=cancel)` 事件。
3. 将关联知识投影为 `cancelled`。
4. 在所有 FTS/向量排序之前硬过滤该知识。
5. 如果取消目标不唯一，先停止相关动作并向用户确认，不静默选择。

当前实现只支持取消正在执行的 Turn，并且执行中拒绝第二条用户消息。因此，“运行中立刻纠正上一条消息”需要单独扩展输入与取消协议，不能只靠知识库实现。

### R4. 权重衰减与增强

召回分数建议由以下因素组成，而不是直接修改 embedding：

```text
score = validity_gate × (
  semantic_similarity
  + lexical_match
  + entity_match
  + recency_score
  + importance_score
  + usefulness_score
  + relation_score
)
```

衰减使用可配置半衰期：

```text
recency_score = exp(-ln(2) × age / half_life)
```

只有确认产生价值时才增强 `usefulness_score`，例如：

- 用户明确确认该知识有用；
- 最终回答实际引用了它；
- 它影响了已确认决策；
- 它支撑了成功的工具结果。

仅被搜索出来不算使用，避免热门知识自我强化。增强值要设上限，并保留少量探索配额，防止新知识永远没有曝光机会。原始检索曝光只记指标；确认有用才写 `knowledge/used` 事件。

### R5. 维护与清理

维护分五级，风险逐级提高：

1. **隐藏**：失效知识立即退出可召回集合。
2. **降温**：长期未使用但仍有效的知识从 hot 降为 warm/cold。
3. **压实**：合并重复知识，但保留全部 `sourceEventSeqs` 和旧到新的关系。
4. **清理投影**：宽限期后删除无效知识的 FTS、向量和派生行，可由 JSONL 重建。
5. **Conversation 归档/删除**：关闭写入和数据库后，整体移动目录并写外部 tombstone。

自动过期只能依据明确 TTL、`validUntil`、来源版本失效或复核失败。单纯“很久没用”只能降温，不能变为 expired。

归档顺序：拒绝或取消活动 Turn → 阻止新写入 → 排空写队列 → SQLite WAL checkpoint 并关闭 → 原子移动整个目录 → 写入并 `fsync` 外部 tombstone。中途失败必须可补偿或恢复。

### R6. 上下文完整性

每轮模型上下文按以下优先级组装：

1. System 与工具定义
2. 强制状态：当前目标、约束、已确认决策、阻塞项、待执行动作
3. 当前 Turn 的用户输入和工具上下文
4. 最近 JSONL Turn 窗口
5. 最新 Checkpoint/Summary
6. 混合召回的历史证据

强制状态不能依赖向量召回。近期窗口必须按完整 Turn 截取，不能截断 tool call/result 配对。

短 Conversation 在 Token 安全时可以提交完整 surface，但仍要应用权威的取消和替代关系；不能因为“全量提交”把已撤销指令重新解释为有效指令。

## 检索设计

### 查询构造

查询由最新用户消息、聚焦后的当前意图、实体/路径/ID/错误文本、未解决问题组成。不得只 embedding 最新一句话。

### 多路召回

- FTS：精确词、路径、ID、错误文本
- 向量：语义相似历史
- 实体索引：同一对象和别名
- 时间通道：近期相关 Turn
- 关系通道：目标的前置、替代和证据节点

候选可使用 Reciprocal Rank Fusion 合并，再应用 validity gate、权限过滤和业务排序。

### 来源扩展

候选知识命中后，必须扩展到：

- 精确 `sourceEventSeqs`
- 所在完整 Turn
- 配对的工具调用和结果
- 取消、替代、证明等关系事件

传给模型的片段带来源位置和状态，不只提供脱离语境的摘要。

### 低置信度兜底

当强制状态缺失、分数接近、精确标识符未命中或来源无法展开时，依次：

1. 扩大候选 K；
2. 使用精确实体、路径、ID 和 FTS；
3. 展开相关完整 Turn；
4. 根据 JSONL 序号定点读取；
5. 必要时扫描限定范围 JSONL；
6. 仍有歧义则向用户确认。

因此，RAG 是优化路径，不是唯一正确性路径。

## SQLite 与向量方案

第一阶段候选方案：Node.js `node:sqlite` + FTS5 + embedding BLOB + JavaScript 精确 KNN，封装为存储适配器。理由：保持 Kit 当前 `any/any` 的可移植边界，不引入原生 `.node`、平台/架构和 Node ABI 约束。

`better-sqlite3`、`sqlite-vec` 等原生扩展只有在明确接受 native-code 权限、发布矩阵和 ABI 运维成本后再采用。Prompt Builder 不直接依赖具体向量库，以便后续替换为 sqlite-vec、HNSW 或远端服务。

建议表：

- `knowledge_items`
- `knowledge_sources`
- `knowledge_relations`
- `intent_nodes`
- `intent_relations`
- `knowledge_fts`
- `knowledge_embeddings`
- `maintenance_jobs`
- `projection_checkpoint`

embedding 来源、模型版本、维度和内容哈希必须入库。远端 embedding 是否允许发送 Conversation 内容，需要单独的隐私决策；默认优先本地或已批准的 Model Service 能力。

## Plugin 边界与消息链路

实现范围原则上限制在 `kits/harness/plugins/agent/main`：

```text
src/context/
├── types
├── projector
├── classifier
├── store-adapter
├── retrieval
├── maintenance
├── prompt-builder
└── conversation-storage
```

主要链路：

1. Chat 向 Agent 发定向 `sendMessage` 请求。
2. Agent 先把输入写入 Conversation JSONL。
3. Agent 内部投影器同步或有界异步更新 SQLite，并推进 checkpoint。
4. Prompt Builder 读取强制状态、近期 Turn 和检索证据。
5. Agent 向 Model Service 发定向生成请求。
6. 模型与工具事件继续先落 JSONL，再更新投影。
7. Agent 通过现有 trace 广播对外通知，不允许 Chat 直接读取文件或 SQLite。

知识维护默认采用确定性规则。若未来需要 LLM 分类器，应扩展 Model Service 的 purpose/协议；不能私自在 Agent 中建立第二套模型调用路径。

## 一致性与恢复

- 写入顺序保持：JSONL 落盘 → 内存 fold → 投影更新 → trace 广播。
- SQLite 更新失败不能回滚已经成功的 JSONL；标记投影落后并从 checkpoint 重放。
- 每条知识保存来源序号和内容哈希，防止投影漂移。
- 启动时校验 `projection_checkpoint <= JSONL tail seq`，落后则增量重放，超前则废弃并重建。
- 删除 `context.sqlite` 后，必须仅凭 JSONL 得到语义等价的有效知识集合。
- 并发维护与 Turn 写入共用 Conversation 级串行写边界，避免清理和新增交错。

## 存储迁移

从当前“一 Conversation 一 JSONL”迁移到 storage-v2，采用双读、v2 单写：

1. 新 Conversation 直接写 v2。
2. 旧 Conversation 仍可读取 v1，但不得在读取时偷偷迁移。
3. 显式迁移先写临时目录，复制并校验 JSONL，再构建 SQLite。
4. `fsync` 后原子发布 v2 目录并写迁移标记。
5. v2 优先读取；旧 v1 文件保留到验证期结束并获得清理授权。

回滚时停止 v2 新写入，保留 JSONL，删除可重建投影；不得把 SQLite 反向当作恢复事实源。

## 可观测性

至少记录以下指标：

- 强制上下文遗漏率：目标为 0
- 无效知识泄漏率：目标为 0
- 来源可追溯率与重建成功率：目标为 100%
- Recall@K、精确 ID/路径召回率
- 召回片段实际采用率
- 错误过期率和错误取消率
- 投影延迟与重建耗时
- 上下文 Token 降幅、组装延迟
- 每 Conversation SQLite/向量体积增长
- 归档、恢复和迁移成功率

维护决策要输出可审计原因，例如 `explicit_cancel`、`superseded_by`、`ttl_elapsed`、`source_invalidated`、`cooled_by_inactivity`，不能只记录新权重。

## 测试与验收

### 单元测试

- 状态转换矩阵以及 pinned 不覆盖 invalidity。
- 半衰期、增强上限、探索配额和仅检索不增强。
- 取消、替代、恢复关系投影。
- validity 硬过滤发生在排序之前。
- FTS、向量、实体和关系候选融合。
- 完整 Turn 与 tool call/result 扩展。

### 集成测试

- 输入“删除 xx”，随后“我说错了/前面的算了”，旧意图不会进入可执行强制状态或召回结果。
- SQLite 被删除或损坏后从 JSONL 重建，结果一致。
- 投影落后时能够从 checkpoint 追平。
- 归档活动 Conversation 时正确阻止新写入，并可从 trash 恢复。
- v1 到 v2 迁移中断后，不丢原始 JSONL，也不出现双写分叉。
- 短对话全量 surface 与长对话分层检索均遵守取消关系。

### Web 验收

这是 Kit 装配和共享可见行为变更，除针对性服务端测试外，必须在 Web 宿主验收：

- 连续发送、取消、纠正后的可见回答和工具行为；
- Conversation 重载后状态一致；
- 归档、恢复和删除交互；
- 长对话下 Token 和延迟指标。

## 验收标准

- JSONL 仍是唯一事实源，SQLite 可删除重建。
- cancelled/superseded/expired 不进入模型有效上下文。
- 当前目标、约束、决策、阻塞和待执行动作不依赖 RAG 命中。
- 每个召回片段可定位到原始事件和完整 Turn。
- 降温、失效、投影清理和 Conversation 删除具有不同操作与审计记录。
- 存储迁移可中断恢复，且不会无授权清理 v1 数据。
- 所有新增行为通过针对性测试和 Web 浏览器验收。

## 分阶段落地

### Phase 1：正确性基线

- 知识/意图事件与确定性投影
- 强制状态 + 近期 Turn + FTS
- 取消、替代、TTL 和来源追踪
- SQLite 可重建与指标

### Phase 2：语义召回

- embedding 生成与版本管理
- 向量候选、混合融合、来源扩展
- 低置信度兜底和离线召回评测

### Phase 3：生命周期维护

- 降温、确认使用增强、重复压实
- 投影清理、维护预算和审计
- storage-v2 迁移、整目录归档和恢复

### Phase 4：可选能力

- 经审批的 LLM 分类器
- 跨 Conversation 知识晋升
- 更高性能的原生或外部向量后端

## 风险与取舍

- **误取消**：关系解析错误会隐藏有效知识；歧义时必须确认。
- **漏召回**：只用向量会丢精确标识；采用强制状态、FTS 和 JSONL 回退。
- **投影漂移**：SQLite 写成功与 JSONL 不一致；坚持 JSONL 先写和 checkpoint 重放。
- **自我强化**：检索即加权会形成热门偏差；只有确认有用才增强并设置上限。
- **错误过期**：时间衰减被误作失效；温度与 validity 分离。
- **原生依赖**：sqlite-vec 影响 Kit 可移植性；先走适配器和纯 Node 基线。
- **磁盘增长**：每 Conversation 独立 SQLite 有固定成本；短 Conversation 可延迟建库或共享模板初始化，但生命周期仍保持独立。
- **隐私**：远端 embedding 可能外发内容；默认禁用，需明确能力与数据边界。

## 待评审决策

1. 第一阶段向量后端是否接受“`node:sqlite` + FTS5 + JS 精确 KNN”的可移植基线。
2. 哪些知识类型必须进入强制状态，以及近期窗口保留多少完整 Turn。
3. 不同知识类型的 TTL、半衰期、增强上限和投影清理宽限期。
4. 哪些信号足以写入持久化的 `knowledge/used`。
5. storage-v2、trash、tombstone 和旧 v1 文件分别保留多久。
6. 是否在本 Task 内扩展“活动 Turn 中接收纠正消息”的协议，还是拆分独立 Task。
7. embedding 使用本地能力、Model Service，还是批准的远端服务。
8. 短 Conversation 何时延迟创建 SQLite，以控制大量小数据库的固定开销。
9. 跨 Conversation 晋升是否永久排除在本 Task 外。
10. 是否存在必须物理擦除单条 JSONL 内容的合规场景；若有，需要另行设计不可恢复删除协议。

## 约束

- `docs/architecture/agent-jsonl-format.md`：Conversation JSONL 的事实源与所有权。
- `docs/architecture/agent-turn-event-protocol.md`：Turn 生命周期、取消和 trace 协议。
- `docs/architecture/model-service-plugin.md`：模型调用目的与 Plugin 边界。
- `docs/architecture/plugin-runtime-model.md`：Plugin 消息交互和运行时隔离。
- `docs/architecture/kit-and-session-model.md`：Framework Session 与 Kit 装配边界。
- `docs/guides/testing.md`：服务端针对性测试及 Web 验收要求。
- 决策记忆查询未命中相关既有决策；查询结果完整度为 partial，且有 1 个文件读取失败，因此本 Task 不把“无命中”解释为仓库从未讨论过该方向。

## 需求覆盖矩阵

| 用户关注点 | 设计响应 |
| --- | --- |
| 每个 Session 一个小知识库 | 映射为每个 Conversation 独立目录和 SQLite |
| 数据方便一起删除 | 整目录归档/删除，外部 tombstone 防复活 |
| 不用的知识慢慢降权 | temperature 与半衰期衰减 |
| 频繁有用的知识提升 | 仅确认有用后增强，设置上限和探索配额 |
| 撤销早先意图 | 显式 cancel/supersede 关系，召回前硬过滤 |
| RAG 片段可能漏数据 | 强制状态、近期完整 Turn、混合检索和 JSONL 回退 |
| 过期无用知识清理 | 隐藏、降温、压实、投影清理、整会话删除五级机制 |
| JSONL 与 SQLite 何时用 | JSONL 负责事实与恢复，SQLite 负责在线投影与召回 |

## 变更记录

- 2026-08-26：汇总三个独立 Agent 对知识生命周期、检索完整性和 Harbors 仓库边界的评审，形成初版设计。

## 需求变更

- 初始需求：为每个 Conversation 建立可独立维护和清理的小型知识库，并解决知识降权、增强、过期、撤销和 RAG 漏召回问题。
- 当前没有已确认的范围变更；“活动 Turn 中即时纠正”和“跨 Conversation 晋升”保留为待评审边界，不默认纳入实现。
