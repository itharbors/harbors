# 仓库级功能开发工作流 Skill 设计

## 背景与目标

Harbors 需要一个仅在当前仓库生效的 Codex skill，用统一、安全的方式完成新功能的完整 Git 工作流：同步远端基线、创建隔离 worktree、在功能分支开发和验证、推送远端分支，并在 GitHub 创建 Pull Request。

该 skill 必须避免影响其他仓库，不安装到用户级 skill 目录，也不能通过重置、覆盖或隐式合并来处理本地未提交或未发布的工作。

## 范围

本次实现包括：

- 仓库级 skill：`.agents/skills/feature-workflow/SKILL.md`。
- 开始功能脚本：负责远端同步、状态校验、分支与 worktree 创建。
- 完成功能脚本：负责上下文校验、项目验证、远端推送和 PR 创建所需的确定性步骤。
- 对脚本关键安全分支的自动化测试。
- 必要的仓库忽略规则和使用说明。

本次不包括：

- 自动安装或登录 GitHub CLI。
- 自动解决合并冲突、变基或分支分叉。
- 自动删除已创建的 worktree 或分支。
- 修改用户级 Codex 配置、用户级 skill 或其他仓库。
- 替代人工或 Codex 对代码改动、提交范围和 PR 内容的判断。

## 方案选择

采用“仓库级 skill 编排 + 确定性脚本执行”的组合方案。

仅使用 `SKILL.md` 虽然文件最少，但 Git 状态检查和失败处理容易因每次生成的命令不同而出现偏差。仅使用 shell 或 npm 命令虽然执行稳定，却不适合判断改动范围、拆分提交和撰写 PR 描述。组合方案让脚本承担可测试的 Git 不变量，让 skill 承担需要上下文判断的工作。

## 文件布局

```text
.agents/
  skills/
    feature-workflow/
      SKILL.md
      scripts/
        start-feature.sh
        finish-feature.sh
      tests/
        feature-workflow.test.sh
.gitignore
```

脚本必须从自身位置解析仓库根目录，不能依赖调用者位于固定目录。测试在临时 Git 仓库中运行，不修改真实仓库或远端。

## Skill 触发与职责

Skill 名称为 `feature-workflow`。描述应覆盖以下意图：

- 开始新功能或创建功能 worktree。
- 在独立 worktree 中继续功能开发。
- 完成功能、推送功能分支并创建 GitHub PR。

用户可以通过 `$feature-workflow` 显式调用；Codex 也可以在请求与描述匹配时隐式调用。

Skill 负责：

1. 从用户需求生成简短、可读的 slug。
2. 调用开始脚本并根据结果进入新 worktree。
3. 在开发完成后检查 diff，选择本功能相关文件，并组织清晰提交。
4. 调用完成脚本执行校验和 push。
5. 根据实际改动和验证结果生成 PR 标题与正文，并创建 PR。
6. 准确报告每一步的真实结果，不把 URL 输出或准备状态表述为已经创建 PR。

## 分支和目录约定

- 基线远端：`origin`。
- 基线分支：`main`。
- 功能分支：`codex/<slug>`。
- worktree 路径：仓库根目录下 `.worktrees/<slug>`。
- `.worktrees/` 必须加入仓库根 `.gitignore`。

Slug 使用小写 ASCII 字母、数字和连字符，去除首尾连字符，拒绝空值、路径分隔符、`..` 和其他可能改变路径或 ref 含义的字符。

## 开始功能流程

开始脚本接收一个 slug，并执行以下步骤：

1. 确认当前目录属于目标 Git 仓库，当前位于主工作树的 `main` 分支，并解析仓库根目录和 common Git directory。若从已有 linked worktree 调用则停止，避免更新或嵌套创建到错误位置。
2. 确认远端 `origin` 存在。
3. 执行 `git fetch origin --prune`，只更新远端跟踪引用，不隐式修改工作树。
4. 确认 `main` 与 `origin/main` 都存在。
5. 确认当前主工作树没有未提交改动，包括未跟踪文件。
6. 比较 `main` 与 `origin/main`：两者提交必须完全一致。若本地领先、落后或已经分叉，脚本停止并显示差异摘要，不执行 pull、reset、merge 或 rebase。
7. 确认 `codex/<slug>` 不存在于本地，且 `.worktrees/<slug>` 不存在或不是已注册 worktree。
8. 从 `origin/main` 创建 `codex/<slug>`，并在 `.worktrees/<slug>` 创建 linked worktree。
9. 输出新 worktree 的绝对路径、分支名和基线提交。

