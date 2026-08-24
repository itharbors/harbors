# 测试指南

本指南定义 Plugin、Kit 和 Framework 的测试所有权、启动边界、文件放置和当前命令语义。测试只使用 Web
宿主；UI、Kit 装配或共享可见行为需要浏览器验收时，必须在目标 Kit 的测试范围内完成。

## 所有权边界

| 层级 | 代码和测试位置 | 真实启动对象 | 允许模拟的边界 | 业务断言归属 |
| --- | --- | --- | --- | --- |
| Plugin 单元 / 组件 | 与 Plugin 源码并置 | 函数、状态机或组件 | 外部输入和局部依赖 | Plugin |
| Plugin runtime smoke | `plugins/<name>/tests/` 或 `kits/<kit>/plugins/<name>/tests/` | 一个真实 Plugin System 与一个真实 Plugin | Plugin 外部 request、broadcast 接收方和能力服务 | Plugin |
| Kit assembly | `kits/<kit>/tests/` | 一个真实 Kit 及其声明的全部 Plugin | Kit 外部服务，如凭据、模型/网络上游和宿主输入 | Kit |
| Web Host smoke | `kits/<kit>/tests/` 或 Kit 所属 smoke 入口 | Framework Web Host、真实 Kit、真实 Plugin 和浏览器 | Kit 外部服务与不稳定网络依赖 | Kit |
| Framework 工具 | `packages/*/tests/` 与 `scripts/lib/` | 通用 runtime、runner 或测试 fixture | 进程、端口、临时目录和健康响应 | Framework 工具自身，不含 Kit 业务 |

范围选择遵循功能边界：只改 Plugin 默认只验证该 Plugin；只改 Kit 根配置、布局或组合默认只验证目标 Kit；
只改 Framework 才运行受影响 Framework 测试；跨边界变更取受影响边界的并集。`pnpm run check` 是独立的全仓
最终门禁，不改变局部范围规则。

## 测试层级与启动契约

### Plugin 单元 / 组件测试

测试与源码并置，例如 `main/src/*.test.ts` 或 `panel.<name>/src/*.test.ts`。这一层不启动 Plugin runtime，
只验证纯函数、状态转换、消息处理和组件逻辑。现有测试保持原位，不为建立分层而批量移动。

### Plugin runtime smoke

需要验证运行时契约时，测试放在 Plugin 根目录 `tests/`，通过 `createPluginRuntimeHarness` 加载一个真实
Plugin。该 harness 由 `@itharbors/server/testing` 导出，负责真实 `PluginModule` 的 register/load/unload、
runtime message、临时路径和 dispose；测试不得直接构造 Framework 私有 `createEditor` 或替换被测 Plugin。

测试可以通过 harness 的 `externalRequests`、`externalBroadcasts`、`applicationRequest` 和 `credentials`
注入 Plugin 外的 request、broadcast 和能力 double。Plugin 自身的 lifecycle、handler、消息路由和清理仍是真实
实现。`MessageObserver` 的 `MessageTraceEvent.sequence`、`kind`、`caller`、`plugin`、`name`、`topic` 和
`args` 用于断言顺序、来源和 payload。

仓库没有根级统一的 `pnpm run test:plugin` 命令，但 Agent Chat Kit 已在自己的 package script 中声明
`test:plugin`，并通过真实 Conversation Plugin runtime smoke 验证 Plugin 外 request/broadcast。`ce-plugin build`
只构建 Plugin，`ce-plugin check` 只校验 manifest 和构建产物；它们都不会运行并置测试，也不等价于 runtime smoke。

### Kit assembly

Kit assembly 测试放在 `kits/<kit>/tests/`，通过 `createKitAssemblyHarness` 加载真实 Kit descriptor、布局和
全部声明 Plugin。该 harness 由 `@itharbors/server/testing` 导出，测试使用 `kit.load()`、`plugin.loaded()`、
`plugin.info()`、`plugin.call()`、`messages` 和 `observer` 观察真实装配。

Kit 测试可以通过 `externalRequests`、`externalBroadcasts`、`applicationRequest` 和 `credentials` 模拟 Kit
之外的服务，但不得 mock Plugin、Plugin System、MessageModule 或跨 Plugin 路由。Kit 测试不得 import
`packages/server/src/**`、`packages/server/tests/**` 等 Framework 私有源码，也不应直接操作 `createEditor`；
需要测试装配时使用公开 testing export 和 Kit-local fixture。

### Web Host smoke

