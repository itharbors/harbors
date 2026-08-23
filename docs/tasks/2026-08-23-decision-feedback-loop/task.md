# 2026-08-23-decision-feedback-loop

Task ID: `2026-08-23-decision-feedback-loop`
Type: `docs`

## 背景与问题

当前任务流程能够分别记录需求、设计、实现和验证，但决策信息没有形成可检索、可反馈、可复用的闭环：任务开始时可能检索历史决策，任务规划时也可能发现新的角色反馈，任务结束时却缺少统一的沉淀、发布和反向检索验证。这样会导致下一项任务无法稳定消费本次任务的决策成果，也容易把未经人工批准的提案误当成约束。

本 Task 将把决策信息纳入现有 Task 生命周期，明确仓库 Markdown 的权威层级、角色反馈、人工批准和失败处理规则。

## 决策上下文与处置

### 基线更正与重做记录

首次整合尝试使用了相对本地 `main` 落后 79 个提交的 `origin/main` 作为 source 分支基线，在 `docs/README.md`、`docs/guides/development-workflow.md` 和 `docs/tasks/README.md` 发生冲突后按 fail closed 规则停止；本地 `main` 未被修改。根据用户确认，本 Task 已重做：当前 source worktree `.worktrees/docs-decision-feedback-loop-local-main` 和分支 `docs/decision-feedback-loop` 基于本地 `main` 的 `476d270`，并在此基线上叠加本闭环变更；旧备份分支 `docs/decision-feedback-loop-origin-base` 与旧备份 worktree `.worktrees/docs-decision-feedback-loop` 分别保留为可恢复备份。上述三个冲突均以本地 `main` 内容为优先，再叠加本 Task 的闭环文档内容完成解决。

本 Task 当前 source 明确指向本地 `main` 基线；`origin/main` 仅作远端状态参考，不作为本次 source 基线或本地整合依据。`start-change.sh` 仍硬编码 `origin/main`，这是后续工作流需要单独处理的开放缺口；本 Task 不修改该脚本，也不将该候选缺口记为已实现或写入 accepted ADR。

### 启动检索与命中结论

任务启动时查询了正式决策记忆：未命中已批准决策，查询结果标记为 `freshness=partial`，并报告 `failed_files=1`。本次实际处置先完成外部辅助检查，再完成仓库权威扫描；外部结果仅作为线索，不能证明不存在决策。后续任务不硬性要求两类查询的先后，但必须完成仓库 Markdown 定向扫描。

已完成以下范围的仓库定向扫描：

| 查询意图 | 扫描范围 | 命中结论 | 处置 |
| --- | --- | --- | --- |
| 确认决策约束及历史取舍 | `docs/decisions` | 既有 ADR 说明插件优先和 Web-only host 的已接受约束；未发现与本 Task 闭环方向冲突的已接受决策 | 作为适用约束，新增 ADR 记录闭环取舍 |
| 确认当前架构事实及边界 | `docs/architecture` | Web-only host、Plugin/Kit 边界属于既有事实和约束 | 本 Task 只同步文档流程，不改变行为 |
| 确认阶段、状态和交接规则 | `docs/guides/development-workflow.md`、`docs/tasks/README.md` | 既有 `requirements`、`design`、`implementation`、`verification`、`consolidation` 五阶段及 Task CLI 是适用流程 | 闭环嵌入五阶段，不新增第二状态机 |
| 确认文档权威、维护和检索入口 | `docs/guides`、`docs/README.md` | 现有指南和入口需要补充闭环索引、权威层级、维护与反向检索契约 | 以已接受 ADR 作为跨任务决策约束的权威发布位置，源码/测试保持实现事实权威，更新正式投影和索引 |
| 确认 Task 记录与恢复要求 | `docs/tasks/README.md` 及相关 workflow | Task 三份正式文件和收口规则适用 | 将 Decision Context、角色处置和 summary 收口纳入本 Task |

以上扫描未发现未决冲突。外部记忆无法回链仓库来源的结果不进入约束集合，保留为 candidate/待确认线索。

### 阶段处置与角色记录

