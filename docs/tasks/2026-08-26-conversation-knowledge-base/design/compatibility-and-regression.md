# 兼容性与不劣化门禁

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../../2026-10-22-agent-turn-durability/summary.md)。

## 1. 结论

SQLite 初始化和 Context 切换必须分别证明：首次启动不会读取旧 JSONL，正常 Conversation、模型输入、工具执行、审批、停止、刷新和故障恢复也没有退化。

实施分三段，每段单独通过门禁：

1. **空库初始化**：JSONL 诱饵存在时仍发布 0 Conversation 的 SQLite，不生成导入或 quarantine 记录。
2. **影子装配**：Context Builder 每 step 运行并记录 Plan，但模型仍使用兼容 surface；离线比较必选事实、协议消息和 Token。
3. **受控切换**：只有差分评测和 Web 验收通过后，`candidate-v1` 才成为实际模型输入；`surface-v1` 只回退 Context 装配，不回退存储。

任何一段出现 Missing 门禁，都不能进入下一段。设计审查不等于这些门禁已经通过。

### 2026-10-22 复核结论

代码已经默认使用 `candidate-v1`，但这不代表受控切换门禁已闭环。原始 Q30 为 current 90/90 可评分且通过，candidate 89/90 可评分且 89/89 通过，M09 repeat 1 为 Provider 空响应；严格门禁未通过。流式持久化后广播与 Stop durable 收口仍有 P1 实现缺口。原 Task implementation 已由主 Agent 标为 blocked，verification/consolidation 回到 pending；本次只修订文档。

以下矩阵是兼容要求和待证明的目标，不是全部已经具备或通过的能力清单。原始结果和历史测试分别见 [验证产物](../artifacts/README.md) 与 [交付摘要](../summary.md)。

## 2. 判定标准

“不劣化”包含四层：

- **事实等价**：event、metadata、权限、归档和来源无损；
- **协议等价**：trace、surface、NeutralMessage、tool/approval/item 关系无损；
- **行为等价**：继续任务、工具回环、审批、Stop、overflow 和刷新结果不差于当前版本；
- **故障等价**：单 Conversation 损坏仍隔离，健康能力不被无关故障拖垮，已显示成功的状态重启后不消失。

数据层使用 golden/digest；执行层使用确定性 Model Service double；回答质量另做小规模真实模型对照。不能用“测试通过”替代回答质量比较，也不能用真实模型波动替代协议断言。

## 3. 兼容要求矩阵

### 3.1 Event、surface 与 trace

| 现有能力 | 目标机制 | 必须通过的门禁 |
| --- | --- | --- |
| canonical 五类 event，payload type 开放 | SQLite canonical envelope | append→读取 API→重启重放逐字段 golden；未知 event fail closed |
| `seq=ordinal-1`、连续 cursor | 单一 API seq 域 | 空会话、rollback、并发、page/since/full 无 gap、重复或重编号 |
| 首次启动不接管旧会话 | 空 SQLite 初始化 | valid、invalid、archive JSONL 诱饵均被忽略且原文件不变 |
| append/replace surface | `surface-v1 reducer` | rebuild 前后 surface seq、model messages 和 digest 一致 |
| compaction/prune 来源 | 有序 sourceEventSeqs | 连续 compaction、recall 原文、重启重放来源不变 |
| full/page/since 恢复 | 现有 AgentTraceEvent facade | 丢广播、乱序、冲突、分页并发 append 后 UI 与全量重放一致 |
| completed snapshot 决定最终 item | canonical→AgentTraceEvent 投影 | reasoning、文本、tool、approval 刷新前后最终状态一致 |

### 3.2 Context 与模型输入

