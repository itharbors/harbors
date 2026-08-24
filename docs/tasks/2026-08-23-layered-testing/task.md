# 2026-08-23-layered-testing

Task ID: `2026-08-23-layered-testing`
Type: `feature`

## 背景与问题

Harbors 目前已经有 Plugin、Kit 和 Framework 相关测试，但测试启动边界和所有权没有形成一条可执行的分层规则：

- Plugin 测试需要验证真实 Plugin System 的加载、运行时消息和能力调用，却不能因为测试方便而加载完整 Kit 或把 Plugin 内部实现全部 mock 掉。
- Kit assembly 测试需要验证真实 Kit 的完整 Plugin 装配和跨 Plugin 消息链路，却不能把被测 Plugin 替换成 mock；只应模拟 Kit 之外的服务边界。
- 完整 Web Host smoke 属于具体 Kit 的可见业务行为，若放进 Framework 会让 Framework 反向拥有某个 Kit 的业务断言，也会混淆 Web Host 通用生命周期工具和产品验收。
- `kits/agent-chat/tests/assembly.test.ts` 当前有三个越过 Kit 目录边界的相对路径 import，测试运行时可能从仓库根目录重复发现 `.worktrees` 中的测试；`kits/agent-chat/README.md` 缺失还会导致 Kit 文档契约检查失败。

本 Task 一次完成测试分层的设计、实现、验证与收口，锁定目录、启动层级、mock 边界、消息链路和验收证据，并补齐 Agent Chat 的代表性分层测试与通用测试基础设施。

## 目标

- Plugin 测试归属 Plugin 目录：加载一个真实 Plugin 及真实 Plugin System，模拟 Plugin 外部的 request、broadcast 接收方和能力服务，验证运行时行为及清理。
- Kit assembly 测试归属 `kits/<kit>/tests/`：加载真实 Kit 声明的全部 Plugin，只模拟 Kit 外部服务，验证装配、注册、跨 Plugin request/broadcast 和生命周期。
- 完整 Web Host smoke 归属目标 Kit：使用真实 Web Host、真实 Kit 和真实 Plugin，验证浏览器可见链路；Framework 只提供通用启动、观察和清理工具。
- 修复 agent-chat 缺失 README、assembly 测试三个越界 import 以及 Vitest 扫描 `.worktrees` 的问题，并使局部验证命令可重复执行。

## 范围

- Plugin 测试层：`kits/<kit>/plugins/<plugin>/tests/` 或框架 Plugin 对应的 Plugin 目录 `tests/`，覆盖真实单 Plugin runtime smoke；已有源码并置的单元/组件测试继续由所属 Plugin 维护。
- Kit assembly 层：`kits/<kit>/tests/`，覆盖目标 Kit descriptor、布局、全部声明 Plugin 的真实加载、Plugin 注册、跨 Plugin 消息和关闭清理。
- Web Host smoke 层：仍放在 `kits/<kit>/tests/` 或其 Kit 目录下的明确子目录，使用真实 Web Host 和浏览器观察目标 Kit 的可见行为；测试不得迁移到 Framework 目录。
- Framework 测试工具层：在 Framework 现有测试目录验证通用 host 启动、就绪观察、日志/页面观察和资源清理工具；工具不包含 agent-chat 或其他 Kit 的业务断言。
- agent-chat 维护项：补齐 `kits/agent-chat/README.md`；将 `kits/agent-chat/tests/assembly.test.ts` 的三个越界 import 收敛到受支持的测试 API 或 Kit 目录内 fixture，不再直接依赖 `packages/server/src` 和 `packages/server/tests` 的内部路径。
- Vitest 发现边界：为从仓库根目录启动的 Vitest 配置排除 `**/.worktrees/**`，保证 worktree 中的测试不会被宿主仓库重复扫描或执行。
- 通用测试基础设施：提供公开的 Plugin runtime/Kit assembly testing API、Web Host runner、Kit matrix 与依赖快照能力；具体业务断言仍留在所属 Plugin 或 Kit。
- 门禁基线收口：修复全量验证过程中暴露且可在本分支稳定复现的依赖、Server runtime/config、Client runtime 断言、构建清理 fixture 和 Default Message Debug 类型问题，使新增分层测试能够通过全仓门禁验收。

## 非目标