既有 Task 的五阶段是本 Task 的适用流程约束。闭环作为各阶段的决策信息交接契约嵌入其中，不能新增第二状态机。Web-only host 和 Plugin/Kit 边界属于既有架构约束，本 Task 只做文档流程优化，不涉及这些边界的行为变更。

| 角色 | 来源/标识 | 负责范围 | 反馈摘要 | owner 处置 | 反馈或批准日期 | 批准范围 |
| --- | --- | --- | --- | --- | --- | --- |
| Task owner（主 Agent） | Task 指定；主 Agent | 组织检索、整合文档、维护 Task 快照和收口证据 | 需要把闭环嵌入既有五阶段，并让下一任务可检索消费 | 纳入 guide、ADR、索引和 Task 范围；不扩展到脚本、schema 或测试 | 2026-08-23（任务记录） | 无独立批准权 |
| 文档消费审计 reviewer | 本 Task 的 sub-agent 只读评审；文档消费审计 | 审查权威层级、关键词、索引和反向检索可用性 | 必须区分 ADR 约束、源码/测试事实、正式投影和外部辅助索引 | 补充权威表、检索提示、反向检索闸门和 partial 处理 | 2026-08-23 | 仅审查文档消费契约 |
| 闭环契约设计 reviewer | 本 Task 的 sub-agent 只读评审；闭环契约设计 | 审查五阶段交接、产物、重入、角色和人工闸门 | 闭环应复用 Task CLI 状态，决策文档状态不能成为第二过程状态机 | 补充阶段表、重入表、角色分工和失败处理 | 2026-08-23 | 仅审查流程契约 |
| 对抗审查 reviewer | 本 Task 的 sub-agent 只读评审；对抗审查 | 检查权威歧义、状态越界、闸门绕过和范围遗漏 | accepted 只能由人工批准；反向检索失败必须阻止 ready；过程产物不能使用未定义状态 | 将上述问题改为明确规则，并链接当前记录 | 2026-08-23 | 仅审查风险和边界 |
| approver（需求发起人） | 需求确认记录；需求发起人（本次决策批准者） | 确认闭环方向、批准范围和是否接受本次 ADR 取舍 | 已人工确认闭环方向及 worktree 文档范围；未批准内容不得约束后续任务 | 按批准范围标记 ADR 为已接受，发布和反向检索证据留待 summary 收口 | 2026-08-23 | 批准闭环方向、文档范围及 ADR 取舍，不批准业务行为变更 |

用户已人工确认闭环方向以及本次 worktree 范围；新增 ADR 的“已接受”状态仅适用于本次明确批准的闭环决策。

## 目标

1. 定义从任务启动检索到任务收尾反向检索的完整决策反馈闭环。
2. 让决策信息在 `requirements`、`design`、`implementation`、`verification`、`consolidation` 五个内部阶段中有明确的消费、验证和生产位置。
3. 明确已批准决策、架构事实、操作指南、提案、任务证据和冲突/例外的分类及发布去向。
4. 确保下一项任务可以通过稳定的索引提示和适用条件重新找到已发布信息。

## 范围

- 更新 `docs/README.md`、`docs/decisions/README.md`、`docs/guides/development-workflow.md`、`docs/guides/maintaining-docs.md` 和 `docs/tasks/README.md`，将闭环入口、索引、阶段衔接和维护规则接入现有文档体系。
- 新增决策闭环指南 `docs/guides/decision-feedback-loop.md`。
- 新增已接受的 ADR `docs/decisions/0003-decision-feedback-loop.md`，记录采用该闭环的上下文、取舍和影响。
- 完整维护本 Task 三份正式文件：`task.md`、`status.json` 和收口阶段的 `summary.md`；其中 `status.json` 仅由 Task CLI 管理。
- 在文档中定义 Decision Context、Decision Disposition、Decision Compliance、Decision Delta 和 Retrieval Verification 等交接产物。
- 在文档中定义角色反馈、人工批准闸门、权威层级、重入条件和失败处理。

## 非目标

