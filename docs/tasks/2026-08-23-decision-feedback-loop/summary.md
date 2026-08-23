# 2026-08-23-decision-feedback-loop 实现总结

## 最终结论

本 Task 的文档闭环交付和 consolidation 证据已形成：决策约束、实现事实、正式投影、Task 证据和外部辅助索引的边界已明确，启动检索到反向检索的流程已嵌入现有五个 Task stages。Task 普通 check、`git diff --check`、闭环相关定向测试、相对链接检查和 Retrieval Verification 均通过；全量 `kit-docs` 测试在当前 source 与未修改的本地 `main` 均为 9/10，唯一失败是两者共同缺少 `kits/agent-chat/README.md` 的预存基线问题。本 summary 记录实际收口事实，Task 机器状态仍只由 Task CLI 管理。

## 基线重做与整合事实

当前 source worktree `.worktrees/docs-decision-feedback-loop-local-main` 的 branch `docs/decision-feedback-loop` 基于本地 `main` 的 `476d270`，`main` 是其祖先；在后续收口提交前，`main...HEAD=0/1`。旧备份分支 `docs/decision-feedback-loop-origin-base` 与旧备份 worktree `.worktrees/docs-decision-feedback-loop` 分别保留为可恢复备份。

首次 `integrate` 使用落后本地 `main` 79 个提交的 `origin/main` 基线，在 `docs/README.md`、`docs/guides/development-workflow.md` 和 `docs/tasks/README.md` 冲突后 fail closed，`main` 未修改。重做时将原闭环提交 cherry-pick 到本地 `main` 基线；上述三条路径均以 local `main` 最新内容和正确 CLI 语法为准叠加闭环内容完成解决。当前交付不再以旧 origin 基线或其历史验证结果描述环境。

## 需求完成情况

1. 已完成 Decision Context、角色反馈、Decision Disposition、Decision Compliance、Decision Delta 和 Retrieval Verification 的完整闭环定义。
2. 已明确 accepted ADR 是跨任务决策约束的权威发布位置，源码与测试是实现事实权威，architecture/guide 是同步投影，外部 decision memory 只能辅助发现和定位来源。
3. 已覆盖五个既有 Task stages、阶段闸门、重入条件、失败处理和 `skipped` 的无项证据要求，未新增第二状态机。
4. 已记录 owner、reviewer、approver 的来源、范围、反馈/批准日期和人工批准边界；未经批准的信息不会成为 accepted 决策。
5. 已完成 ADR、guide、workflow、Task README、docs README 和 decisions README 的正式入口与关联更新。
6. 已完成 5 组 Retrieval Verification 查询，均命中权威文档，未发现反向检索缺口。
7. 已完成 Task 普通 check、`git diff --check`、闭环相关 `kit-docs` 定向测试 1/1，以及 9 个相关 Markdown 文件的相对链接检查；全量 `kit-docs` 在当前 source 和未修改的本地 `main` 均为 9/10，唯一失败为共同的预存基线缺失文件。

## 主要改动

- 新增 [决策反馈闭环指南](../../guides/decision-feedback-loop.md)，定义权威边界、ADR 正式状态、闭环处置标记、阶段产物、人工闸门、重入、失败和反向检索。
- 新增并接受 [ADR 0003](../../decisions/0003-decision-feedback-loop.md)，记录闭环嵌入现有 Task 生命周期的决策及其替代方案和影响。
- 更新 [开发工作流](../../guides/development-workflow.md)、[文档维护指南](../../guides/maintaining-docs.md)、[Task README](../README.md)、[docs README](../../README.md) 和 [ADR README](../../decisions/README.md)，接入入口、索引和维护约定。
- 补充本 Task 的需求快照、决策上下文、角色处置、验证证据和本收口总结。

## 关键决定

- accepted ADR 是跨任务决策约束的权威发布位置；源码与测试继续作为当前实现事实权威。
- ADR 正式状态仅为 `proposed`、`accepted`、`rejected`、`partially superseded` 和 `superseded`；`candidate`、`conflict`、`exception` 仅为闭环处置标记。
- 闭环复用 `requirements`、`design`、`implementation`、`verification`、`consolidation`，不创建第二状态机。
- consolidation 必须通过反向检索；失败时保持 `in_progress` 或 `blocked`，不得进入 ready 或宣称完成。

## 决策闭环收口

本 Task 的 Decision Delta 分类如下：