- 不把完整 Kit、真实 Web Host 或具体业务流程放入 Framework 测试；Framework 不拥有 agent-chat 的 request/broadcast 断言。
- 不在 Plugin 层加载完整 Kit，不在 Kit 层替换被测 Plugin 为 mock，也不通过 mock 绕过 Plugin System、消息路由或生命周期。
- 不连接真实模型服务、网络上游、用户凭据或其他不可控外部服务；外部服务只提供确定性的测试 double。
- 不引入 Electron、桌面打包、原生窗口生命周期、托盘、更新器或桌面 IPC；Web 是唯一宿主。
- 不改变生产消息协议、Plugin 能力授权语义或 Kit 产品行为；本 Task 的业务变化限于测试装配与测试基础设施。
- 不把 `pnpm run check` 的全仓门禁替代为分层测试，也不声称新增测试脚本已经存在；各层必须记录实际可运行命令和证据。
- 不手写 `status.json` 字段，不修改状态 schema；状态只通过 Task CLI 推进。
- 本地收口不包含 push、创建 PR 或整合到本地 `main`；这些动作仍需用户按工作流另行明确授权。

## 启动层级与所有权

| 层级 | 启动对象 | 真实内容 | 允许模拟的边界 | 测试归属 |
| --- | --- | --- | --- | --- |
| Plugin runtime smoke | 最小 Plugin System/session 与一个目标 Plugin | 目标 Plugin、Plugin runtime、消息注册和生命周期 | Plugin 外部 request/broadcast 接收方、能力适配器、不可控上游 | Plugin 目录 `tests/` |
| Kit assembly | Framework assembly 与一个目标 Kit | Kit descriptor、Kit 声明的全部 Plugin、Plugin System、跨 Plugin 路由和清理 | Kit 之外的服务，如凭据、模型/网络上游和宿主外部输入 | `kits/<kit>/tests/` |
| Web Host smoke | 通用 Web Host 启动器、浏览器和一个目标 Kit | Web Host、真实 Kit、全部真实 Plugin、Panel/页面和可见消息链路 | Kit 外部服务与不稳定网络依赖 | `kits/<kit>/tests/` |
| Framework 工具测试 | 独立的 host fixture | 通用启动、就绪探测、观察器、超时和清理逻辑 | fixture 的进程/端口/页面，不带具体 Kit 业务语义 | `packages/*/tests/` 或 `scripts/lib/` |

每层只对其启动对象负责：Plugin 层证明单插件运行时契约，Kit 层证明真实组合，Web 层证明用户可见结果，Framework 层证明测试工具本身。跨边界变更取所有受影响层级的并集。

## 消息链路

### Plugin runtime smoke

1. 测试 harness 启动最小 Plugin System，并加载一个真实目标 Plugin。
2. harness 通过 Plugin System 定向 request 调用目标 Plugin 的公开 handler；目标 Plugin 内部通过 runtime request 调用 Plugin 外部服务时，由测试提供确定性 request adapter 并返回可断言结果。
3. 目标 Plugin 通过 runtime broadcast 发出事件时，测试 harness 记录 topic、payload 和顺序，并可注入来自 Plugin 外部的 broadcast 验证订阅处理；不替换目标 Plugin 的 message module。
4. 目标 Plugin 请求能力时，能力 adapter 返回成功、拒绝或错误等明确结果；测试断言能力调用及错误传播，而不实现真实凭据、网络或系统能力。
5. 测试结束按 runtime 的卸载/清理顺序关闭订阅、请求和临时资源，确保后续测试不会收到残留消息。

### Kit assembly

1. Kit test harness 启动真实 assembly，加载目标 Kit 的 descriptor、布局和全部声明 Plugin。
2. harness 只在 Kit 外部注入凭据、模型/网络服务和宿主输入的 mock；Plugin System、Plugin handler、Plugin 间 request 和 broadcast 均使用真实实现。
3. 测试通过真实入口发起 request，验证例如 `agent -> conversation/model-service` 的定向调用；再验证 Plugin 发出的 broadcast 被真实订阅方（例如 `agent -> chat`）按 topic、payload 和顺序接收。
4. 对成功、拒绝、异常、取消和重启等场景，断言消息链路的终点、错误传播和清理结果，而不是只断言某个 mock 被调用。
5. assembly 关闭时验证 Kit 级资源和所有 Plugin listener 被释放，下一次 assembly 不受上一会话状态影响。

### Web Host smoke

1. Kit 所属 smoke 使用 Framework 提供的通用启动器启动 Web Host，并选择目标 Kit；启动器只负责端口、就绪探测、日志采集和 finally 清理。
2. 浏览器打开真实 Web Host 页面，页面通过真实 Panel/transport 发起 request；服务端真实 Kit Plugin 处理请求，必要的外部模型或网络响应由 Kit 测试 double 提供。
3. Plugin broadcast 经真实 server/client 路由到页面，测试观察可见状态、Panel 内容和错误提示，确认用户可见结果与消息顺序一致。
4. smoke 结束由通用工具关闭浏览器、Web Host 和临时目录；业务断言（Kit 名称、Panel、对话内容等）全部留在 Kit 测试文件中。

