---
name: change-workflow
description: Use when starting, continuing, or closing feature, bug, docs, refactor, optimization, test, or maintenance work in the Harbors repository, especially requests mentioning a worktree, branch, push, or GitHub pull request. Do not use for release branches or work outside this repository.
---

# Change Workflow

Every deliverable change follows one Task through six stages. Keep the change isolated from the primary checkout and use the bundled scripts for Git and Task invariants.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-change.sh <type> <slug>` | `WORKTREE_PATH=`, `BRANCH=`, `CHANGE_TYPE=`, `BASE_COMMIT=`, `TASK_ID=`, `TASK_DIR=` |
| Continue | Work only in the emitted worktree | Branch equals emitted `<type>/<slug>` |
| Close locally | 完成实现、验证、summary、提交并停止 | 向用户询问下一步，不产生 push、PR 或 main 合并 |
| Integrate locally | `scripts/integrate-change.sh <source-worktree> ff --confirm`；或 `<source-worktree> <merge|squash> --confirm <commit-title>`（merge/squash 必须提供合法中文标签标题，ff 不传标题） | 明确授权后，目标 `main` 完成指定整合 |

## Six stages

1. **需求确认与分类**：先确认背景、目标、范围、非目标、验收、约束，再分类为 `feature`/`bug`/`optimize`/`docs`/`refactor`/`test`/`chore`。类型对应 `[Feature]`、`[Bug]`、`[Optimize]`、`[Docs]`、`[Refactor]`、`[Test]`、`[Chore]`；`[Init]` 只用于仓库初始化。
2. **Task 建档**：先向用户说明计划创建的 `<type>/<slug>` 分支和 `.worktrees/<type>-<slug>` worktree，并取得明确同意后，才从 primary checkout 运行 start；它锁定已 fetch 的 `origin/main`、创建分支与 worktree，并自动 init Task。未获得明确同意时，不得运行 start 或以其他方式创建该分支或 worktree。进入输出的 worktree 后立即填写 `task.md` 中已确认的需求。截止时间、负责人授权和已投入时间都不是跳过 Task 的例外；已有代码但没有 Task 时，先补建并填写 Task，再继续。
3. **设计与计划**：spec、plan、research 默认写入当前 Task 的 `.work/`；`.work/` 默认不提交。若形成跨需求长期有效的架构、安全、迁移或维护规则，将其升级到正式 guide、reference、ADR 或设计文档。
4. **实现与验证**：用 `npm run task:status -- start|complete|skip|block|resume|rewind <task-id> <stage>` 推进状态，运行聚焦测试并保留真实证据。`status.json` 只由 `task:status` CLI 管理 schema 字段，只记录客观结构化事实；原因猜测、风险判断、交接说明、下一步建议和其他自由文本写入明确命名的 `.work/` 记录或正式文档，绝不写入 status。
5. **本地收口与选择**：完成 `summary.md`，使 implementation、verification、consolidation 等内部 stages 终态，并通过现有 ready gate（命令名暂保留兼容：`npm run task:status -- check <task-id> --ready-for-pr`）。提交所有改动并保持源 worktree clean。完成这些本地检查后必须停止，向用户提供三项选择：A 创建 PR；B 整合到本地 `main`；C 暂不处理。A 需要随后分别获得 push 和 `gh` 创建/更新 PR 的明确授权；B 需要用户明确选择 `ff`、merge commit 或 squash，并分别授权整合。merge commit 与 squash 都必须提供带合法标签和中文摘要的提交标题。任何选择都不因用户说“完成”而默认执行。
6. **整合确认与会话归档**：只有用户明确授权后才能运行 `scripts/integrate-change.sh`。脚本只在 primary `main` 与源 worktree 都 clean 时工作，不 push、不创建 PR、不删除分支或 worktree、不自动解决冲突。整合成功后，核对三份 Task 正式文件已在 `main`，再宣布需求完成；不为会话归档制造额外 commit。

## Resume and handoff

同机跨会话恢复时，先读 `task.md` 和 `status.json`，再读 `.work/` 中必要的 plan、research 或 handoff，最后核对 Git branch/status/log/diff。完成本地恢复之后才查询 GitHub 实时事实，GitHub 是 PR open/merged/checks 的权威源，这些易变状态不复制进 status。恢复时不猜测、不重做已完成工作：status 只定位阶段，非结构化理由从 Task、`.work/`、正式 docs 与 GitHub 事实恢复。

跨机或跨环境交接不能依赖 `.work/`。将已验证且长期有效的客观事实升级到 `task.md`、`summary.md` 或正式 docs；未验证的主观猜测必须明确标注，并放到经授权的非 status 交接渠道，不得伪装成结构化事实。

## Develop and commit

确认当前分支后再编辑。运行聚焦测试，检查 `git status --short`、`git diff` 和 `git diff --cached`，只暂存相关文件，绝不使用 `git add .`。每个提交都使用与实际内容一致的标签、简洁中文摘要且末尾不加句号；分支类型至少出现在一个提交中。`[Init]` 仅用于仓库初始化。

## Hard boundaries

不得 stash、pull、rebase、hard reset、force push、递归删除、自动清理 worktree，也不得把已有分支当作新任务继续。`main` 的 merge、push、PR 创建或更新只能通过对应的明确授权流程执行；本地整合仅允许在用户明确授权后运行 `integrate-change.sh`。保留 worktree 和分支，除非用户明确要求删除。用户说“完成”不授权创建 worktree/分支、push、创建或更新 PR，也不授权 main 整合；push、PR 与整合分别需要对应的明确同意。不得把 compare URL 或成功 push 当作 PR 已创建。不得将此 Skill 安装到用户级目录。
