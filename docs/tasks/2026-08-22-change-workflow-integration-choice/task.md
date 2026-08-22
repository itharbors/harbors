# 2026-08-22-change-workflow-integration-choice

Task ID: `2026-08-22-change-workflow-integration-choice`
Type: `refactor`

## 背景与问题

当前 `change-workflow` 在实现、验证和提交完成后，将 PR 收口、推送和后续完成判断组织成默认流程，容易让“准备好交付”被误解为“已经授权创建 PR 或整合到 main”。本地开发、远端 PR 和本地 main 整合是不同的交付路径，必须由用户在实现完成后明确选择。

## 目标

- 删除 `change-workflow` 中自动执行 PR 收口的默认路径。
- 在实现、验证和提交完成后暂停，并明确询问用户选择：创建或更新 PR、本地 main 整合、暂不处理。
- 创建或更新 PR 以及任何 push 都必须取得对应的明确授权。
- 选择本地 main 整合后，再明确询问 fast-forward、merge commit 或 squash；任何 merge 都必须取得对应授权。
- 用户选择暂不处理时保留当前分支和 worktree，不执行外部同步或本地整合。

## 范围

- `change-workflow` 的收口说明、脚本和相关流程文档：移除自动 PR 创建、更新、push 或合并的暗示和默认动作。
- 实现、验证、提交完成后的交接门：展示三种后续路径，并记录所选路径及其授权边界。
- 本地 main 整合路径的 fast-forward、merge commit、squash 三种明确选项及其前置确认。
- 与上述流程相关的 Task/脚本检查和文档验收，使流程在未获授权时能够停在交接门。

## 非目标

- 不改变具体产品功能、Framework、Kit 或 Plugin 的运行时行为。
- 不改变 Task 状态 schema、Task 阶段定义或 PR 完成判定的客观事实要求。
- 不自动创建、更新或关闭 GitHub PR，不自动 push，不自动 merge、rebase 或 reset。
- 不替用户决定 PR、本地整合、整合策略或远端目标；也不把本次授权固化为后续任务的默认授权。
- 不清理已有分支和 worktree，不改变产品运行时代码或发布制品流程。

## 验收标准

- `change-workflow` 的实现/验证/提交完成路径在任何 PR、push 或 main 整合动作前都进入明确的用户选择门。
- 选择“创建或更新 PR”前，流程明确要求用户授权对应的 push、PR 创建或 PR 更新动作；未授权时不调用相关脚本或 API。
- 选择“本地 main 整合”前，流程明确要求用户授权；获授权后必须再次展示 fast-forward、merge commit、squash 三个选项，并只执行用户选定的方式。
- 选择“暂不处理”后，流程停止并保持当前分支、worktree 和提交不变。
- 任意 push、PR 创建/更新、merge、rebase 或 reset 都没有隐式授权路径，相关文档和脚本检查结果一致。
- Task 文档、流程脚本和相关测试/检查能够通过仓库现有的局部验证，不引入新的桌面宿主假设。

## 约束

- 任何会改变远端或本地 main 历史的动作都必须有针对该动作的明确授权；“完成”“收口”“继续”或已有其他授权不能替代该确认。
- 保留隔离 worktree、Task 建档、真实验证和提交规范；流程暂停时不得为了归档而制造额外提交。
- 本 Task 将修改受影响的 workflow Skill、收口脚本、测试和正式指南；实现与验证按这些边界取并集。
- 不得把 PR 已创建、push 成功、compare URL 或脚本返回成功误判为 PR 已合并或 Task 已完成。
- 只支持仓库现有 Web 宿主边界，不加入 Electron、桌面打包、原生窗口生命周期、托盘、更新器或桌面 IPC 假设。

## 需求变更

- 用户已确认本次流程应删除自动 PR 收口，并在实现/验证/提交分支后停下询问后续路径。
- 本 Task 的交付包括 workflow Skill、脚本、测试和正式指南的实际改造；本地 main 的 squash 选择属于本次操作的明确授权，不构成未来任务的默认授权。
