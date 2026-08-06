---
name: change-workflow
description: Use when starting, continuing, or finishing feature, bug, docs, refactor, optimization, test, or maintenance work in the Harbors repository, especially requests mentioning a worktree, branch, push, or GitHub pull request. Do not use for release branches or work outside this repository.
---

# Change Workflow

Every deliverable change follows one Task through six stages. Keep the change isolated from the primary checkout and use the bundled scripts for Git, Task, and GitHub invariants.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-change.sh <type> <slug>` | `WORKTREE_PATH=`, `BRANCH=`, `CHANGE_TYPE=`, `BASE_COMMIT=`, `TASK_ID=`, `TASK_DIR=` |
| Continue | Work only in the emitted worktree | Branch equals emitted `<type>/<slug>` |
| Task state | `npm run task:status -- <action> ...` | Printed Task ID |
| Finish | `scripts/finish-change.sh <summary> <body-file>` | Verified `PR_URL=` |

## Six stages

1. **需求确认与分类**：先确认背景、目标、范围、非目标、验收、约束，再分类为 `feature`/`bug`/`optimize`/`docs`/`refactor`/`test`/`chore`。类型对应 `[Feature]`、`[Bug]`、`[Optimize]`、`[Docs]`、`[Refactor]`、`[Test]`、`[Chore]`；`[Init]` 只用于仓库初始化。
2. **Task 建档**：从 primary checkout 运行 start；它锁定已 fetch 的 `origin/main`、创建 `<type>/<slug>` 与 `.worktrees/<type>-<slug>`，并自动 init Task。进入输出的 worktree 后立即填写 `task.md` 中已确认的需求。截止时间、负责人授权和已投入时间都不是跳过 Task 的例外；已有代码但没有 Task 时，先补建并填写 Task，再继续或 finish。不要修改本地 `main` 来让 start 通过，失败须原样报告。
3. **设计与计划**：spec、plan、research 默认写入当前 Task 的 `.work/`；`.work/` 默认不提交。若形成跨需求长期有效的架构、安全、迁移或维护规则，将其升级到正式 guide、reference、ADR 或设计文档。
4. **实现与验证**：用 `npm run task:status -- start|complete|skip|block|resume|rewind <task-id> <stage>` 推进状态，运行聚焦测试并保留真实证据。`status.json` 只由 `task:status` CLI 管理 schema 字段，只记录客观结构化事实；原因猜测、风险判断、交接说明、下一步建议和其他自由文本写入明确命名的 `.work/` 记录或按长期价值升级到正式文档，绝不写入 status。
5. **收口与 PR**：先完成 `summary.md`，使 implementation、verification、consolidation 等全部内部 stages 终态，并通过 ready gate（`--ready-for-pr`）：`npm run task:status -- check <task-id> --ready-for-pr`。提交所有改动且保持 worktree clean；PR body 文件放在仓库外，包含 `## Summary` 和 `## Testing`，只列实际运行的检查。传给 finish 的 summary 使用不带方括号标签、不带换行且末尾无句号的中文摘要。finish 创建或恢复 PR，添加指向 pre-PR head 上 summary 的不可变 commit 链接，回写 PR 号、自动提交并二次 push。审查要求实质改动时，使用 `rewind` 回退 implementation、verification 或 consolidation，重新实现、验证、更新 summary，再运行 finish；不要沿用过时证据。
6. **合并确认与会话归档**：`PR_URL=` 只证明收口已提交，不代表需求完成。只有所有内部 stages 终态、status 已有 PR 号、GitHub PR 已 merged、最新 head commit 的 repository-required checks 成功、三份 Task 正式文件已在 `main`，才能宣布需求完成并归档当前 Codex 会话。不为会话归档制造合并后 commit。

## Resume and handoff

同机跨会话恢复时，先读 `task.md` 和 `status.json`，再读 `.work/` 中必要的 plan、research 或 handoff，最后核对 Git branch/status/log/diff；完成本地恢复之后才查询 GitHub 实时事实，GitHub 是 PR open/merged/checks 的权威源，这些易变状态不复制进 status。恢复时不猜测、不重做已完成工作：status 只定位阶段，非结构化理由从 Task、`.work/`、正式 docs 与 GitHub 事实恢复。

跨机或跨环境交接不能依赖 `.work/`。将已验证且长期有效的客观事实升级到 `task.md`、`summary.md` 或正式 docs；未验证的主观猜测必须明确标注，并放到经授权的非 status 交接渠道，不得伪装成结构化事实。

## Develop and commit

Confirm the current branch before editing. Run focused tests, inspect `git status --short`, `git diff`, and `git diff --cached`, stage only relevant files, and never use `git add .`. Label every commit by the change it actually contains, with a concise Chinese summary and no trailing period. The branch type determines the PR title and must appear on at least one commit; supporting fixes, tests, docs, refactors, optimizations, and chores use their truthful labels. `[Init]` remains initialization-only.

## Hard boundaries

Do not stash, pull, merge, rebase, hard reset, force push, recursively delete, automatically clean worktrees, continue an existing branch as new work, or treat a compare URL or successful push as a created PR. Keep worktrees and branches unless removal is explicitly requested. 用户说“完成”不授权 merge；不主动合并 PR。 Do not install this Skill in a user-level directory.
