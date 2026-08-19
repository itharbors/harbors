# 测试边界与文档规则总结

## 最终结论

本 Task 已完成 Plugin、Kit、Framework 测试所有权和验证范围的统一文档化。现在按功能单元选择局部验证：只改 Plugin 验证目标 Plugin，只改 Kit 验证目标 Kit，只有 Framework 变更才运行受影响 Framework 测试；跨边界变更取所有受影响边界的并集。该规则定义的是局部开发和变更验收范围，不改变现有全仓收口门禁。

## 需求完成情况

- Plugin 是最小业务单元。Plugin 源码、资源或测试变更默认只验证该 Plugin；Kit 根配置、布局、Kit 级脚本或跨 Plugin 装配变更默认只验证目标 Kit；Framework 变更只验证受影响的 Framework package 或脚本。
- Plugin 单元 / 组件测试与源码并置，覆盖纯函数、状态转换、消息处理或组件逻辑，不启动真实 Plugin runtime；现有测试文件保持原位，不做批量移动。
- 需要真实 runtime 的 Plugin smoke 测试约定放在 Plugin 根目录的 `tests/`；跨 Plugin 的 Kit assembly 测试约定放在 `kits/<kit>/tests/`；Framework 测试继续放在 `packages/*/tests/` 与 `scripts/lib/`。
- UI、Kit 装配或共享可见行为使用唯一的 Web 宿主并按需进行浏览器验收；不引入 Electron 或桌面宿主假设。
- `pnpm run kits:test <slug>`、`pnpm run kits:check <slug>` 和 `pnpm run kits:boundary <slug>` 的目标 slug 不加多余的 `--`；`pnpm run dev:web -- --kit ...` 的双短横线写法保留，因为它是 Web 开发脚本传递 `--kit` 参数的现有用法。
- `ce-plugin build` 只构建 Plugin，`ce-plugin check` 只校验 manifest 与构建产物；二者不运行并置的 `*.test.ts`，也不等同于 Plugin runtime smoke。当前没有统一的 `test:plugin` 命令。
- 当前内置 Kit 的 `test:kit` 主要执行 `validate`。`kits:test <slug>` 会先构建再执行目标 Kit 声明的 test script，但不能据此宣称仓库已经具备 Kit assembly 测试。
- `pnpm run check` 和 finish 流程仍是独立的全仓最终门禁；它们不是局部 Plugin、Kit 或 Framework 变更的默认验证要求。

## 主要改动

- 新增统一入口 [测试指南](../../guides/testing.md)，集中记录所有权边界矩阵、测试层级、文件放置、范围选择、命令边界和验证证据要求。
- 在 [AGENTS.md](../../../AGENTS.md) 中同步最小范围规则和测试指南入口。
- 在 [文档索引](../../README.md) 中加入测试指南导航。
- 在 [插件与 Kit 开发指南](../../guides/developing-plugins-and-kits.md) 中同步 Plugin / Kit 测试分层、命令和 Web 验收约定。
- 在 [开发工作流指南](../../guides/development-workflow.md) 中同步局部验证与全仓门禁的区别，并修正 `task:status`、Kit 目标命令的实际传参写法。
- 为上述文档命令调整同步更新 [scripts/lib/kit-docs.test.mjs](../../../scripts/lib/kit-docs.test.mjs) 契约：覆盖 `task:status` 的生命周期 action，并拒绝旧的 `pnpm run task:status -- ...` 写法。
- 本 Task 未移动现有测试文件，未修改产品代码、运行逻辑或测试运行机制。

## 关键决定

- 测试所有权跟随功能单元边界，而不是按仓库全量默认扩散：Plugin 归 Plugin，Kit 装配归 Kit，Framework 归受影响 Framework。
- 跨边界变更采用并集规则，既覆盖直接修改单元，也覆盖受影响的上层或相邻边界。
- 测试文件按测试所需运行环境区分位置：不启动 runtime 的 Plugin 单元 / 组件测试并置源码；真实 runtime smoke 放 Plugin 根 `tests/`；Kit assembly 放 Kit 根 `tests/`。
- 现有测试布局保持稳定，不为建立规则而批量迁移测试文件；新增测试遵循上述位置约定。
- Subagent Skill 作为独立配套变更已迁移到 Codex 内置 `multi_agent_v1`，固定使用 `gpt-5.6-luna`、high reasoning，并删除旧 Codex CLI runner；这不属于本 Task 的测试所有权规则主体。

## 验证结果

- 聚焦文档契约：1/1 通过，包含本次 `task:status` 命令写法契约。
- Kit matrix 与 Task status 聚焦测试：19/19 通过。
- Subagent Skill `quick_validate`：通过。
- Markdown 本地链接检查：通过；`git diff --check`：通过。
- 完整 `kit-docs` 测试：9/10 通过，其中包含本次新增契约；唯一失败是既有的 `kits/agent-chat/README.md` 缺失，属于本次范围外问题，未处理。
- 本次未执行浏览器验收，也未执行全仓 `pnpm run check` 或 finish 全仓门禁；因此不将它们写作本 Task 的验证证据。

## 影响与风险

- 日常变更可以根据 Plugin、Kit、Framework 边界选择更小的验证范围，减少无关全仓测试，同时通过跨边界并集避免遗漏受影响单元。
- `ce-plugin build/check` 和当前 Kit `validate` 的语义已在文档中明确为构建、manifest / 产物或 descriptor 校验；它们不能替代尚未存在或需要另行提供的 runtime smoke、Kit assembly 测试。
- 全仓 `pnpm run check` 与 finish 收口仍会执行更宽的最终门禁；Task 总结必须把局部证据与全仓门禁证据分开记录。
- `kit-docs` 的既有缺失 README 仍是文档契约全量测试的已知失败项，本 Task 未扩大范围处理。

## 偏差与遗留

- 完整 `kit-docs` 未达到全绿（9/10），唯一失败为既有 `kits/agent-chat/README.md` 缺失；该问题与测试规则文档无关，留待独立 Task 处理。
- 本 Task 只完成规则、入口和契约同步，没有新增 Plugin runtime smoke 或 Kit assembly 测试，也没有改变现有 `test:kit` 行为。
- 当前工作区仍包含其他用户已有改动；本 Task 未提交、未 push，也未清理或覆盖这些改动。

## 后续关注

- 新增或修改测试时，按 Plugin / Kit / Framework 所属边界和对应目录约定落位，并在 Task summary 中记录完整命令、边界归属、退出结果及未覆盖风险。
- 若后续实现统一 Plugin 测试入口、真实 runtime smoke 或 Kit assembly 测试，应单独更新命令契约和本指南，不能从当前构建、校验或 `validate` 命令推断这些能力已经存在。
- 另行处理 `kits/agent-chat/README.md` 缺失导致的 `kit-docs` 全量测试失败。

## 相关正式文档

- [测试指南](../../guides/testing.md)
- [开发工作流指南](../../guides/development-workflow.md)
- [插件与 Kit 开发指南](../../guides/developing-plugins-and-kits.md)
- [Task 需求快照](./task.md)