| 现有能力 | 目标机制 | 必须通过的门禁 |
| --- | --- | --- |
| 短会话完整 surface | `surface-v1` folded surface | 逐 step 深比较 Model Service input |
| compaction checkpoint 语义不变 | surface-v1 兼容重放 | 长会话刷新后“继续”不要求重述，checkpoint 来源可追溯 |
| 当前 Turn tool result 原文 | 当前 Turn 不参与旧历史裁剪 | 大结果中段信息能驱动下一 step |
| 已加载 Skill 正文与顺序 | loadedSkills active state | 大 Skill 中段约束被遵守，加载失败也可审计 |
| 完整 system/workspace/Skill catalog | Agent 最终 request 装配 | 现有 runtime smoke 的 sections、digest 和来源诊断等价 |
| request/context 审计 | Plan + provider request audit | promptVersion、model/settings/permissions、loadedSkills、两个 digest 均可复盘 |
| overflow 自动恢复一次 | Store 驱动的有界 rebuild | 首次 overflow、第二次成功；无重复工具执行 |
| context usage ring | usage event + getConversationContext | 多模型窗口、cache/reasoning usage、刷新后显示一致 |
| 每 step 新锚点召回 | progressive buildContext | 新 path/error/ID 下一 step 命中；首 step 不依赖模型主动 recall 才保住 mandatory state |

### 3.3 Turn、stream、tool、approval 与 Stop

| 现有能力 | 目标机制 | 必须通过的门禁 |
| --- | --- | --- |
| request/generation/sequence 过滤 delta | model request 状态机 | 乱序、重复、旧 generation、取消后晚到 chunk 均被拒绝 |
| completed 不越过 delta | 现有串行队列内 append 成功后才 onDelta，失败关闭 generation（待实现） | 精确顺序为 commit→trace→delta→completed→turn/end；延迟/失败时不得提前广播 |
| Stop 贯穿 model/tool/approval | 当前 Turn 唯一终态写入点及持久结果屏障（待实现） | 五个等待阶段 Stop；只有 durable cancelled terminal 后 true，超时/写失败 rejection，重复 Stop 及晚到事件无二次终态 |
| tool call/result 协议闭包 | versioned BuildContextOutput | OpenAI/Anthropic、错误、图片、并行只读调用均无损 |
| 工具失败循环阈值 3 | Agent runtime guard | 成功 reset；不发第 4 次模型请求 |
| 副作用不被自动重复 | outcome unknown | result 持久化各边界失败时 mutation 只执行一次 |
| approval 四键和唯一终态 | pending registry + Store CAS | 错键、重复、超时、Stop、刷新后审批均不能二次执行 |
| timeout/error 稳定分类 | 唯一 terminal writer | Provider 与 Store 双重失败仍保留 requestId、主 code 和安全 cause |

### 3.4 Conversation 与 Web 工作台

| 现有能力 | 目标机制 | 必须通过的门禁 |
| --- | --- | --- |
| active/archived list 返回完整数组 | Agent 组合 Store listConversations(status) | 既有消费者得到完整有序数组；Store 当前没有分页 API，不虚构排空全页机制 |
| draft/options/settings | Agent 继续拥有 global/draft | 新旧会话默认值隔离，模型选择和推理设置刷新后恢复 |
| 会话权限 | Store facts + Agent facade | sandbox/approval policy 更新和并发写一致 |
| pending approval 刷新 | Store asked fact + runtime resolver | Panel remount 后可处理一次且仅一次 |
| Conversation 选择态 | Conversation Plugin 原所有权 | generation/revision 拒绝晚到状态；新建、切换、归档、刷新不丢 draft |
| recent projects | Agent 由 Store Conversation metadata 派生 | active/archived 去重、排序和 limit 与当前一致 |
| 标题规则 | title reducer | 默认、首消息 48 字、手动 120 字优先级一致 |
| 已有 unavailable 记录 | 最小 unavailable summary | 健康会话继续可用；坏项可见但不可读写，不出现空列表假象 |

### 3.5 Runtime、初始化与恢复

