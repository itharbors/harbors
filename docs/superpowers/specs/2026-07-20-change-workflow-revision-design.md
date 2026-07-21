# 通用变更分支工作流设计

## 背景

仓库当前的 `feature-workflow` 只允许从与 `origin/main` 完全一致且干净的本地
`main` 创建 `codex/<slug>` 分支。实际创建命令已经以 `origin/main` 为基线，因此本地
`main` 的提交位置和工作区状态不应成为开始变更的门禁。同时，统一的 `codex/` 前缀无法
表达功能、缺陷、文档、重构等不同变更意图，也把仓库流程绑定到了特定执行工具。

本设计用通用变更工作流替代现有功能工作流：直接锁定远端基线、按变更类型命名分支，并让
分支前缀、提交标签和 PR 标题保持一致。

## 目标

- 从 fetch 后锁定的 `origin/main` 提交创建隔离 worktree，不依赖本地 `main` 状态。
- 从活动工作流的分支、脚本校验、说明、测试和示例中移除 `codex/` 命名。
- 为功能、缺陷、文档、重构、性能、测试和维护建立一一对应的分类。
- 在完成阶段自动校验分支类型、提交标签、PR 标题和完整项目检查。
- 保留现有的非破坏性原则，不自动处理用户分支、工作区或冲突。

## 非目标

- 不自动同步、重置、合并或变基本地 `main`。
- 不自动续接已经存在的本地或远端变更分支。
- 不自动删除旧 worktree、分支或远端分支。
- 不修改 GitHub 的分支保护或合并策略。
- 不重写已经合并的提交历史。历史规格和计划可以保留旧流程记录，但不再作为活动入口或
  当前约定。

## 组件和迁移

活动 Skill 从 `.agents/skills/feature-workflow` 更名为
`.agents/skills/change-workflow`，描述范围扩展到所有受支持的仓库变更。入口脚本同步更名：

```text
scripts/start-change.sh
scripts/finish-change.sh
tests/change-workflow.test.sh
```

旧 Skill 目录和旧脚本入口直接移除，不保留兼容包装器，避免两套命名和行为长期并存。仓库
中的活动说明、示例、测试夹具和 package script 全部指向新入口。

## 类型与命名约定

分支前缀、提交标签和 PR 标题标签一一对应：

| 类型 | 分支前缀 | 提交和 PR 标签 | 用途 |
| --- | --- | --- | --- |
| 功能 | `feature/` | `[Feature]` | 新功能和面向使用者的新能力 |
| 缺陷 | `bug/` | `[Bug]` | 错误、回归和不符合预期的行为 |
| 文档 | `docs/` | `[Docs]` | 不伴随行为变化的纯文档修改 |
| 重构 | `refactor/` | `[Refactor]` | 不改变预期行为的结构和可维护性调整 |
| 性能 | `optimize/` | `[Optimize]` | 以性能或资源使用改善为主要目的的修改 |
| 测试 | `test/` | `[Test]` | 不伴随产品行为变化的独立测试建设 |
| 维护 | `chore/` | `[Chore]` | 依赖、构建、工具和日常维护 |

`[Init]` 继续保留，仅用于仓库初始化，不提供日常分支类型。

功能实现附带的测试和文档属于同一个 `feature` 变更并使用 `[Feature]`；只有独立的纯测试或
纯文档任务才使用 `test` 或 `docs`。同理，普通结构调整使用 `refactor`，只有以可验证的性能
改善为主要目的时才使用 `optimize`。

