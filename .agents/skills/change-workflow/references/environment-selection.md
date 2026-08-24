# 工作环境确认

Task 定义完成、`requirements` 已终态后，主 Agent 必须固定询问一次：

> Task 已定义完成。请选择执行环境：
> - `current`：在当前工作区继续，保留已有改动，不创建分支或 worktree。
> - `worktree`：基于本地 `main` HEAD 创建独立 worktree。

未收到明确选择前，不得开始 `design`，不得创建分支/worktree，也不得把“默认隔离”当成用户选择。用户已经明确选择的当前工作区仍需记录为环境事实，但不覆盖已有改动。

## current

唯一入口为 `current <task-id>`；它只验证并登记当前工作区，不创建分支或 worktree。

1. 记录绝对路径、当前分支、HEAD、工作区 dirty 状态和已有改动范围。
2. 若 `git branch --show-current` 为空，拒绝 detached HEAD；先让用户切换到具名分支后再选择 current。保留用户改动；只在 `allowed_paths` 内编辑。若目标文件与已有改动重叠，先报告风险并等待用户决定，不得 stash、reset 或清理。
3. 不要求当前分支是新分支，也不强制创建分支；主 Agent 仍要确保 Task 已存在且唯一。

## worktree

唯一入口为 `worktree <task-id>`；它只在用户选择后创建隔离环境。

1. 读取本地 `main` 的 HEAD 作为 `base_commit`。本地 `main` 缺失、当前 checkout 不是 primary 或路径冲突时停止并报告；不要静默改用 `origin/main`。
2. 取得创建 worktree/分支的明确选择后，使用仓库既有启动能力创建隔离环境，并把启动前已经形成的 Task 目录安全地带入新环境。转移阶段的 `dirty_policy` 为 `preserve`，仅允许 Task 文件及 packet 已声明路径未提交；创建过程不得删除或覆盖用户已有文件。
3. 将新 worktree 的绝对路径、分支、`base_commit`、Task 目录和 dirty 策略写入后续 StagePacket。完成首个纳入 Task 正式文件的提交后，主 Agent 才可把后续 work unit 的策略切换为 `clean-required`；sub-agent 不得再次创建环境或改变策略。

## 重入和切换

环境一旦选定即是当前执行事实。恢复时先读取 Task 和状态，再核对 Git worktree 列表与路径；不要因为远端状态变化而自动切换环境。用户若要从 current 改为 worktree，先停止执行计划，说明已有改动如何处理，并重新取得明确选择。远端事实校验只用于 push/PR 路径，不得成为本地开发基线的隐含前置条件。
