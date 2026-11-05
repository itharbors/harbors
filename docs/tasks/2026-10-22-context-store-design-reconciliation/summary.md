# Context Store 设计说明核对总结

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../2026-10-22-agent-turn-durability/summary.md)。

## 最终结论

本轮文档完善通过。`author_context_store_design` 修订 11 份文档并逐项自检，`validate_context_store_design` 独立审核相同 R1–R9；首审发现三项阻塞并退回作者，返修后全部关闭。主 Agent 对照源码、实际差异、冻结哈希、原始评测和 Task 契约独立复核，裁定 R1–R9 全部通过。

此结论只覆盖设计说明的准确性与完整性。源码、测试、manifest、依赖和产品行为没有改动；两个原功能 Task 的实现或验收缺口仍未完成。本轮未提交或推送。

## 需求完成情况

| 要求 | 作者自检 | 独立校验 | 主 Agent 裁定与依据 |
| --- | --- | --- | --- |
| R1 身份与归属 | 通过 | 通过 | 通过；[正式架构](../../architecture/agent-context-store.md) 与可信 User/基础 Session/Plugin 路径实现一致；Conversation 业务留在 Plugin |
| R2 调用协议 | 通过 | 通过 | 通过；[Framework 设计](../2026-08-26-conversation-knowledge-base/design/framework-plugin-runtime.md) 保留同步 callPlugin、硬依赖及 request/callers；两张 Store API 表均对应实际 12 方法 |
| R3 流式与 Stop | 通过 | 通过 | 通过；[Agent 集成设计](../2026-08-26-conversation-knowledge-base/design/agent-plugin-integration.md) 区分现行缺口、兼容机制与故障验收，未冒称代码已修复 |
| R4 质量与证据 | 通过 | 通过 | 通过；[兼容门禁](../2026-08-26-conversation-knowledge-base/design/compatibility-and-regression.md) 保留严格三条件及 oracle-state 边界，原始数字不变 |
| R5 运维能力 | 通过 | 通过 | 通过；[运维设计](../2026-08-26-conversation-knowledge-base/design/migration-and-operations.md) 按实际删除、锁回收及布局说明，撤下不存在的导出与恢复能力承诺 |
| R6 回滚边界 | 通过 | 通过 | 通过；旧 Kit 恢复成功才继续，恢复失败则 fail closed、保留错误并重建 runtime |
| R7 状态一致 | 通过 | 通过 | 通过；[8/26 总结](../2026-08-26-conversation-knowledge-base/summary.md) 与 implementation blocked、[8/31 总结](../2026-08-31-harness-tool-error-reporting/summary.md) 与 verification blocked 一致，历史证据和当前结论分开 |
| R8 最小改动 | 通过 | 通过 | 通过；11 份允许文档之外仅新增本 Task 档案、由主 Agent 用 CLI 更正两个原 Task 状态；原始 JSON 哈希不变，无源码改动 |
| R9 独立验收 | 通过 | 通过 | 通过；作者、只读校验者、主 Agent 分工独立，发现阻塞后确实返修、复验并裁定 |

## 主要改动

- 统一 User + Plugin 的 active Store 归属、基础 Session 运行时边界、同步调用和消息链；将 Agent facade 与真实 Store API 分开。
- 明确持久化后广播、失败关闭 generation、终态等待队列以及 durable cancelled terminal 后才报告停止的目标机制，标注尚未实现。
- 删除已撤下 JSONL exporter 和已交付 round-trip 验证承诺；按 tombstone + SQLite 事务描述删除，把未实现的备份恢复能力留作未来需求。
- 校正 Kit 恢复失败、初始化遗留目录与 current.json 布局；补齐 Q30 的真实结果、严格门禁和评测范围。
- 保留原验收要求及历史记录，更正“全部完成”与现有证据不一致的 Task 状态。

## 关键决定

1. 延续已接受的 ADR 0005：Framework 绑定通用身份、作用域和调用权限，业务 schema 与生命周期属于 Plugin；不新增 accepted ADR。
2. 当前事实写入正式架构，尚未实现的机制保留为目标和故障验收；文档修订不替代功能修复。
3. Q30 不降门槛、不减少分母、不删除错误或 regressions。current 为 90/90 可评分且 90/90 通过；candidate 为 89/90 可评分且 89/89 通过，M09 repeat 1 仍是 Provider 空响应。
4. 原浏览器错误场景要求不缩减、不豁免；加载 Kit 的记录不能替代真实错误文案的场景验收。