| 现有能力 | 目标机制 | 必须通过的门禁 |
| --- | --- | --- |
| Agent 存储故障不产生半激活 Kit | Kit 加载事务与尽力恢复 | 新 Kit 不激活；旧 Kit 恢复成功才继续，恢复失败 fail closed、保留激活与恢复错误并重建 runtime |
| Kit 静态预检不扰动旧 Kit | 依赖图预检 | missing/cycle/invalid 时旧 Kit 零 unload、route 不变 |
| 动态 Plugin lifecycle | Running dependent guard | 不存在 Running Agent + non-Running Store |
| 多 Runtime 同一数据根 | epoch fencing | current 切换后旧 Runtime 不能向旧库成功写入 |
| 关键事件 sync barrier | WAL + synchronous FULL | 已对外成功的 approval/turn terminal 强杀重启后仍存在 |
| commit 结果未知可确认 | idempotency key + hash | commit 后断连重试不重复；同 key 不同 payload 冲突 |
| 可恢复 archive 与永久 delete 分离 | SQLite lifecycle + permanent guard | 归档可恢复，绝不误转为永久 tombstone |
| delete 故障收敛 | 版本外 tombstone + SQLite 事务 + 启动 guard | 分别覆盖 tombstone 写前、写后及 DELETE/COMMIT 失败；已写 guard 不撤销，重启应用 guard，不误称已有 operation journal |

当前没有 JSONL 导出 API，不再设 exporter/round-trip 门禁。一致快照备份、新版本恢复发布和对象引用校验均未实现；如未来提出，另定范围和验收，不能用初始化 journal 或历史一次性迁移证明这些能力已通过。

### 3.6 流式和 Stop 故障验收（待完成）

保持现有同步 Store、delta 回调、broadcast 和 `stopConversation(): Promise<boolean>`。最小机制及当前源码差距见 [Agent 集成设计](agent-plugin-integration.md)。故障注入必须覆盖：

- delta append 延迟时无对应 UI delta；append 失败立即关闭 generation 并取消上游，失败项及后续 chunk 不广播成功；
- completed、取消或 Provider 错误与最后 delta 竞争，已接收队列先收口，唯一终态不被越过，保留主要持久化错误与安全 cause；
- Stop 后上游不响应、队列写失败、终态写失败或超时均不能返回 true/显示“已停止”；无 active Turn 返回 false，durable cancelled terminal 后才 true，其余走既有 rejection 通道；
- Stop 在 context/model/tool/approval/append 各阶段发生，重复 Stop、晚到 delta/result 与审批响应不能重复执行工具或写第二终态；同步 Store 调用只在边界检查取消。

## 4. 核心对话测试用例

### S1：单轮状态识别

Fixture：一个空 Conversation。用户发送“只读检查 `src/a.ts`，不要修改文件”；确定性 Model Service double 返回预期的结构化 state mutation，Agent 校验后写入对应 events。

断言：

- 当前目标和“只读”约束进入 mandatory state；
- 用户消息只出现一次；
- 没有无来源的历史 evidence；
- state projection 删除并重建后 digest 相同；
- Model Service input 中目标和约束顺序稳定。

### S2：单 Turn 文件与工具累积

Fixture：一个 Turn 内依次读取 `src/a.ts`、`src/b.ts`，随后执行一个只读检查工具；三个结果包含可区分的中段标记。

断言每个后续 model step 都包含：

1. 当前用户消息；
2. 已完成的 tool call；
3. 对应 tool result 原文；
4. approval（若有）；
5. 已加载 Skill body；
6. 与事件一致的原始顺序和关联 ID。

当前 Turn 未消费结果不得参与旧历史裁剪。若 mandatory 内容本身超过窗口，必须返回 `CONTEXT_BUDGET_EXCEEDED`，不能静默丢失中段标记。

### M3：三轮纠正与继续

Fixture：

1. Turn 1：“删除 A”；
2. Turn 2：“刚才说错了，不删除 A，改为重命名 B”；
3. Turn 3：“继续”。

断言：A 对应目标被 cancelled，B 成为 active goal；Turn 3 的 mandatory state 不再包含可执行的“删除 A”；recent window 或 exact anchor 均不能让旧动作复活。目标存在歧义时必须先澄清，不得自行选择关系目标。

### M10：十轮延迟召回

