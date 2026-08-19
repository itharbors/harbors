# 测试指南

本指南说明 Plugin、Kit、Framework 三层的测试所有权、测试类型、文件放置和范围选择。
目标是按实际受影响的边界选择最小必要验证，同时不把当前尚未实现的命令或测试能力写成既成事实。

Web 是唯一宿主。涉及 UI、Kit 装配或共享可见行为时，按需使用 `pnpm run dev:web` 并在浏览器中验收；
不引入 Electron、桌面窗口、托盘、更新器或桌面 IPC 的测试假设。

## 所有权边界

| 层级 | 代码位置 | 测试所有权 | 默认验证范围 |
| --- | --- | --- | --- |
| Plugin | `plugins/<name>` 或 `kits/<kit>/plugins/<name>` | 该 Plugin | 只验证该 Plugin |
| Kit | `kits/<kit>`，包括 Kit 根配置、布局和跨 Plugin 装配 | 该 Kit | 只验证目标 Kit |
| Framework | `packages/*`、`scripts/*` 和根脚本 | 受影响的 Framework | 只运行受影响 Framework 测试 |

按以下规则判定范围：

- 只改一个 Plugin 的源码、资源或测试，默认只验证该 Plugin。
- 改 Kit 根配置、布局、Kit 级脚本或跨 Plugin 装配，默认只验证目标 Kit。
- 只有发生 Framework 变更时，才运行受影响 Framework 的测试；优先选择受影响 package 或脚本的聚焦测试。
- 跨边界变更取并集。例如同时改某个 Plugin 和 Framework，就运行该 Plugin 的验证与受影响 Framework 测试。
- Plugin 是最小业务单元。不要因为修改一个 Plugin 就默认运行 Framework 或全仓测试，也不要因为修改一个 Kit
  就默认验证所有 Kit。