| 分类 | 本次结果 | 正式落点或证据 |
| --- | --- | --- |
| 已批准决策 | ADR 0003：决策反馈闭环嵌入现有 Task 生命周期 | [ADR 0003](../../decisions/0003-decision-feedback-loop.md) |
| 当前架构事实 | 无业务架构变化 | 既有架构约束仅作为适用上下文 |
| 操作方法 | 新增 guide，并接入 workflow、tasks README、maintaining-docs | [闭环指南](../../guides/decision-feedback-loop.md)、[开发工作流](../../guides/development-workflow.md)、[文档维护指南](../../guides/maintaining-docs.md)、[Task README](../README.md) |
| 待讨论方案 | 自动检索 CLI、自动语义 gate 不在本次实现范围 | 保留为后续候选，不作为约束 |
| Task 范围内已批准执行约束 | 本次 source 使用 local `main` 基线 | 本 Task 的基线重做记录；不升级为 ADR |
| 一次性任务证据 | 测试、链接检查、查询命中和术语检查输出 | 本 Task 的验证结果和历史过程记录 |
| conflict/exception | 初次整合的三路径冲突已 fail closed，重做后已按 local `main` 优先解决 | 基线重做记录；当前无未决冲突或已批准例外 |

发布后的 5 组查询均命中 ADR 0003、decision-feedback-loop guide、development-workflow 或 tasks README 等权威文档；术语检查未发现 `conflicted` 或“仓库 Markdown 保持单一权威”残留，反向检索无未决缺口。

“自动 CLI/base 选择”仍只是后续 candidate，不属于本次已批准决策；本次已批准的仅是 Task 范围内采用 local `main` 作为 source 基线的执行约束。

## 验证结果

- `node scripts/task-status.mjs check 2026-08-23-decision-feedback-loop`：通过。
- `git diff --check`：通过。
- `node --test --test-name-pattern='docs navigation and guides define the six-stage Task lifecycle using real commands' scripts/lib/kit-docs.test.mjs`：1 test passed。
- `node --test scripts/lib/kit-docs.test.mjs`：当前 source 9/10 通过；唯一失败为 `kits/agent-chat/README.md` 的 ENOENT。未修改的本地 `main` 同样为 9/10、同一 ENOENT，确认为预存基线问题，未在本 Task 修复。
- 自定义相对链接检查：9 个相关 Markdown 文件的 87 个相对链接全部存在。
- Retrieval Verification：5 组查询均命中权威文档，分别覆盖任务规划/决策/角色反馈、Decision Context/owner/reviewer/approver、Decision Delta/反向检索/下一任务、反向检索失败/consolidation/blocked、ADR 正式状态/conflict/exception。
- 最终只读复核通过，无阻塞，可完成 consolidation。

## 影响与风险

- 本 Task 仅改变文档契约、索引和 Task 记录，不改变业务代码、Plugin/Kit 协议、Web-only host 行为、Task CLI schema 或测试实现。
- 后续任务需要维护 ADR 与源码/测试事实、architecture/guide 投影之间的一致性，并在范围变化时重检。
- 外部 memory 仍可能 partial 或失败；仓库已接受 ADR 的权威发布位置和本地定向扫描可支持降级恢复。
- 自动检索和自动语义 gate 尚未实现，后续仍需人工完成检索、处置、批准和反向验证。

## 偏差与遗留

- `scripts/start-change.sh` 仍硬编码 `origin/main`，与本次 source 使用 local `main` 的执行约束不一致。这是后续工作流缺口，不属于本 Task 已实现内容，也未写入 accepted ADR；如需自动选择 local `main`，应另建 Task 评估并实现。
- `kit-docs` 全量测试在当前 source 与未修改的本地 `main` 共同因缺少 `kits/agent-chat/README.md` 失败 1 项；该预存基线问题未在本 Task 修复。

## 后续关注

- 后续文档变更继续执行反向检索，确认新决策能被下一项任务通过意图、路径和术语找到。
- 如要实现自动检索 CLI 或自动语义 gate，应另建 Task 和正式设计，不将本次候选方案直接视为 accepted 决策。
- 如要修复 `start-change.sh` 的基线选择缺口，应另建工作流 Task；本次不把自动 CLI/base 选择升级为 ADR。
- 合并前按 change-workflow 继续推进 Task CLI 状态和 ready gate；不直接手改 `status.json`。

## 相关正式文档

- [ADR 0003：决策反馈闭环](../../decisions/0003-decision-feedback-loop.md)
- [决策反馈闭环指南](../../guides/decision-feedback-loop.md)
- [开发工作流](../../guides/development-workflow.md)
- [文档维护指南](../../guides/maintaining-docs.md)
- [Task 档案说明](../README.md)
- [文档入口](../../README.md)
- [ADR 索引](../../decisions/README.md)