Fixture：Turn 1 读取 `src/context.ts` 并记录一个决定；Turn 2～9 使用无关内容填充；Turn 10 的用户消息不直接提文件，但某个 tool result 暴露该路径或关联错误码。

断言：

- Turn 10 第一个 step 不要求提前命中该文件；
- tool result 持久化后，下一 step 的 exact anchor 命中 Turn 1 evidence；
- evidence 包含 source seq 和当时的用途，不直接把旧文件正文当当前事实；
- Agent 随后重新读取工作区现版本；
- 重新加载、投影重建和分页恢复后结果一致。

### N10：负例与错误召回

Fixture：十轮历史中同时存在名称相似文件、相同错误关键字、已取消目标和一个真正相关目标。

断言：固定负例中的 cancelled、superseded 和仅名称相似内容不进入最终 Context；真正相关 evidence 保持唯一，不因 recent 和 anchor 多路命中而重复。

### L20：长对话与按需召回

Fixture：20 个以上 Turn，包含大 tool result、checkpoint、Skill、approval、用户纠正和多次“继续”。

断言：

- current state 和当前 Turn 始终保留；
- 候选模式可以排除无关旧正文，但 Context Plan 必须保留 source seq；
- `recallHistory` 可以恢复被排除的完整 evidence；
- compaction 前后继续任务的目标、约束和未完成步骤一致；
- 当前 Turn 的大 tool result 中段标记仍能影响下一 step。

### O1：预算溢出

Fixture：System、tools、权限、一个大 Skill、当前 Turn tool result 和多段旧历史共同逼近窗口。

断言：先排除低优先级旧历史；当前 Turn 和 mandatory state 不被静默裁剪；Provider 首次返回 overflow 时只允许一次更小预算重建；重试产生关联的新 Plan/request attempt，且不重复已经执行的 tool mutation。

### P100：性能与容量增长

使用同一数据形状生成 1、10、50、100 Turn fixture，在固定机器、固定 SQLite 配置、固定查询和预热条件下分别测量：

- append latency P50/P95；
- buildContext latency P50/P95；
- 候选数、最终 evidence 数和输入 Token；
- Model Service double 的完整 step latency。

确定性 CI 门禁：

- 任何规模的最终输入都不超过 `availableInputTokens`；
- 固定 fixture 的候选来源不超过 9，最终输入不随历史全文等比例增长；
- mandatory state 漏失率、协议闭包破坏率和固定负例错误召回率均为 0；
- 精确锚点和明确 state/relation fixture 的目标 evidence 召回率为 100%。

同机发布门禁要求 100 Turn 候选 buildContext P95 不超过同规模 `surface-v1` 的 2 倍，且不超过 10 Turn 候选 P95 的 4 倍。benchmark 必须保存机器、Node、SQLite 配置、预热方式和原始样本；普通 CI 只断言 Token、候选上界和召回正确性，不断言易受共享机器抖动影响的耗时。

MVP 允许 `surface-v1` 和显式 `recallHistory` 线性读取单个 SQLite Conversation 的历史，因为它们分别承担 Context 差分和低频审计用途；若真实数据或 1000 Turn 扩展 benchmark 超过上述门禁，再增加 turn/anchor 索引投影，不在本次先引入一套未经需求证明的检索表。

### Q30：真实模型质量对照

冻结 30 个有明确期望结果的自然语言用例：

- 10 个单轮目标、强约束、否定和只读要求；
- 10 个跨 Turn 的补充、纠正、取消、替代和“继续”；
- 10 个第 5～10 Turn 才通过路径、错误、ID 或工具结果发现历史关联的用例。

当前版本与候选版本使用同一模型和设置、固定 Context fixture，每个用例 3 次，共各 90 次。现行 Q30 runner 预先写入期望的最终有效 state（oracle state），再比较 surface-v1 与 candidate-v1；逐例保存 Context Plan、期望、模型答案、评分及错误。它隔离比较 Context 装配，不能证明真实模型状态抽取准确率、Agent 接受 candidate 的端到端行为或完整工具执行链。状态工具接受与协议链由独立确定性 Agent 集成测试证明其测试范围。缺少 Provider 凭据时报告 skipped，不能伪造通过，也不阻断不需要凭据的 test:kit。

