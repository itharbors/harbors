# Agent Context Store 交付摘要

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../2026-10-22-agent-turn-durability/summary.md)。

## 最终结论

2026-10-22 当前复核：Harness Conversation 已从 JSONL 运行时存储切换为 `agent-context-store` SQLite；每 User + Plugin 一个 active Store，同 User 跨基础 Session 共享，不同 User 独立。Agent 通过同步 callPlugin 读写，并默认使用 candidate-v1 装配 mandatory state、当前 Turn、近期历史和精确锚点证据。Framework 管理可信 User/基础 Session/Plugin 边界，Conversation schema 与生命周期留在 Plugin；旧无 User 路径不回退。

本 Task 尚未整体完成：流式写入排队后立即广播、Stop 超时仍返回 true 两项 P1 实现缺口未修复，严格 Q30 也未通过。主 Agent 已将 implementation 标为 blocked，verification/consolidation 回到 pending。本文保留 2026-08 的历史证据；本次文档修订不等于源码修复或新一轮行为验收，见 [核对 Task](../2026-10-22-context-store-design-reconciliation/task.md)。

## 需求完成情况

SQLite、Plugin 硬依赖、空库初始化与 Context 动态装配已存在；历史性能及局部测试通过各自门禁。流式/Stop 故障保证与严格 Q30 未闭环，不能继续写成“均已完成”。正式架构已按当前事实投影，目标保证与缺口另列。

## 主要改动

- Framework 支持硬依赖、拓扑加载、反向卸载和 dependent guard；Kit 切换失败尝试恢复旧 Kit，恢复成功才可继续，恢复失败 fail closed 并重建 runtime，保留激活和恢复错误。
- Harness 的 agent-context-store Session Plugin 在每 User + Plugin data 目录使用一个 active SQLite；同 User 的基础 Session 共享，业务表以 conversation_id 隔离。
- Store 提供 12 个公开基础方法；重命名、设置、权限、分页和 recent projects 是 Agent facade。callPlugin 与 request 复用 manifest callers 授权，不另建 ACL。当前无 JSONL 导入或导出 API。
- Agent 不再运行时读写 JSONL；同 Turn 的 tool call/result 和 Skill 完整累积，跨 Turn 使用状态、近期窗口和 path/error/ID 锚点召回。
- `candidate-v1` 已成为默认模型输入；`HARBORS_AGENT_CONTEXT_MODE=surface-v1` 仅作为显式诊断/紧急回退。

## 关键决定

- 每 User + Plugin 使用单一 active SQLite，不按 Conversation 拆库；隔离由可信目录绑定、conversation_id、事务和测试保证。
- SQLite events 是唯一运行时事实源；运行时不读取、不导入、不导出、不双写 JSONL，不保留已撤下的 exporter 验证承诺。
- 模型状态工具只产生 candidate，Agent 校验后才能写入有效 state/relation event。
- 当前 Turn 不做旧历史压缩；历史文件证据被召回后仍重新读取工作区当前版本。
- MVP 不引入向量库、embedding、GraphRAG 或额外检索表；历史 P100 通过，严格 Q30 尚未满足。

## 验证结果

- Q30：三类各 10 例、每例 3 次，通过正式 model-service.complete 消息链执行。v2 在不改变业务意图的前提下明确最终状态和值类型，并修正等价表达、否定句和旧值裸字符串误判；2026-08-29 报告 current 90/90 可评分且 90/90 通过，candidate 89/90 可评分且 89/89 通过。M09 repeat 1 在有限补跑后仍为 Provider 空响应，原报告 regressions 保留该项；已评分答案没有语义失败，不代表严格门禁通过。报告 status=completed 仅表示 runner 结束。
- Q30 用期望最终有效 state（oracle state）注入 candidate 输入，只比较 Context 装配；不能证明真实模型状态抽取或完整工具链。Agent 接受 state candidate 的独立确定性集成测试只证明各自覆盖范围。
- P100：1/10/50/100 Turn、每种 build 30 个样本，候选来源上界和两项同机 P95 门禁全部通过。
- Harness：单元测试 325/325、Q30 fixture 3/3、Plugin smoke 3/3、assembly 10/10。
- 首次启动 Web 验收：使用独立 data root 预置一份包含非法行的 JSONL 诱饵；Harness 14/14 Plugin 加载成功、会话列表为空、SQLite 与 `current.json` 正常创建、quarantine 为空，诱饵内容保持原样。
- Framework/Server：Plugin 47/47、Kit Core 113/113、Server 797/797。
- 历史迁移事实：2026-08-29 曾在完整备份下把真实 data root 迁移为 SQLite；journal 为 `accepted`，SQLite `integrity_check=ok`，11 个 Conversation 与 49,725 个 event 已导入。该历史操作已完成，不再作为当前产品能力保留。
- 文档与格式：Kit docs 10/10、`git diff --check` 通过。

