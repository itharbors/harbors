# Harbors 仓库说明

## 文档规范
- 文档默认使用中文。

## 开发验证
- 按功能单元选择局部验证：Plugin 变更验证目标 Plugin，Kit 变更验证目标 Kit，Framework 变更验证 Framework；跨边界变更取并集。
- Harbors 仅支持一个 Web 宿主。不要在 Framework 或 Kit 代码中加入 Electron、桌面打包、原生窗口生命周期、托盘、更新器或桌面 IPC 相关的假设。
- 服务端变更运行对应的针对性测试；UI、Kit 装配或共享可见行为必须使用 Web 浏览器验收。
- 详细测试规则见 [测试指南](docs/guides/testing.md)。

## 模块开发边界
- Kit 是装配包。开发一个 Kit 时，应在其文件夹内独立闭环完成；若需要改动超出该文件夹范围，大概率存在问题，需先询问用户。
- Plugin 是独立的业务单元。开发 Plugin 时，不应修改其文件夹之外的代码；若需要改动超出该文件夹范围，大概率存在问题，需先询问用户。

## 插件开发
插件开发的核心文档入口：
- 开发指南：`docs/guides/developing-plugins-and-kits.md`
- 插件运行时模型：`docs/architecture/plugin-runtime-model.md`
- 核心原则：`docs/architecture/core-principles.md`
- Kit 与会话模型：`docs/architecture/kit-and-session-model.md`
- 开发工作流：`docs/guides/development-workflow.md`

关键开发约束：
- 框架插件位于 `plugins/<name>`，Kit 专属插件位于 `kits/<kit>/plugins/<name>`。
- 插件之间通过 request/broadcast 消息交互。
- 仅支持 Web 宿主，不加入 Electron 或桌面宿主假设。

## 任务编排
- 排任务时可以以 Plugin 为单元，先定义各 Plugin 之间交互的协议，再分派给 Agent 实现。

## 消息交互约定
- 插件交互和业务交互统一通过消息完成，消息分为广播（通知）和定向请求两种。
- 讨论业务方案时，应明确消息通知的顺序和完整链路，包括触发方、接收方，以及哪些环节使用广播、哪些环节使用定向请求。

## 提交信息
请严格使用以下标题格式之一：
- `[Init] 摘要` — 仅用于仓库初始化。
- `[Feature] 摘要` — 新功能及其配套的测试或文档。
- `[Bug] 摘要` — 缺陷和回归修复。
- `[Docs] 摘要` — 独立的文档变更。
- `[Refactor] 摘要` — 不改变预期行为的结构与可维护性改进。
- `[Optimize] 摘要` — 性能和资源使用优化。
- `[Test] 摘要` — 独立的测试变更。
- `[Chore] 摘要` — 依赖、构建工具和日常维护。

请保持标签大小写完全一致，撰写简洁的中文摘要且末尾不加句号，每次提交聚焦于一项可评审的变更。完整约定参见 `docs/guides/development-workflow.md`。