slug 必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`。完整分支名为 `<type>/<slug>`，worktree
使用仓库根目录下的扁平路径 `.worktrees/<type>-<slug>`。例如：

```text
feature/user-login       -> .worktrees/feature-user-login
bug/login-timeout        -> .worktrees/bug-login-timeout
docs/branch-workflow     -> .worktrees/docs-branch-workflow
```

## 开始变更流程

开始命令为：

```bash
scripts/start-change.sh <type> <slug>
```

脚本按以下顺序执行：

1. 校验参数数量、type 白名单和 slug 格式。
2. 解析仓库根目录和 common Git directory，并要求从 primary worktree 发起，避免在 linked
   worktree 中嵌套创建或使用错误仓库。
3. 确认 `origin` 存在，执行 `git fetch origin --prune`。
4. 确认 `origin/main` 存在，将其当前 SHA 保存为不可变的本次基线。
5. 确认目标本地分支、对应远端跟踪分支、worktree 路径和已注册 worktree 均不存在。
6. 从记录的基线 SHA 创建 `<type>/<slug>`，并检出到
   `.worktrees/<type>-<slug>`。
7. 输出 `WORKTREE_PATH`、`BRANCH`、`CHANGE_TYPE` 和 `BASE_COMMIT`。

开始流程不要求当前分支是 `main`，不要求本地存在 `main`，不检查本地 `main` 与
`origin/main` 是否一致，也不要求 primary worktree 干净。脚本只更新远端跟踪引用、创建
新分支和新 worktree，不读取、移动或修改本地主分支及其工作区内容。

若 fetch、引用解析或冲突检查失败，脚本在创建分支前停止。若 `git worktree add` 自身失败，
脚本报告 Git 的实际错误并保留可检查状态，不执行自动删除或强制恢复。

## 开发与提交流程

所有编辑、测试和提交都在脚本输出的 worktree 中完成。开始编辑前确认当前分支与输出的
`BRANCH` 一致。提交前检查 `git status --short`、`git diff` 和
`git diff --cached`，只显式暂存本次变更文件，不使用 `git add .`。

当前分支中的每个待合并提交都必须使用与分支类型对应的标签，摘要使用简洁中文且末尾不加
句号。仓库根 `AGENTS.md` 和开发指南更新为七种常规标签加特殊的 `[Init]` 标签。

## 完成和创建 PR 流程

完成命令为：

```bash
scripts/finish-change.sh <summary> <body-file>
```

`summary` 必须是非空单行中文摘要，不含换行，不以方括号标签开头，末尾不加句号。脚本从
当前分支解析类型并生成 PR 标题。例如，在 `bug/login-timeout` 上传入
`修复登录超时状态丢失`，得到：

```text
[Bug] 修复登录超时状态丢失
```

完成脚本按以下顺序执行：

1. 确认当前目录位于 linked worktree，且不是 detached HEAD。
2. 校验当前分支符合七种 `<type>/<slug>` 格式并解析对应标签，同时校验 summary 格式。
3. 确认工作区干净，PR 正文文件存在且包含 `## Summary` 和 `## Testing`。
4. fetch 最新远端引用，确认 `origin/main` 存在，并确认当前分支相对它至少包含一个提交。
5. 校验所有相对 `origin/main` 的待合并提交标题均以分支对应标签和一个空格开头。
6. 执行 `npm run check`；失败时不进行 push 或创建 PR。
7. 确认 GitHub CLI 已安装且认证有效。
8. 使用普通 push 设置 upstream，不使用任何强推选项。
9. 使用自动生成的标题和用户提供的正文创建以 `main` 为 base 的 PR。
10. 通过 `gh pr view` 验证 PR 的 base、head、`OPEN` 状态和 URL，最后输出 `PR_URL`。

`Testing` 只能列出实际执行过的检查。PR 正文临时文件放在仓库和 worktree 之外，避免使工作
区变脏。

## 错误处理和安全边界

脚本不得执行自动 stash、pull、merge、rebase、`reset --hard`、强制 push、递归删除或
worktree 清理。任何门禁失败都立即停止并报告具体状态；已有分支、worktree、提交和用户文件
保持不变，由用户决定后续恢复或协调方式。

远端已有同名分支时，开始流程停止，避免误把新任务接到未知历史。普通 push 不能快进时，
完成流程停止，不自动覆盖远端。

## 测试策略

自动化测试使用临时 Git 仓库和伪造的 `gh`、`npm`，至少覆盖：

- 七种合法类型分别生成正确的分支、worktree、输出和 PR 标签。
- 非法 type、非法 slug、本地或远端分支冲突、路径冲突和已注册 worktree。
- 本地 `main` 缺失、领先、落后、分叉以及 primary worktree 有未提交内容时，仍从锁定的
  `origin/main` SHA 正常创建。
- 从 linked worktree 调用开始脚本时拒绝执行。
- 从 primary worktree、detached HEAD、非法分支或脏 worktree 调用完成脚本时拒绝执行。
- 无新增提交、提交标签与分支类型不匹配、正文结构错误时拒绝执行。
- `npm run check`、GitHub 认证、push、PR 创建或 PR 验证失败时，不误报成功。
- 成功路径只在远端分支已推送且开放 PR 已验证后输出 `PR_URL`。
- Skill 元数据、脚本可执行权限、package script 和活动文档均使用新名称。

## 验收标准

1. 在不修改本地 `main` 的前提下，可以从最新 `origin/main` 一条命令创建任意合法类型的
   隔离 worktree。
2. 活动工作流不再创建或要求 `codex/` 分支，七种类型都有一致的分支、提交和 PR 表达。
3. 本地 `main` 的同步状态和 primary worktree 的未提交内容不会阻塞新 worktree 创建。
4. 完成脚本能在 push 前阻止错误分支、错误提交标签、脏工作区和失败检查。
5. 成功输出的 `PR_URL` 对应一个已验证的、以 `main` 为 base 的开放 PR。
6. 全部工作流测试、Skill 校验和 `npm run check` 通过。
