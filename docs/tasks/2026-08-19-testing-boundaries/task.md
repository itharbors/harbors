# 2026-08-19-testing-boundaries

Task ID: `2026-08-19-testing-boundaries`
Type: `docs`

## 背景与问题

仓库目前缺少统一的测试指南，Plugin、Kit、Framework 三层的测试所有权、测试类型、文件放置
和范围选择规则没有集中说明。现有约定散落在各文档和脚本中：

- Plugin 单元 / 组件测试与源码并置，但没有统一的 `test:plugin` 命令。
- Plugin package 基本没有 `test` script，现有 `*.test.ts` 不会因 `ce-plugin build/check` 自动运行；这两个命令
  只负责构建和 manifest / 产物校验，不是 Plugin runtime smoke。
- `kits/agent-chat` 与 `kits/default` 的 `test:kit` 目前只执行 `validate`；`kits:test <slug>` 会先构建再执行
  目标 Kit 声明的 test script，但不能笼统宣称仓库已有 Kit assembly 测试。
- Framework 测试位于 `packages/*/tests` 与 `scripts/lib`。
- 局部变更（如只改一个 Plugin）容易被放大为全仓测试，或反过来遗漏跨边界影响。
- `pnpm run check` 与 finish 收口流程当前仍是全仓门禁，与目标“局部验证范围”是独立的现状差异。

需要一份中文统一测试指南，明确各层所有权、测试层级、文件放置、范围选择和当前命令边界，
并区分现有命令与尚未实现的未来命令。

## 目标

- 新增 `docs/guides/testing.md`，确立 Plugin、Kit、Framework 的测试所有权边界矩阵。
- 明确测试层级（Plugin 单元 / 组件、Plugin runtime smoke、Kit 装配、Framework、浏览器验收）
  及其文件放置位置。
- 给出按变更边界选择测试范围的规则，避免局部变更默认运行全仓测试。
- 准确区分当前可用命令与尚未提供的命令，不把 `ce-plugin build/check` 写成 runtime smoke，
  不把 Kit 的 `test:kit` 或 `kits:test` 写成已有 Kit assembly 测试。
- 规定验证证据的记录要求。
- 明确 Web 是唯一宿主，并区分局部验证范围与现有全仓最终门禁。

## 范围

- 文档一致性范围实际包括以下 5 份文档：`AGENTS.md`、`docs/README.md`、
  `docs/guides/developing-plugins-and-kits.md`、`docs/guides/development-workflow.md`、
  `docs/guides/testing.md`。
- Task 正式档案范围包括 `docs/tasks/2026-08-19-testing-boundaries/task.md`、
  `summary.md` 和 `status.json`；它们分别承载需求快照、实现 / 验证总结和机器状态。
- 本版本以文档为主，并同步修正 `scripts/lib/kit-docs.test.mjs` 的文档契约断言；本轮实际编辑覆盖上述 5 份文档、该契约测试文件与本 Task 正式档案，
  不覆盖工作区中其他文件的既有改动。

## 非目标

- 不修改产品代码、运行逻辑或测试运行机制；仅更新 `scripts/lib/kit-docs.test.mjs` 对 Task 命令文档的契约断言。
- 不移动现有测试文件。
- 不新增 `test:plugin` 或其他尚未实现的命令。
- 不改变 `test:kit` 的当前行为（仍为 `validate`）。
- 不把 `ce-plugin build/check` 描述为 Plugin runtime smoke。
- 不笼统声称仓库已经存在 Kit assembly 测试。
- 不把 `pnpm run check` 或 finish 的全仓门禁冒充为局部测试范围要求。
- 不引入 Electron 或桌面宿主验收。

## 验收标准

- `docs/guides/testing.md` 包含所有权边界矩阵、测试层级、文件放置、范围选择规则、
  现有命令与未来命令区分、验证证据记录要求。
- `task.md` 使用仓库 Task 模板章节（背景与问题、目标、范围、非目标、验收标准、约束、
  需求变更）并记录明确验收标准。
- 文档默认使用中文。
- 文档不声称不存在的脚本（如 `test:plugin`）已经实现。
- 文档准确记录 Plugin package 基本无 test script、并置 `*.test.ts` 不会因 `ce-plugin build/check` 自动运行，
  以及 `kits:test <slug>` 的“先构建、再执行目标 Kit 声明的 test script”链路。
- 不要求 Plugin / Kit 局部变更默认运行 Framework 或全仓测试。
- 只有 Framework 变更才运行受影响 Framework 测试；跨边界变更取并集。
- Plugin runtime smoke 放 Plugin 根 `tests/`；Kit assembly 放 `kits/<kit>/tests`；Framework 测试留在
  `packages/*/tests` 和 `scripts/lib`；已有 Plugin 测试与源码并置、不移动。
- `pnpm run check` 与 finish 流程作为现有独立全仓最终门禁记录，不改写为局部验证要求。
- 不包含 Electron 或桌面宿主验收内容。

## 约束

- 文档一致性变更覆盖 `AGENTS.md`、`docs/README.md`、两篇开发指南、
  `docs/guides/testing.md` 与本 Task 文档；契约测试变更仅限
  `scripts/lib/kit-docs.test.mjs`；Task 的 `summary.md`、`status.json` 由 Task 流程维护。
- 不移动测试文件或修改产品代码、运行逻辑；契约测试只校验文档中的真实命令写法。
- Web 是唯一宿主，不加入 Electron 或桌面宿主假设。
- 现有 Plugin 单元 / 组件测试与源码并置，无需移动。
- 需要真实 Plugin runtime 的 smoke 测试可放 Plugin 根 `tests/`；跨 Plugin 装配测试放
  `kits/<kit>/tests/`；Framework 测试留在 `packages/*/tests` 与 `scripts/lib`。

## 需求变更

本 Task 的文档范围从原先仅列出的 `testing.md` 与 `task.md` 扩展为实际涉及的 5 份文档
（`AGENTS.md`、`docs/README.md`、两份 guide 与 `docs/guides/testing.md`），并纳入
`scripts/lib/kit-docs.test.mjs` 的文档契约断言，以及 Task 的 `task.md`、`summary.md`、
`status.json` 三份正式档案。契约测试仅将断言从旧的 `pnpm run task:status -- <action>`
修正为当前可执行的 `pnpm run task:status <action>`，并拒绝旧写法；不改产品代码或运行逻辑。