评分以最终有效状态为准，不以回答全文的裸字符串命中代替语义判断。字符串统一大小写、全半角、空白和标点后比较，标量与单元素数组视为等价；失效旧值必须按具体状态字段声明和检查，避免把“不得修改某文件”误判为选择了“修改某文件”。这些归一化不放宽缺字段、错误布尔值、缺失锚点或保留 superseded 值的失败条件。

门禁：候选版本不得新增删除错误对象、忽略明确取消、违反只读约束、重复执行副作用工具等高严重度错误；继续任务成功率、约束遵循率和正确历史采用率不得低于当前版本。任何差异用例都必须单独展示输入、预期、实际和 Context Plan。

每个逻辑重复允许对 Provider/解析错误做最多 3 次有限重试，但已获得结构化答案后的语义失败不得重试。严格门禁同时要求：candidate 的 90 个重复全部可评分、通过数不低于 current、且无同 case/repeat 的新增回归。current 的 Provider/解析错误按 baseline 失败保留，不阻止满足上述条件的 candidate。中断恢复只能补 error，不能覆盖已完成结果。

2026-08-29 原始报告中 current 为 90/90 可评分、90/90 通过；candidate 为 89/90 可评分、89/89 通过，M09 repeat 1 返回 MODEL_SERVICE_INVALID_RESPONSE 空内容。报告的 `regressions` 保留该 case/repeat，这是严格逐次门禁中的缺口，不是已评分答案的语义失败；`status: completed` 只表示 runner 已结束。不能删除此项、减少分母或把有限补跑写成全部通过。本轮不重跑模型。

## 5. 差分评测集

冻结 SQLite fixtures 和对应预期结果，至少包含：

1. 短对话完整历史；
2. 20+ Turn 长对话继续执行；
3. compaction 后继续；
4. 用户纠正、取消和 supersede；
5. 大 tool result，关键信息位于中段；
6. Skill catalog、成功加载、加载失败和大 Skill；
7. tool success/error/image 与 approval；
8. Provider overflow retry；
9. Stop 分别发生在 context、model、tool、approval 和 append；
10. 空库初始化忽略 active、invalid 和 archive JSONL 诱饵；
11. 两个 Runtime 并发 append、初始化锁恢复和 restart；
12. Chat 断线补拉、向前分页、刷新和 Panel remount。

确定性对比至少检查：最终 system、NeutralMessage、必选事实、tool-call 顺序、事件终态、trace/UI reducer 结果和 audit。真实模型对照检查约束遵循、继续任务成功率、重复工作和错误工具调用；样本与阈值在实现计划中冻结，失败用例不得只看平均值掩盖。

## 6. 发布门禁

- 阶段一：空库初始化不读取 JSONL，事实、trace、surface、Conversation API 和 Web 工作台正常；
- 阶段二：影子 Plan 不影响模型请求，mandatory state 漏失率为 0，协议 closure 破坏为 0；
- 阶段三：真实模型对照无已知高严重度退化，overflow/Stop/approval/refresh 全链路通过；
- 性能：并发 append、buildContext P95 和启动耗时不得超过实现计划冻结的预算；
- 多轮：S1、S2、M3、M10、N10、L20、O1、P100 和 Q30 全部通过，失败用例逐条展示，不用平均值掩盖；
- 故障：物理库损坏不创建空库，单 Conversation 坏输入不阻断健康项，明确错误与处置边界；
- 生命周期：初始化发布、active pointer 与 tombstone 启动处理分别验证；不承诺未实现的恢复平台或导出能力。

任一门禁失败都不能宣称完成或批准切换。当前代码已默认 candidate-v1 与严格门禁未闭环的差异作为实现/验收遗留保留；本轮文档修订既不改默认值，也不通过双写、静默回退或降门槛掩盖问题。
