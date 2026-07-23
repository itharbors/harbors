# Kit Marketplace Phase 5: Kit Workflow 与产品分支迁移

> 执行时继续遵循 `superpowers:test-driven-development`、`skill-creator` 与
> `superpowers:writing-skills`。由于当前会话禁止创建 subagent，Skill 的 RED/GREEN 验证使用真实
> 临时 Git 仓库、GitHub CLI mock 和可执行契约测试，不以未执行的场景评审替代。

## 目标

交付仓库级 `kit-workflow` Skill，让 Kit 变更始终从 `origin/kit/<kit>` 创建隔离 worktree，完成时
只能向对应产品分支创建 PR；提供显式 Stable 发布准备入口。随后把 SQLite、MySQL 与 Notifications
迁移为可独立测试、构建和自动发布的本地产品分支快照，不在本阶段推送或触发真实 Release。

## Task 1：先建立失败的工作流契约

- 新增根级 `test:kit-workflow`，在临时 bare origin 中覆盖 start、finish、release 三个入口。
- 证明当前失败原因为 `kit-workflow` 尚不存在。
- 覆盖错误基线、分支/路径冲突、manifest/runtime 不匹配、提交标签、PR base、检查失败与发布确认。

## Task 2：实现并验证 `kit-workflow` Skill

- 用 `skill-creator` 初始化 `.agents/skills/kit-workflow`，只保留 `SKILL.md`、`agents/openai.yaml` 与
  必需脚本。
- 实现 `start-kit-change.sh`、`finish-kit-change.sh`、`release-kit.sh`。
- start 固定 `origin/kit/<kit>`；finish 固定 PR base `kit/<kit>`；release 在展示 Kit、版本、Commit、
  Tag 后要求明确确认，且只允许已在远端产品分支的干净 Commit。
- 运行契约测试和 Skill validator，完成 RED/GREEN/REFACTOR。

## Task 3：生成可复现的产品分支快照

- 先为迁移器写失败测试，定义独立根 `kit.json`、锁文件、caller workflow、构建/测试脚本和只包含
  所需插件/合同包的文件集合。
- 实现迁移器，并在临时目录分别生成 sqlite、mysql、notifications 快照。
- 对每个快照执行 `npm ci`、`npm test`、`npm run build`、Kit validate 与 publish prepare。

## Task 4：创建本地产品分支

- 从经过验收的快照创建独立历史 `kit/sqlite`、`kit/mysql`、`kit/notifications` 本地分支。
- 每个分支使用 `[Init]` 提交，记录源 Framework Commit；不推送，避免未经用户确认触发 Preview。
- 验证 branch tree、Commit 和重新 checkout 后的完整构建发布链路。

## Task 5：文档与全链路验收

- 更新开发工作流、Kit 发布指南与 README，明确 Framework/Kit 分支边界和首次推送步骤。
- 在 Framework 功能分支运行 `npm run check`、`npm audit --omit=dev`、`git diff --check`。
- 在三个产品分支运行完整产品检查与 dry-run publish；确认主框架消费链路无需新增内置 Kit 代码。