## 验收标准

- `task.md` 完整记录背景、目标、范围、非目标、启动层级、消息链路、约束和可执行验收；内容使用中文且没有模糊占位语句。
- Plugin 测试落在所属 Plugin 目录，至少能以真实 Plugin System 加载单个真实 Plugin，并覆盖外部 request、broadcast 和能力 double；测试不加载完整 Kit、不 mock 被测 Plugin 内部。
- Kit assembly 测试落在目标 Kit 目录，加载真实 Kit 的全部声明 Plugin，覆盖 descriptor/布局、注册、跨 Plugin request/broadcast、异常/取消和清理；只模拟 Kit 外服务。
- 完整 Web Host smoke 归属 Kit，使用真实 Web Host、真实 Kit 和浏览器观察可见行为；Framework 只提供可复用的启动、观察和清理工具，不含具体 Kit 业务断言。
- `kits/agent-chat/README.md` 存在且能通过 Kit 文档契约检查；`assembly.test.ts` 不再包含三个越过 Kit 边界的相对路径 import，改用受支持的测试入口或 Kit-local fixture。
- 从仓库根目录运行相关 Vitest 时不会扫描或执行 `**/.worktrees/**` 中的测试；agent-chat assembly 的目标命令只发现一次目标文件。
- 目标 Plugin 测试、目标 Kit assembly 测试、Web smoke（具备浏览器条件时）和受影响 Framework 工具测试均按实际变更边界执行并记录退出结果；跨边界变更取并集，全仓 `pnpm run check` 仍作为独立门禁记录。
- `pnpm run task:status -- start/complete` 只用于合法推进阶段；实现、验证和 consolidation 全部达到终态，`status.json` 只含 CLI 管理的 schema 字段，ready-for-pr gate 与 `git diff --check` 均通过。
- 全仓 `pnpm run check` 退出码为 0；Agent Chat 和 Default Kit matrix 均通过，Framework Plugin 检查通过。
- 浏览器实际打开 Agent Chat Web Host，13/13 Panel 加载完成且没有 warn/error；退出后 Web Host 相关进程和端口均已清理。

## 约束

- Web 是唯一宿主。不得在 Framework、Kit 或测试工具中加入 Electron、桌面窗口、原生 IPC 或系统级生命周期假设。
- 测试所有权随功能边界：Plugin 测试留在 Plugin，Kit 组合和完整 Web smoke 留在 Kit，Framework 只维护通用测试工具；跨边界变更取并集。
- 外部服务 double 必须显式列出 request、broadcast、能力和网络边界，返回值、错误和延迟可控；不得因测试便利而 mock 被测 Plugin、Plugin System 或真实消息路由。
- 测试使用临时目录、端口和会话，并在 `afterEach`/`finally` 中清理；禁止依赖用户家目录、共享进程或其他 worktree 的文件。
- Vitest 的排除规则必须覆盖 `.worktrees`，且不能通过扩大 include 扫描仓库外部路径；路径修复应保持现有目标 Kit 命令兼容。
- `assembly.test.ts` 只能依赖公开的 Framework/Server testing API 或 Kit-local fixture；不得继续引用 `packages/server/src`、`packages/server/tests` 的内部相对路径。
- 实现按 Plugin、Kit、Framework 所有权落位；Plugin 或 Kit 的业务测试不越过所属目录修改其他业务单元，跨边界通用能力只进入 Framework/脚本公共层。
- 收口阶段提交当前分支内已验收改动，但不 push、不创建 PR、不整合到本地 `main`；后续动作依工作流另行确认。

## 需求变更

- 用户确认一次完成测试分层：Plugin 测试归 Plugin 目录；真实 Plugin System 加载单插件并模拟 Plugin 外 request/broadcast/能力；Kit 组合测试归 Kit 目录并加载真实 Kit 全部 Plugin，只模拟 Kit 外服务；完整 Web Host smoke 也归 Kit；Framework 只提供通用启动、观察、清理工具。
- 用户同时确认纳入本 Task 的维护项：补齐 agent-chat README、修复 `assembly.test.ts` 三个越界 import，并阻止 Vitest 扫描 `.worktrees`。
- 用户进一步确认“一次搞完”，因此同一 Task 内完成实现、全量验证和交付收口；全量门禁中暴露且阻断验收的既有基线问题也在不改变上述分层所有权的前提下同步修复。