## 验证结果

- 作者交付的 11 个冻结 SHA-256 经独立校验者和主 Agent 分别核对，全部一致；45 个本地文档链接有效，无尾空白。
- 两份原始 P100/Q30 JSON 与修订前快照哈希一致。主 Agent 从 Q30 原始样本重算 current 总数/可评分/通过为 90/90/90，candidate 为 90/89/89，原 M09 repeat 1 回归记录保留。
- 源码、测试、manifest、构建依赖路径无改动；`git diff --check` 通过。
- 两个原 Task 的文档契约检查通过；本 Task 的最终文档契约和 ready 检查通过。ready 仅指本轮文档 Task，不代表原功能 Task 可交付。
- 本轮没有执行产品测试、浏览器行为验收或真实模型评测，没有读取真实用户运行数据及 Keychain。
- 过程证据保存在本 Task 的忽略目录 `.work/`：修订前快照、作者覆盖矩阵与冻结哈希、独立首审/复验结果、主 Agent 验证与裁定。长期可查结论以本文及正式架构为准。

## 影响与风险

文档现在如实展示已实现能力与未完成保证，产品行为不变。8/26 Task 的 implementation 为 blocked，后续阶段 pending；8/31 Task 的 implementation 保持 completed，verification 为 blocked，consolidation 为 pending。状态更正均由主 Agent 使用 Task CLI 完成。

原实现仍存在流式事件在持久化成功前广播、Stop 超时仍返回 true 的 P1 缺口；candidate 默认装配模式也不能视为严格 Q30 已通过。

## 偏差与遗留

本轮需求无缩减。主 Agent 初检发现两份旧 summary 固定标题不符合契约，已由作者修正；独立首审的 B1（浏览器验收与完成声明冲突）、B2（误称清理未发布版本）、B3（current.json 层级错误）均经过作者返修与独立复验关闭。

原功能遗留保持原验收标准，不能以本 Task 完成解除其阻塞。

## 后续关注

- 在原 Context Store Task 中实现流式持久化与 Stop 收口，完成延迟、失败、终态竞争及晚到事件等故障验收。
- 按原冻结规则补齐严格 Q30；保留原报告与逐例差异，不能把 oracle-state 装配评测外推为状态抽取或完整工具链通过。
- 补齐 8/31 Task 的浏览器工具失败保护场景，记录真实终态文案后再复核其验证和收口状态。
- 原工具错误 Task 中的 rg 路径及“无匹配”语义继续作为独立后续项，不在本轮扩展。

## 相关正式文档

- [Agent Context Store 架构](../../architecture/agent-context-store.md)
- [核心原则](../../architecture/core-principles.md)
- [ADR 0005：Plugin 默认身份与所有权边界](../../decisions/0005-plugin-default-boundaries.md)

## Decision Delta 与反向检索

| 分类 | 增量、来源与影响 | 状态与正式落点 | 反向检索 |
| --- | --- | --- | --- |
| architecture | paths、Store、方法权限及 Editor 源码证明的数据归属、调用边界、实际删除与恢复失败语义 | 已验证当前事实，投影至 Agent Context Store 正式架构 | 以 User、callPlugin、current.json、tombstone、恢复检索，可定位正式架构；docs/README.md 已链接该入口，无需改索引 |
| Task-only | harbors.ts 与原始 Q30 证明的流式/Stop 缺口、质量门禁、历史证据范围；浏览器错误场景证据缺失 | 保留在两个原 Task 的设计、总结和状态，本文记录裁定 | 检索 Stop、Q30、tool-loop-guard 可从原 Task 找到明确未完成项及解除条件 |
| ADR | 已接受通用边界继续沿用 ADR 0005 | 无新增、无审批升级 | 核心原则与 ADR 已覆盖可信身份、默认边界和调用权限，无需重复发布 |

## Findings

- blocking：本轮文档 Task 无剩余阻塞；两原 Task 的阻塞分别保留在其档案，不因本文通过而解除。
- non_blocking：原功能的两项 P1、严格 Q30、浏览器错误场景尚未闭环；rg 路径与“无匹配”语义为原有独立遗留。源码行为没有因文档变化而改善。
- decision_candidates：本轮无新增待批准决策；未来备份恢复系统等仅标为未实现需求，不构成设计批准。
- follow_up：按上述原 Task 分别补实现、模型门禁与浏览器场景证据；本轮不自动执行这些动作，不自动提交、推送或合并。
