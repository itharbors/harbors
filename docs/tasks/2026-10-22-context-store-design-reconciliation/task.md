# 2026-10-22-context-store-design-reconciliation

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../2026-10-22-agent-turn-durability/summary.md)。

Task ID: `2026-10-22-context-store-design-reconciliation`
Type: `docs`

## 背景与问题

当前未提交的 Context Store 和工具错误报告 Task 档案包含早期设计、当前实现与尚未实现的可靠性承诺。2026-10-22 的只读审查确认：User/Session 范围及 callers 描述过时，部分导出和运维能力已撤下或没有实现，流式持久化与停止收口存在代码差距，Q30 严格门禁未闭环但档案仍出现全部完成结论。

用户要求完善这些设计，由一个子 Agent 按主 Agent 明确要求修订，另一个子 Agent 使用同一要求独立校验，双方通过后由主 Agent 复核证据并作最终裁定。

## 目标

1. 明确区分当前事实、目标设计、实现缺口、历史记录及未批准方案。
2. 保留合理的插件分层、SQLite 事实源与分层 Context 装配设计，消除跨文件矛盾和过时承诺。
3. 建立逐项要求、修订文件、源码依据、验收结果和最终裁定之间的可追溯关系。

## 范围

- `docs/tasks/2026-08-26-conversation-knowledge-base/` 的 Markdown 任务、五份设计、总结及验证产物说明。
- `docs/tasks/2026-08-31-harness-tool-error-reporting/` 的 Markdown 任务及总结，仅校正与当前事实和验收范围不一致的表述。
- 与上述设计直接冲突的 `docs/architecture/agent-context-store.md`，保持正式架构投影一致。
- 本 Task 的正式档案及 `.work/` 中的要求、作者交付、独立校验和裁定证据。
- 原 Task 的机器状态仅由主 Agent 通过 Task CLI 核对；是否需更正必须有明确依据，不由文档作者自行改动。

## 非目标

- 不修改源码、测试、manifest、依赖、构建或产品行为。
- 不实现流式持久化、Stop、JSONL exporter、operation journal 或新的备份恢复系统。
- 不重跑真实模型评测，不读取真实运行数据或 Keychain，不执行迁移。
- 不修改原始 P100/Q30 JSON 结果，不把缺失样本、Provider 空响应或历史测试记录改写成通过。
- 不自动提交、推送、合并、删除分支或清理已有文件。

## 验收标准

1. **R1 身份与归属**：明确 Framework 只管理 User/基础 Session/Plugin 通用边界；每 User + Plugin 一个 active Store，同 User 跨基础 Session 共享，不同 User 独立；Conversation schema 与生命周期留在 Plugin；旧无 User 路径不回退。
2. **R2 调用协议**：保留同步 callPlugin 与硬依赖，复用现有 request/callers 授权；明确 Chat → Agent request、Agent → Store 同步调用、Agent → Model Service request 及 Agent → Chat broadcast 顺序，不新增独立 ACL。
3. **R3 流式与 Stop**：将现行代码差距明确记录为未完成实现；目标要求包括持久化成功后才广播、失败停止该 generation、终态等待队列收口，以及取消终态持久化后才报告稳定停止。提出兼容现有接口的最小机制与故障验收，不宣称文档变更已修复代码。
4. **R4 质量与证据**：保持 candidate 90 次全部可评分等既有严格门禁；准确记录 current 90/90、candidate 89/90 可评分且 89/89 通过、1 次 Provider 空响应；说明 oracle state 注入的评测边界，不能外推为真实模型状态抽取或完整工具链路通过。
5. **R5 运维能力**：删除已撤下的 JSONL 导出 API 及相关已完成验证承诺；按实际 tombstone + SQLite 事务描述删除。operation journal、新版本恢复及对象校验若保留为未来需求，须明确未实现与适用范围，不反向新增实现。
6. **R6 回滚边界**：Kit 恢复成功时才可继续使用旧 Kit；恢复本身失败必须 fail closed 并说明重建 runtime，保留激活与恢复两类错误，不保证无条件完整恢复。
7. **R7 状态一致**：任务、设计、总结、正式架构之间不再一边写全部完成、一边记录未满足门禁；保留历史时间与证据，标清当前复核结论，避免把过期设计当现行事实。
8. **R8 最小改动**：只修改允许文档，保持原始评测 JSON、源码和无关已有改动的内容哈希；不发明新基础设施、未批准业务规则或通过数字。
9. **R9 独立验收**：作者交付逐项覆盖矩阵；独立校验 Agent 对同一 R1–R9 给出通过或不通过及精确位置；有阻塞时退回作者，双方通过后由主 Agent 独立复核实际 diff、文档链接、Task 契约与争议项并裁定。

## 约束

- 文档使用中文，优先采用当前代码和 ADR 0005 已接受边界。
- 主 Agent 独占环境选择、Task 状态与最终裁定；作者和校验者是不同子 Agent，校验者只读。
- 保护当前已有的 14 个修改或未跟踪文件；仅按用户本次授权修订对应 Markdown，不 stash、reset 或清理。
- 进入设计和修改既有文档前，按 change-workflow 完成 current/worktree 环境选择。
- 当前正式 decision memory 检索无命中，fresh、failed_files=0；不把无命中当作不存在仓库决策，以 ADR 0005、核心原则及现行源码约束本轮。

## 需求变更

本 Task 尚无需求变更；用户明确要求作者、独立校验者与主 Agent 裁判三个角色。

## 决策上下文与处置

- 已接受依据：`docs/decisions/0005-plugin-default-boundaries.md`、`docs/architecture/core-principles.md`、Plugin runtime 和 Store 正式架构。
- 审查来源：主 Agent 与独立存储、运行时审查者的只读代码核对；缺口尚未授权修复源码。
- owner：主 Agent，负责要求、环境、状态、验证与裁定；author：后续指定文档子 Agent；reviewer：另一独立只读子 Agent；approver：当前用户。
- 处置：当前事实写入正式架构；未实现保证保留为目标和待办；历史评测保持原样；不新增 accepted ADR。

## 工作环境与角色

- 用户已在任务定义后选择 `current`，使用 `/Users/bytedance/Project/harbors`，分支 `main`，基线 `ae2f31f831c1d4a38ce3a33c4bd1690e733a707f`，已有改动按 `preserve` 保留。
- 作者：`author_context_store_design`，独占允许范围内的 11 份 Markdown 修订及本 Task 的计划/作者交付过程材料。
- 独立校验者：`validate_context_store_design`，只读审核相同 R1–R9，不代写设计，不更改状态。
- 主 Agent：独占正式 Task 状态、环境、原档案状态纠偏与最终裁定；校验不通过时退回作者修订。
- 原 14 份未提交材料及 Store 正式架构已保存修订前快照；原始 P100/Q30 JSON 必须保持哈希一致。