- 不新增独立于现有 Task stages 的第二套状态机、状态文件或运行时服务。
- 不修改现有 `requirements/design/implementation/verification/consolidation` 的状态模型或 `status.json` schema。
- 不实现自动批准、自动发布或把提案自动升级为 accepted 决策。
- 不把外部决策记忆系统作为仓库 Markdown 的替代权威来源。
- 不修改业务代码、插件协议、Kit 装配、测试实现或发布流程。
- 不在本 Task 中迁移或重写其他既有 ADR、架构文档和操作指南的内容；仅在上述文档入口和流程位置接入闭环。
- 不修改 Task CLI 脚本、`status.json` schema 或测试代码；`status.json` 的阶段变更只能通过既有 CLI 完成。

## 验收标准

1. guide 以闭环图或等价文字说明完整链路：启动检索 Decision Context、规划逐条处置与角色反馈、执行中决策到证据映射及范围变化重检、收尾形成 Decision Delta、发布权威 Markdown、反向检索验证供下一任务消费。
2. guide 明确 accepted ADR、源码/测试、architecture/guide 正式投影、Task 证据和外部辅助索引的权威边界与冲突处理。
3. guide 提供完整的阶段/状态表，覆盖现有五个 Task 内部 stages、闭环产物、负责人和闸门，并说明重入条件。
4. guide 明确角色信息至少包括 owner、reviewer、approver 的职责，并规定人工批准才可标记 accepted。
5. guide 明确信息分类和发布位置，覆盖已批准决策、架构事实、操作方法、提案、一次性任务证据、冲突或例外。
6. guide 覆盖检索失败、索引 partial、决策冲突、反馈不完整、执行偏离、发布失败和反向检索失败等处理路径。
7. guide 包含需求覆盖矩阵和非目标，能够逐项对应本 Task 的目标与验收标准。
8. ADR 0003 状态为“已接受”，包含上下文、决策、替代方案、影响、关联，并解释为何沿用现有 Task stages 而不新增第二状态机。
9. `task.md` 通过现有普通 Task check；`git diff --check` 无错误；变更与本 Task 范围一致，且不修改脚本、`status.json` schema 或测试代码。

## 约束

- 文档改动范围限于 `docs/README.md`、`docs/decisions/README.md`、`docs/decisions/0003-decision-feedback-loop.md`、`docs/guides/decision-feedback-loop.md`、`docs/guides/development-workflow.md`、`docs/guides/maintaining-docs.md`、`docs/tasks/README.md` 及本 Task 三份正式文件；不得扩展到业务代码或其他文件。
- 仓库已接受 ADR 是跨任务决策约束的权威发布位置；源码和测试是实现事实权威，architecture/guide 是需同步的正式投影；外部 memory 只能辅助发现和定位来源，`partial` 或失败索引不能证明不存在决策。
- 只有经过人工批准的决策才能进入 accepted 状态并约束后续任务；角色反馈本身不等于批准。
- 闭环必须嵌入现有五个 Task stages，不建立并行生命周期或新的机器状态文件。
- 文档默认使用中文，术语可保留稳定的英文产物名和状态名。
- `status.json` 仅通过既有 Task CLI 管理，不得直接手工修改；允许按 change-workflow 在源分支完成本地提交；push、PR 和本地 `main` 整合分别需要用户明确授权；本 Task 不做联网发布操作。

## 需求变更

用户确认将原有“任务规划后收集角色反馈”的描述扩展为完整闭环：任务启动即检索角色/决策信息，规划后收集并处置反馈，执行中验证，收尾时分类沉淀，并通过反向检索确保下一次任务可消费。该需求已获用户明确批准；本 Task 未发生其他需求变更。

用户进一步确认重做基线：source 分支应基于本地 `main`，因为远端 `origin/main` 已明显落后。因而本 Task 当前 source worktree `.worktrees/docs-decision-feedback-loop-local-main` 和分支 `docs/decision-feedback-loop` 以本地 `main` `476d270` 为基线，远端仅作状态参考；旧备份分支 `docs/decision-feedback-loop-origin-base` 与旧备份 worktree `.worktrees/docs-decision-feedback-loop` 分别保留为可恢复备份，三个文档冲突按本地 `main` 内容优先叠加闭环解决。`start-change.sh` 的 `origin/main` 硬编码属于后续工作流缺口，不在本次需求变更中实现或接受。