这里的“默认范围”是局部开发和变更验收规则，不取代仓库现有的最终全仓门禁，详见[全仓门禁与局部范围的差异](#全仓门禁与局部范围的差异)。

## 测试层级

1. **Plugin 单元 / 组件测试**：覆盖单个 Plugin 的纯函数、状态转换、消息处理或 UI 组件逻辑，不依赖真实
   Plugin runtime。
2. **Plugin runtime smoke**：使用真实 Plugin runtime，验证 Plugin 能被装载、manifest 贡献点能注册、生命周期
   和关键消息链路能工作。它是独立的测试层级，不等同于 Plugin 构建或 manifest 校验。
3. **Kit assembly**：验证单个 Kit 的 descriptor、布局、多个 Plugin 的组合和跨 Plugin 消息链路。它覆盖多个
   Plugin，但仍只属于一个 Kit。
4. **Framework 测试**：覆盖 `packages/*` 的运行时、协议、构建工具，以及 `scripts/lib` 的工具逻辑。
5. **浏览器验收**：对 UI、Kit 装配或共享可见行为，在 Web 宿主中按需启动 `pnpm run dev:web`，然后通过浏览器
   验证用户可见结果。

当前仓库不能由构建或校验命令推导出 runtime smoke 或 Kit assembly 已经存在。新增这类测试时，必须按下节
约定放置，并在 Task 的验证记录中写明实际运行的测试命令。

## 文件放置

| 测试层级 | 放置位置 | 说明 |
| --- | --- | --- |
| Plugin 单元 / 组件测试 | 与源码并置，例如 `plugins/<name>/main/src/*.test.ts` 或 `kits/<kit>/plugins/<name>/panel.<name>/src/*.test.ts` | 现有测试保持原位，不移动 |
| Plugin runtime smoke | Plugin 根目录的 `tests/`，即 `plugins/<name>/tests/` 或 `kits/<kit>/plugins/<name>/tests/` | 仅用于需要真实 runtime 的 smoke 测试 |
| Kit assembly | `kits/<kit>/tests/` | 用于跨 Plugin 装配、布局和消息链路 |
| Framework 测试 | `packages/*/tests/` 与 `scripts/lib/` | Framework 运行时、协议、构建工具和脚本工具测试 |

现有 Plugin 单元 / 组件测试与源码并置，无需移动。当前没有统一的 `test:plugin` 入口，Plugin package 也基本
没有 `test` script；因此现有 `*.test.ts` 不会因 `ce-plugin build` 或 `ce-plugin check` 自动运行。当前仓库也
没有可据此笼统宣称已经具备 Kit assembly 测试；`kits/<kit>/tests/` 是该测试层级的约定放置位置。

## 范围选择

| 变更类型 | 最小必要验证 |
| --- | --- |
| 单个 Plugin 内部逻辑 | 该 Plugin 已有的单元 / 组件测试；若变更触及 runtime 契约，再加跑该 Plugin 已有或新增的 smoke 测试 |
| Kit 根配置、布局、Kit 级脚本或跨 Plugin 装配 | 只运行目标 Kit 的 Kit 测试流程与校验；若已有 Kit assembly 测试，则在该 Kit 范围内运行 |
| Framework package 或 `scripts/lib` 脚本 | 受影响 Framework package 或脚本的测试；不要把所有 Framework 测试当作局部变更的默认要求 |
| 跨边界变更 | 上述各受影响边界的验证范围取并集 |

Kit 测试流程的具体现状如下：

- 当前 `kits/agent-chat/package.json` 与 `kits/default/package.json` 的 `test:kit` 都是 `validate`，它们校验 Kit
  descriptor / manifest，不应被描述为 Kit assembly 测试。
- `pnpm run kits:test <slug>` 会先构建所需 Framework toolchain，再构建选中的 Kit，随后执行该 Kit 声明的
  `test` script；对上述两个内置 Kit，这个脚本最终就是 `test:kit`，即 `validate`。这个命令不能笼统地宣称仓库
  已有 Kit assembly 测试。
- 不虚构 `test:plugin`、`test:kit assembly` 或其他未在根 `package.json` / 目标 package 中声明的命令。

## 当前命令边界

下表只列当前仓库已有且与本指南相关的命令。命令的运行结果才是验证证据；命令名称本身不代表测试层级已经实现。

| 命令 | 当前作用 | 适用边界 |
| --- | --- | --- |
| `pnpm run dev:web` | 启动 Web 开发栈，供浏览器验收 | UI、Kit 装配和共享可见行为 |
| `pnpm --filter @itharbors/<pkg> run test` | 运行一个 Framework package 的 `test` script | 受影响 Framework package |
| `node --test scripts/lib/<file>.test.mjs` | 运行一个 Framework 脚本工具测试文件 | 受影响 `scripts/lib` |
| `pnpm run test:framework` | 构建 toolchain 后运行仓库定义的 Framework 测试集合 | Framework 变更需要更宽覆盖时；不是 Plugin 局部变更的默认命令 |
| `pnpm run kits:test <slug>` | 先构建，再执行目标 Kit 声明的 `test` script | 目标 Kit；当前内置 Kit 的脚本为 `validate` |
| `pnpm run kits:check <slug>` | 对目标 Kit 执行 build、test、validate，以及适用的制品检查 | 目标 Kit 的完整检查 |
| `node scripts/ce-plugin.mjs build <plugin-dir>` | 构建单个 Plugin | 目标 Plugin 的构建验证 |
| `node scripts/ce-plugin.mjs check <plugin-dir>` | 校验单个 Plugin 的 manifest 与构建产物 | 目标 Plugin 的产物验证 |
| `pnpm run check` | 全仓最终门禁：构建、Framework / workflow 测试、所有 Kit 检查和 Framework Plugin 检查 | 提交或收口所需的全仓门禁 |

`ce-plugin build` 和 `ce-plugin check` 只是构建及 manifest / 产物校验，不是 Plugin runtime smoke，也不会自动
运行并置的 `*.test.ts`。当前没有统一的 `pnpm run test:plugin` 命令；Plugin package 基本没有 test script，
所以应根据目标 Plugin 实际存在的测试入口记录验证结果，不能编造统一入口。

## 全仓门禁与局部范围的差异

局部范围规则和仓库最终门禁是两件事：前者回答“这次变更日常应验证什么”，后者回答“现有收口流程最终还会
检查什么”。当前 `pnpm run check` 仍是全仓门禁。`finish-change.sh` 的收口流程当前也会调用根 `npm run check`，
因此 finish 仍会触发这套全仓检查。

这项现状不应被冒充为局部测试要求：只改 Plugin 时，局部规则仍然是只验证该 Plugin；只改目标 Kit 时，局部规则
仍然是只验证目标 Kit；只有 Framework 变更才按受影响 Framework 范围加测。若实际执行了 `pnpm run check` 或
finish 流程，应在 Task 的 summary / `.work/` 中把它记录为独立的全仓门禁证据，并同时记录局部验证证据。

## 验证证据

每次验证都应在 Task 的 `summary.md` 或 `.work/` 过程材料中记录：

- 从仓库根目录执行的完整命令和退出码，或明确的通过 / 失败结论；
- 测试所属边界（Plugin、Kit 或 Framework）及选择该范围的原因；
- 若使用浏览器验收，记录 `pnpm run dev:web`、访问的 Kit / 页面、操作步骤和观察到的可见行为；
- 若执行了全仓 `pnpm run check` 或 finish 收口门禁，明确标记它是独立的全仓门禁，不把它改写成局部测试结论；
- 若因端口、权限或其他环境限制跳过某项，记录原因和未覆盖的风险。

不要只写“测试通过”而不给出命令。跨环境交接时，验证证据必须可复现。

## 源码索引

- [根脚本](../../package.json)
- [Kit 矩阵运行器](../../scripts/run-kit-matrix.mjs)
- [Plugin 构建与校验](../../scripts/ce-plugin.mjs)
- [Kit CLI](../../packages/kit-cli/src/cli.ts)
- [Server 测试入口](../../packages/server/src/testing.ts)
