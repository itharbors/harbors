# 2026-08-23-layered-testing 交付摘要

## 最终结论

Harbors 的 Plugin、Kit assembly、Web Host smoke 与 Framework 测试工具已经形成可执行的分层模型，并以 Agent Chat 完成代表性落地。Plugin 测试只加载一个真实 Plugin，Kit 测试加载真实 Kit 及其全部 Plugin，完整 Web Host smoke 归属 Kit，Framework 只提供通用 harness、runner、观察和清理能力。全仓 `pnpm run check` 最终退出码为 0。

## 需求完成情况

- Plugin runtime smoke 已落在所属 Plugin 目录，使用真实 Plugin System 和真实目标 Plugin，只模拟 Plugin 外 request、broadcast 接收方与能力服务。
- Kit assembly 已落在 `kits/agent-chat/tests/`，使用真实 Kit descriptor、布局与全部声明 Plugin，只模拟 Kit 外部服务，并覆盖真实跨 Plugin 消息链路及清理。
- 完整 Web Host smoke 归属 Agent Chat Kit，使用真实 Web Host、Kit 与 Plugin；Framework 公共层不包含 Agent Chat 业务断言。
- 已补齐 Agent Chat README，移除 assembly 测试对 Server 源码和测试内部路径的越界依赖，并隔离 `.worktrees` 测试发现。
- 已提供公开 runtime testing harness、Web Host runner、Kit matrix 和 Kit 依赖快照能力，并将对应规则固化到正式测试与开发文档。
- 实现、验证和 consolidation 均通过 Task CLI 推进；本地收口未 push、未创建 PR、未整合到本地 `main`。

## 主要改动

- Server testing API 新增 Plugin runtime 与 Kit assembly harness，复用真实 PluginModule、MessageModule 与生命周期，并提供外部边界 adapter 和消息观察能力。
- 脚本公共层新增可动态分配端口、等待就绪、收集日志并完整终止进程组的 Web Host runner，以及 Agent Chat/Default Kit matrix 执行入口。
- Agent Chat 新增 Conversation Plugin runtime smoke、Kit assembly、HTTP Web Host smoke、Kit 级 Vitest 配置与测试脚本；README 记录分层测试入口。
- Kit 安装快照改为复制 Framework package 的依赖闭包并安全处理软链接，使隔离后的 Kit 检查能够真实构建和测试。
- 测试指南、开发工作流与 Agent Chat assembly 架构文档同步记录分层所有权、mock 边界、消息链路和浏览器验收要求。
- 全量门禁暴露的既有基线同步收口：补齐 Host Security、Kit Core、Kit CLI 的测试依赖；修复 Server runtime registry 的多 runtime 清理、Config host broadcast 可见性与 Editor 广播测试；更新 Client runtime ID 断言；修正 build-clean workspace fixture；补齐 Default Message Debug 的 `timestamp` 类型。

## 关键决定

- Plugin 层证明单插件运行时契约，不加载完整 Kit，也不 mock 被测 Plugin、Plugin System 或真实消息模块。
- Kit 层证明真实组合，加载 Kit 声明的全部真实 Plugin；只在凭据、模型、网络和宿主外部输入等 Kit 外边界使用确定性 double。
- Web Host smoke 是具体 Kit 的用户可见验收，因此断言与测试文件留在 Kit；Framework 只拥有可复用的进程、端口、就绪、日志、页面观察和清理机制。
- Plugin 交互继续通过真实定向 request 与 broadcast 完成；测试按触发方、接收方、topic、payload、顺序、错误传播及生命周期清理进行断言。
- Web 是唯一宿主；实现和测试未引入 Electron、桌面打包、原生窗口、托盘、更新器或桌面 IPC 假设。
- 全量门禁中发现的稳定基线失败作为本 Task 验收阻断项一并修复，但不据此声称仓库不存在未被当前门禁覆盖的其他问题。

## 验证结果

- 全仓 `pnpm run check`：退出码 0。
- Server：61 个测试文件、748 个测试全部通过。
- Client：33 个测试文件、286 个测试全部通过。
- Kit Core：106 个测试全部通过；Kit CLI：61 个测试全部通过。
- 根脚本测试：91 个测试全部通过。
- workflow、Kit docs 与边界检查：全部通过。
- Kit matrix：`agent-chat STATUS=passed`，`default STATUS=passed`；Framework Plugins 检查通过。
- Agent Chat Plugin runtime smoke：1/1 通过；Kit assembly：6/6 通过；`test:kit` 与 HTTP Web Host smoke 均通过。
- 浏览器实际验收：真实打开 Agent Chat Web Host，13/13 Panel 加载完成，浏览器日志没有 warn/error；关闭后确认相关进程和端口已清理。
- `git diff --check main...HEAD`：通过。

## 影响与风险

- 测试所有权和启动层级更明确，Plugin 与 Kit 可以在所属目录独立验证，完整 Web 行为也有真实 Host 验收入口。
- Web Host runner 会创建动态端口、临时根目录与子进程组；当前已有 finally 清理、TERM/KILL 兜底和残留确认测试，但后续修改进程管理时仍需保持跨平台行为可验证。
- Kit 依赖快照复制 Framework package 的依赖闭包，提升隔离构建真实性，也会增加 Kit 检查的临时文件量和执行时间；验证缓存不属于交付物。
- Server runtime registry/config broadcast 等基线修复涉及共享运行时行为，已由完整 Server、Client、Kit 与全仓门禁覆盖，但后续扩展多 runtime 会话时仍应维持 runtime ID 隔离和会话级完整清理。
- 当前结论仅代表本分支改动及现有自动化、浏览器验收范围通过，不代表全仓未来或门禁未覆盖路径不存在其他缺陷。

## 偏差与遗留

- 初始 Task 计划先完成需求与设计、再进入实现；用户随后确认“一次搞完”，实际在同一 Task 中完成了实现、验证和 consolidation，Task 文档已按最终范围更新。
- 原始范围主要聚焦分层测试。为使全量门禁真实通过，额外收口了测试依赖、Server runtime/config、Client runtime 断言、build-clean fixture 和 Default Message Debug 类型等既有基线问题。
- 未连接真实模型服务、用户凭据或不稳定网络上游；这些仍按设计由 Kit 外部确定性 double 代替。
- 未 push、未创建或更新 PR、未整合到本地 `main`；这些不是本地收口的自动动作。

## 后续关注

- 新增 Plugin 测试时继续将 runtime smoke 放在所属 Plugin 目录，并显式列出外部 request、broadcast 与能力 double。
- 新增 Kit 时在 Kit 目录维护 assembly 与真实 Web Host smoke，不把 Kit 业务断言下沉到 Framework。
- 后续扩展 Web Host runner 时持续验证异常启动、超时、强制终止、端口释放和临时目录清理。
- 若要验证真实模型或其他外部服务，应单独定义受控的集成环境、凭据策略和失败隔离，不扩大默认测试的不可控依赖。

## 相关正式文档

- [测试指南](../../guides/testing.md)
- [开发工作流](../../guides/development-workflow.md)
- [Agent Chat Kit assembly 架构](../../architecture/agent-chat-kit-assembly.md)
- [Agent Chat Kit README](../../../kits/agent-chat/README.md)
- [Task 需求与设计](task.md)
- [Task 状态](status.json)
