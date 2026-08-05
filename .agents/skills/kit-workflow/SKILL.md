---
name: kit-workflow
description: Use when starting, continuing, finishing, or releasing an independently published Harbors Kit in the harbors monorepo.
---

# Kit Workflow

Every Kit change follows one Task through six stages without weakening Kit ownership or release authorization. Kit source lives at `main:kits/<kit>`; `main` is the only long-lived development branch. A release Tag selects exactly one Kit directory.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-kit-change.sh <kit> <type> <slug>` | `TARGET_BRANCH=main`, branch, worktree, locked `BASE_COMMIT`, `TASK_ID=`, `TASK_DIR=` |
| Continue | Work only in the emitted worktree | `kit-change/<kit>/<type>/<slug>` |
| Task state | `npm run task:status -- <action> ...` | Printed Task ID |
| Finish | `scripts/finish-kit-change.sh <kit> <summary> <body-file>` | Verified open PR targeting `main` and `PR_URL=` |
| Recover release | `scripts/release-kit.sh <kit> <version>` | First shows identity; confirmed run pushes a missing `kit/<kit>/v<version>` |

## Six stages

1. **需求确认与分类**：先确认背景、目标、范围、非目标、验收、约束，再分类为 `feature`/`bug`/`optimize`/`docs`/`refactor`/`test`/`chore`；提交标签依次对应 `[Feature]`、`[Bug]`、`[Optimize]`、`[Docs]`、`[Refactor]`、`[Test]`、`[Chore]`。
2. **Task 建档**：从 primary worktree 运行 start。它校验仓库本地身份与 Kit、锁定已 fetch 的 `origin/main`、创建 `.worktrees/kit-<kit>-<type>-<slug>`、运行根 `npm ci` 并自动 init Task。进入输出的 worktree 后立即填写 `task.md`。截止时间、负责人授权和已投入时间都不是跳过 Task 的例外；已有代码但没有 Task 时，先补建并填写，再继续或 finish。
3. **设计与计划**：spec、plan、research 默认放在当前 Task 的 `.work/`；`.work/` 默认不提交。跨需求长期有效的架构、安全、迁移或维护规则升级到正式 guide、reference、ADR 或设计文档。
4. **实现与验证**：用 `npm run task:status -- start|complete|skip|block|resume|rewind <task-id> <stage>` 推进并保留真实测试证据。`status.json` 只由 `task:status` CLI 管理 schema 字段，只记录客观结构化事实；原因猜测、风险判断、交接说明、下一步建议等主观自由文本写入明确命名的 `.work/` 记录或按长期价值升级，绝不写入 status。三份 Task 正式档案（`task.md`、`status.json`、`summary.md`）是 boundary 允许的共享治理例外；它不授权修改其他 Task、其他 Kit 或仓库共享代码。
5. **收口与 PR**：先完成 `summary.md`，使所有内部 stages 终态，并通过 ready gate（`--ready-for-pr`）。使用 clean linked worktree 和仓库外的 PR body，包含 `## Summary` 与 `## Testing`；传给 finish 的 summary 不带方括号标签、不带换行且末尾无句号。finish 再验证 Task/boundary、版本与 release intent，执行目标 Kit 的 build、test、validate、pack、inspect，创建或恢复 PR，添加不可变 summary 链接，回写 PR 号、自动提交并二次 push。审查要求实质改动时用 `rewind` 回退 implementation、verification 或 consolidation，重新实现、验证、更新 summary，再运行 finish。
6. **合并确认与会话归档**：`PR_URL=` 只代表收口已提交，不代表需求完成。只有内部 stages 终态、status 有 PR 号、GitHub PR 已 merged、latest head commit 的 repository-required checks 成功、三份 Task 正式文件已在 `main`，才宣布完成并归档当前 Codex 会话；不为归档制造合并后 commit。

## Resume and handoff

同机跨会话先读 `task.md` 和 `status.json`，再读 `.work/` 中必要的 plan、research、handoff，最后核对 Git branch/status/log/diff；本地恢复完成后才查询 GitHub 的 open/merged/checks 实时事实。status 只用于定位阶段，主观信息不得写入其中，恢复时不猜测也不重做已完成工作。

跨机或跨环境不能依赖 `.work/`：把已验证、长期有效的客观事实升级到 `task.md`、`summary.md` 或正式 docs；未验证猜测须明确标注并放到经授权的非 status 交接渠道。

## Kit identity and version

Before finishing a market Kit change, update `kits/<kit>/kit.json`, `kits/<kit>/package.json`, and `kits/<kit>/package-lock.json` to one matching, strictly higher canonical SemVer. Plain SemVer is Stable; a prerelease segment is Preview; build metadata is forbidden. Framework and builtin Kit changes do not enter this independent Kit release path.

The finish workflow verifies commits since `origin/main`, branch/type labels, Task readiness, the target boundary, release intent, and an open PR whose base is exactly `main`. A successful push or compare URL is not a created PR.

## Publication and recovery

A market Kit PR carries its version increase. PR 合并即发布授权: after merge, GitHub creates each exact Tag and dispatches the immutable publisher. Preview proceeds automatically; Stable retains the `kit-stable` Environment approval. Task 生命周期不自动授权 Kit 发布；在用户明确授权 release intent 前不得把开发请求解释为实际发布授权。

Normal publication is automatic after merge. Use `release-kit.sh` only to recover a missing automatic Tag from an already reviewed and merged `main` Commit. Recovery requires clean local `main` exactly equal to `origin/main`; Tag version, the three version records, identity, and channel must agree, and the Tag must not exist locally or remotely.

First run without confirmation and present `RELEASE_CONFIRM=kit/<kit>/v<version>@<40-char-commit>`. Only after explicit recovery approval rerun with `HARBORS_KIT_RELEASE_CONFIRM=<exact-token>`. Never replace, move, overwrite, or delete an existing Tag or Release.

## Hard boundaries

Do not stash, pull, merge, rebase, hard reset, force push, delete worktrees, reuse a change branch, override the `origin/main` base, publish from another branch or Commit, or change another Kit/shared repository code. Keep worktrees and branches unless removal is explicitly requested. 用户说“完成”不授权 merge；不主动合并 PR。
