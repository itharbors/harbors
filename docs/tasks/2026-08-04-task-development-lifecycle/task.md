# Task 驱动开发生命周期

Task ID: `2026-08-04-task-development-lifecycle`
Type: `feature`

## 背景与问题

仓库需要一套可在长周期、多会话开发中延续的 Task 档案机制，使需求快照、状态、总结和 PR/合并事实有明确边界，并可由命令行机械校验。

## 目标

建立 Task 状态模型、CLI、正式档案合约和 Framework/Kit workflow 集成，以结构化事实驱动从建档到合并确认的生命周期。

## 范围

本 Task 覆盖 JSON Schema 与纯状态领域模型、Task 状态 CLI、Task Markdown 合约、长期开发指南、Framework 和 Kit workflow 集成，以及对应的自动化测试与当前 Task 档案。

## 非目标

本 Task 不替代 GitHub 的 PR、合并或 required checks 事实来源，不把过程性 spec/plan 默认纳入提交，也不在状态文件中保存主观进度叙述。

## 验收标准

- JSON Schema 和纯状态领域模型能校验 Task 的结构与合法状态转换。
- `status.json` 只保存客观、结构化的身份、阶段、时间和 PR 信息。
- spec、plan 等过程材料默认不提交，`.work/` 可用于本地短期材料。
- Framework 和 Kit workflow 通过统一 CLI 集成 Task 生命周期。
- PR 前能生成并校验完整 `summary.md`。
- PR 创建后记录 PR 编号并更新包含该事实的 head。
- 合并后依据 GitHub 与 main 的客观事实派生完成状态。
- 仅在派生完成后归档 Codex 会话，且不为归档创建合并后 commit。

## 约束

正式 Task 文件必须可审查、可长期保留且不含敏感信息；CLI 只在文件系统与 Git 边界执行 I/O，状态规则保持在纯领域模型中。

## 需求变更

本 Task 未发生需求变更。