原始评测见 [Q30](artifacts/q30-result.json) 与 [P100](artifacts/p100-result.json)。

## 影响与风险

首次使用新 data root 会直接创建空 SQLite；旧 JSONL 即使存在也不会出现在 Conversation 列表。需要保留旧会话的部署必须在启用新版前另行处理。紧急诊断 Context 行为时可显式切换 `surface-v1`，但这只切换 Context 装配，不改变 SQLite 存储。

## 当前目标与实现缺口

流式最小目标是将 onDelta 放入现有串行写队列，在 append 成功和 trace 后才 broadcast；首个写失败关闭 generation 并取消上游。完成、失败和取消先停止接收新事件，再等待已接收队列收口，由当前 Turn 唯一终态写入点落盘。保留 stopConversation 的 `Promise<boolean>`：无 active Turn 为 false，durable cancelled terminal 后才 true，超时或持久化失败走既有 rejection 通道，不能显示“已停止”。目前代码未满足；延迟/失败/终态竞态与重复 Stop 等故障验收见 [Agent 集成设计](design/agent-plugin-integration.md)。

当前删除使用外部 tombstone 原子写入 + SQLite 事务；已写 guard 不随数据库回滚撤销，启动会应用 guard。只有空库初始化 journal，没有通用 operation journal、新版本恢复发布或对象引用校验平台；这些若成为未来需求，需另定范围，不能由历史迁移记录反推已实现。

## 偏差与遗留

仓库全局 `check:preflight` 仍被本 Task 未修改的 4 条既有边界问题阻断：3 个 `prompt-eval` 测试跨 Kit import，以及 `packages/client/tests/components/kit-picker.test.ts` 的静态 Kit identity 列表。除静态架构检查外，其余 preflight 用例通过。

## 后续关注

若真实 1000 Turn 数据超过 P100 门禁，再按实际查询形状增加 turn/anchor 索引投影；当前 MVP 不提前引入额外检索表或向量系统。

## blocking（2026-10-22 复核）

- 流式持久化后广播与 Stop durable 收口两项 P1 尚未实现，相关故障门禁未完成；文档修订不解除阻塞。
- Q30 严格要求 candidate 全部 90 次可评分、通过数不低于 current 且无同 case/repeat 新增回归；当前 89/90 与 M09 repeat 1 空响应仍阻塞。原始答案、数字和 regressions 保持原样。

## non_blocking

- 仓库全局 `check:preflight` 的 4 条既有边界问题不属于本 Task，未在本次范围内修改。
- 正式 Agent 缺 Store、新库初始化、current 指向的数据库缺失 fail closed 等历史证据只证明各自场景，不能替代上述阻塞项验收。

## decision_candidates

- 无。取消首次 JSONL 迁移是用户已明确决定，不再作为待批准候选。

## follow_up

- 需要保留旧 JSONL 会话的部署，应在启用新版前另建一次性离线处理 Task；当前产品不提供自动导入入口。
- 只有真实 1000 Turn 数据触发 P100 门禁后，才评估增加索引投影。
- 流式/Stop 代码修复及故障注入、严格 Q30 补齐必须另获执行授权；本轮仅修订设计，不访问真实模型、数据或 Keychain。

## 相关正式文档

- [Agent Context Store 架构](../../architecture/agent-context-store.md)
- [Agent Turn 事件协议](../../architecture/agent-turn-event-protocol.md)
- [历史 Agent JSONL v1 Task](../2026-08-23-agent-jsonl-v1/task.md)
- [Plugin 运行时模型](../../architecture/plugin-runtime-model.md)