严格一致的基线要求可以防止本地 `main` 的未发布提交被意外夹带到功能 PR，也可以防止脚本擅自处理分叉历史。同步异常属于需要用户明确处理的仓库状态，而不是小型默认决策。

## 功能开发流程

Skill 在新 worktree 中完成用户请求。开发过程中遵循仓库现有约定，并根据改动运行针对性测试。完成前：

1. 使用 `git status` 和 `git diff` 审查全部改动。
2. 排除与当前功能无关的用户改动。
3. 按逻辑范围显式暂存文件，不使用无差别的 `git add .`。
4. 需要多个独立提交时按可审查的逻辑拆分；否则创建一个聚焦提交。

## 完成功能流程

完成脚本从功能 worktree 中运行，接收 PR 标题和正文文件路径，并执行以下步骤：

1. 确认当前目录位于 linked worktree，而不是主工作树。
2. 确认当前分支符合 `codex/<slug>`，且不是 detached HEAD。
3. 确认工作树没有尚未提交的改动。
4. 确认分支相对于 `origin/main` 至少包含一个提交。
5. 运行 `npm run check`。任何失败都会终止后续 push 和 PR 创建。
6. 确认 `gh` 存在且 `gh auth status` 成功。缺失或未登录时停止，并给出一次性的安装或登录提示，不自动修改全局环境。
7. 执行 `git push --set-upstream origin <branch>`。
8. 使用 `gh pr create --base main --head <branch> --title <title> --body-file <file>` 创建 PR。
9. 输出 GitHub 返回的 PR URL，并通过 `gh pr view` 验证 PR 的 head、base 和状态。

PR 正文至少包含：

- `Summary`：变更目的和主要实现。
- `Testing`：实际执行的验证命令及结果。

脚本不使用 `--force` 或 `--force-with-lease`。若远端分支已存在且无法快进推送，流程停止并交由用户决定如何处理。

## 依赖与预检

核心依赖为 Git、Node.js/npm 和 GitHub CLI `gh`。仓库现有 `npm run check` 作为合并前完整验证命令。

开始阶段可以提示 `gh` 尚不可用，但创建 worktree 不依赖 GitHub CLI。完成阶段必须把 `gh` 可执行文件和登录状态作为硬性前置条件，因为目标包含真实创建 GitHub PR。Skill 不应把打开 compare URL 当作创建成功。

## 错误处理与安全边界

所有错误都必须在产生外部写入前尽早发现，并返回可操作的信息。以下情况必须停止：

- 当前工作树脏或存在未跟踪文件。
- 本地基线与远端基线不一致。
- 分支名或 worktree 路径冲突。
- 当前不是预期的 linked worktree 或功能分支。
- 没有可提交或可 PR 的功能提交。
- `npm run check` 失败。
- `gh` 缺失、未登录或 PR 创建失败。
- push 不是快进更新或远端拒绝。

脚本不得执行 `git reset --hard`、强制 push、递归删除、自动 stash、自动 merge、自动 rebase 或自动 worktree 删除。失败后保留现有 worktree、分支和提交，便于恢复和检查。

## 测试策略

测试脚本使用临时目录建立 bare 远端、主仓库和必要的 linked worktree，至少覆盖：

- 正常创建功能分支和 worktree。
- 非法 slug。
- 脏主工作树，包括未跟踪文件。
- 本地 `main` 领先、落后和分叉。
- 已存在的功能分支或 worktree 路径。
- 从主工作树、错误分支或 detached HEAD 调用完成流程。
- 没有功能提交或仍有未提交改动。
- 项目校验失败时不执行 push。
- 缺少或未登录 `gh` 时不声称已创建 PR。
- 成功路径中 push 参数和 PR 的 base/head/title/body 正确。

外部命令通过 PATH 中的测试替身记录调用，确保测试不会访问真实 GitHub 或修改真实远端。

## 验收标准

实现完成后应满足：

1. Codex 在 Harbors 仓库中可以发现并显式或隐式调用 `feature-workflow`。
2. 在同步且干净的 `main` 上，可以一条开始命令创建正确的分支和 worktree。
3. 在任何可能夹带、覆盖或错误处理用户工作的状态下，流程都会在破坏性操作前停止。
4. 完成流程只有在完整校验成功、push 成功且 GitHub 返回并验证 PR 后，才报告 PR 已创建。
5. Skill 和脚本不会写入用户级 Codex 目录，也不会影响其他仓库。
6. 自动化测试覆盖主要成功路径和安全失败路径。