完整 Web Host smoke 归目标 Kit，业务测试和浏览器断言放在 `kits/<kit>/tests/` 或目标 Kit 声明的 smoke 入口。
Framework 只提供 `scripts/lib/web-host-runner.mjs` 的通用进程生命周期：为 Gateway、Server、Client 分配隔离
端口，创建临时数据根，传入 Kit sources 和 default Kit，轮询 `/api/health`，收集有限日志，并在 finally 中按
逆序发送 SIGTERM、必要时 SIGKILL，最后删除临时目录。

runner 不知道 Chat、Panel、对话或任何具体 Kit 的业务语义；它不能包含 Kit 名称、业务 request、broadcast 或
页面断言。Kit-owned smoke wrapper 可以调用这个通用 runner，但不得 import `packages/server/src/**` 等 Framework
私有源码或直接操作 `createEditor`；wrapper 只负责把 runner 的公开生命周期结果转换为 Kit-owned 的公开 HTTP
断言。

Agent Chat 已声明 Kit-owned `smoke`，并已用真实 Gateway、Server、Client 通过公开 HTTP 验证 health、Kit catalog、
Kit 路径重定向和页面 HTML。该自动 smoke 不操作浏览器，也不等同于浏览器交互验收；浏览器验收另行确认 13/13
声明 Plugin 均加载且无 console error。Framework runner 的 contract 测试仍只验证通用进程、健康检查、隔离环境
和清理，不要将其写成 Kit 业务 smoke。

### Framework 测试

Framework 测试验证通用 runtime、消息路由、harness、Web Host runner、构建工具和脚本工具本身，仍放在
`packages/*/tests/` 或 `scripts/lib/`。Framework 测试不能因为使用 Agent Chat fixture 就取得 Agent Chat 业务
断言的所有权；fixture 只用于验证通用工具的接口和清理契约。

## 消息链路与顺序

测试必须记录触发方、接收方、消息类型和终点，不能只断言某个 mock 被调用。

### Plugin 层

1. harness 通过真实 Plugin System load 一个目标 Plugin。
2. 测试 actor 通过 `plugin.call()` 或 `messages.requestFrom()` 发起定向 request，进入目标 Plugin 的真实
   handler。
3. 目标 Plugin 需要外部服务时，通过真实 runtime request 到 harness 注册的 external request handler；返回值或
   错误再回到目标 Plugin。
4. 目标 Plugin 发出 broadcast 时，由真实 MessageModule 路由到 harness 注册的外部订阅或目标 Plugin 内订阅，
   observer 以递增 `sequence` 记录发送顺序。
5. 测试可用 `messages.broadcast()` 注入外部事件，验证真实 Plugin subscription；结束时先 unload，再 dispose，
   确认 listener、临时数据和后续消息均被清理。

### Kit 层

1. harness load Kit，真实 Framework 插件和 Kit 声明的全部 Plugin 依次注册。
2. 测试 actor 通过真实消息入口请求 Plugin A；Plugin A 再 request Plugin B 或 Kit 外部服务，外部服务只由
   harness double 响应。
3. Plugin B 的真实 broadcast 经过真实 MessageModule 路由到 Plugin C 或 Kit 外部订阅；observer 断言
   `request -> broadcast` 的顺序、owner/topic、request 参数和 broadcast payload。
4. 对成功、拒绝、错误、取消和重启场景，断言链路终点、错误传播、sequence/generation 关系和 dispose 结果。

### Agent Chat 链路记录

Agent Chat 的已落地 assembly 链路按以下顺序运行和记录；HTTP smoke 与浏览器验收仍是两个独立层级：

1. Chat/Conversation 面板 request `agent.createConversation` 或 `agent.sendMessage`。
2. Agent request `model-service.getCatalog` 或 `model-service.complete`；请求携带 request identity，流式请求还
   携带 generation。
3. Model Service 将 Provider 增量 broadcast 为 `model-service.complete.delta`；Agent 按 request identity、
   generation 和 sequence 接收，再 broadcast `agent.message.delta` 给 Chat。
4. Agent 持久化 trace 后 broadcast `agent.conversation.trace.append`；Chat 按 conversation、turn、item 和
   sequence 重建可见 transcript。
5. Agent broadcast `agent.message.status`，并以 `turn/end` 记录 completed、failed、cancelled、timed_out
   或 rejected 终态。
6. 审批回环为 Agent broadcast `approval/asked`，Chat request `agent.resolvePermissionRequest`，Agent 再
   broadcast `approval/resolved`；拒绝结果必须回到真实 turn 链路，而不是由测试 mock 伪造终态。

## 当前命令语义

| 命令 | 当前实现的作用 | 不应推导的结论 |
| --- | --- | --- |
| `pnpm --filter @itharbors/server exec vitest run tests/framework/testing-harness.test.ts` | 运行 Framework runtime harness contract tests | 不代表 Kit 业务 smoke 或浏览器交互已通过 |
| `node --test scripts/lib/web-host-runner.test.mjs` | 运行通用 Web Host runner 的进程、健康检查和清理测试 | 不代表某个 Kit 的 HTTP 或浏览器业务行为已通过 |
| `pnpm --dir kits/agent-chat run test:plugin` | 加载真实 Conversation Plugin，模拟 Plugin 外 request/broadcast 并验证 runtime smoke | 只覆盖 Conversation Plugin，不覆盖完整 Kit |
| `pnpm --dir kits/agent-chat run test:assembly` | 通过公开 testing harness 加载 Agent Chat 全部声明 Plugin，验证组合 request/broadcast 链路 | 不包含 Web Host 或浏览器交互 |
| `pnpm --dir kits/agent-chat run test:kit` | 依次执行 descriptor validate、`test:plugin` 和 `test:assembly` | 不自动执行 `smoke` |
| `pnpm --dir kits/agent-chat run smoke` | 启动真实 Gateway、Server、Client 并通过公开 HTTP 验证 health、catalog、redirect 和 HTML | 不执行浏览器点击或页面交互 |
| `pnpm run kits:test <slug>` | 构建 toolchain 和目标 Kit，再执行该 Kit 声明的 `test` script | 不自动执行未声明的 smoke |
| `pnpm run kits:check <slug>` | 对目标 Kit 执行 build、test、validate；若 descriptor 声明 `harbors.scripts.smoke`，再执行其 smoke；市场 Kit 还 pack/inspect | 不把 `check` 变成 Framework 或所有 Kit 的浏览器测试 |
| `pnpm --dir kits/<kit> run <declared-test-script>` | 直接运行 Kit 自己声明的 test script | 只证明该脚本覆盖的内容 |
| `pnpm run test:framework:prepared` | 运行已构建 Framework 的聚焦 package/script 测试集合 | 不替代 Kit assembly 或 Web smoke |
| `pnpm run check` | 全仓最终门禁，包含 Framework/workflow 测试和 Kit matrix check | 不改变局部变更的最小验证范围 |

`test` 是 Kit 声明的测试脚本；`smoke` 是可选的 Kit 声明脚本，只由适用的 `kits:check` 阶段调用；`check` 是
更宽的构建、测试、validate、可选 smoke 和制品检查编排。Agent Chat 的 `test:plugin`、`test:assembly`、
`test:kit` 和 `smoke` 都是 Kit-local 已声明脚本，不应推广成根级统一命令。自动 smoke 只验证公开 HTTP，不是
浏览器交互测试；浏览器验收单独记录。

## 测试发现与路径边界

- Vitest 运行根必须是目标 package，或显式给出目标测试文件；不得把仓库 `.worktrees/` 作为测试根或 include
  路径。任何从仓库根运行的 Vitest 配置都必须显式排除 `**/.worktrees/**`。
- 目标 Kit 的 assembly 命令应传入明确的 Kit 测试路径；Framework package 的测试使用 package-local root，避免
  发现其他 worktree 的同名测试。
- Kit 测试只能通过公开 testing contract 和 Kit-local fixture 访问 Framework；禁止 `../../../packages/server/src`
  或 `../../../packages/server/tests` 一类越界 import。
- 临时目录、端口、session 和外部服务 double 必须由测试拥有并在 `afterEach`/`finally` 清理，不得依赖家目录、
  共享进程或其他 worktree。

## 验证证据

Task 的 `summary.md` 或 `.work/` 应记录实际命令、退出码、测试所属边界和未覆盖风险。浏览器验收还要记录 Web
Host 启动方式、目标 Kit、访问页面、request/broadcast 操作和可见结果。局部验证与全仓 `pnpm run check` 分开
记录；Agent Chat 的 Plugin smoke、assembly、HTTP smoke 和浏览器验收应分别记录，不能用 Framework runner 测试
替代其中任何一项。Task 状态中的 `pullRequest: null` 在尚未选择 PR 或采用本地整合路径时是有效状态，不代表测试失败。

## 相关入口

- [开发工作流](./development-workflow.md)
- [Agent Chat Kit 装配与回归边界](../architecture/agent-chat-kit-assembly.md)
- [Server testing export](../../packages/server/src/testing.ts)
- [Kit matrix runner](../../scripts/run-kit-matrix.mjs)
- [Web Host runner](../../scripts/lib/web-host-runner.mjs)
