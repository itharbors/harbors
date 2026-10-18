# ITHARBORS 知识库

这里集中记录 ITHARBORS 的设计思路、当前架构、关键运行流程和扩展方式。根目录
[README](../readme.md) 用于快速了解与启动项目；本知识库用于回答“系统为何这样设计”
以及“各模块如何协作”。

## 推荐阅读路径

### 第一次接触项目

1. [系统架构](./architecture/system-overview.md)：先建立进程、包和运行时模块的全局视图。
2. [核心原则](./architecture/core-principles.md)：理解架构边界与不变量。
3. [核心运行流程](./architecture/runtime-flows.md)：跟随会话、消息和窗口的端到端路径。
4. [Task 档案与生命周期](./tasks/README.md)：了解需求快照、阶段状态、收口总结与完成判定。
5. [自动化开发主流程](./architecture/automated-development-workflow.md)：了解任务定义、环境选择、
   执行计划、总结沉淀和交付门禁。
6. [决策反馈闭环](./guides/decision-feedback-loop.md)：从规划、角色反馈到决策增量沉淀和
   反向检索验证。
7. [开发工作流](./guides/development-workflow.md)：启动、构建、测试和排查项目。

### 维护框架

1. [Kit 与会话模型](./architecture/kit-and-session-model.md)
2. [插件运行时模型](./architecture/plugin-runtime-model.md)
3. [Kit 配置持久化模型](./architecture/kit-configuration-model.md)
4. [布局模型](./architecture/layout-model.md)
5. [UI 系统](./architecture/ui-system.md)
6. [架构决策记录](./decisions/README.md)

### 开发插件或 Kit

1. [插件运行时模型](./architecture/plugin-runtime-model.md)
2. [Kit 与会话模型](./architecture/kit-and-session-model.md)
3. [插件与 Kit 开发指南](./guides/developing-plugins-and-kits.md)
4. [开发工作流](./guides/development-workflow.md)
5. [自动化开发主流程](./architecture/automated-development-workflow.md)
6. [决策反馈闭环](./guides/decision-feedback-loop.md)
7. [测试指南](./guides/testing.md)
8. [Kit 制品打包](./guides/kit-artifacts.md)
9. 各 `kits/<name>/README.md`：对应功能单元自己的安装、构建、权限与平台契约。

## 文档地图

| 文档 | 回答的问题 |
| --- | --- |
| [核心原则](./architecture/core-principles.md) | 哪些设计约束应长期保持？ |
| [系统架构](./architecture/system-overview.md) | Gateway、Server、Client 和各 workspace 如何分工？ |
| [核心运行流程](./architecture/runtime-flows.md) | 启动、会话、消息、Kit 切换和打开面板时发生什么？ |
| [Kit 与会话模型](./architecture/kit-and-session-model.md) | 能力如何按 Kit 组合、按 session 隔离？ |
| [插件运行时模型](./architecture/plugin-runtime-model.md) | 插件如何发现、注册、装载、贡献能力和卸载？ |
| [Kit 配置持久化模型](./architecture/kit-configuration-model.md) | User、Kit、Plugin 的配置范围与 global 层如何绑定？ |
| [Agent Context Store](./architecture/agent-context-store.md) | Harness 如何在 User + Plugin 范围保存 Conversation 并装配 Context？ |
| [Model Service Plugin](./architecture/model-service-plugin.md) | 模型配置、凭据与请求 ACL 如何约束？ |
| [布局模型](./architecture/layout-model.md) | Window、Panel、Tab、Split 和实例状态如何表达？ |
| [UI 系统](./architecture/ui-system.md) | Web Components、主题与 iframe 如何协作？ |
| [Task 档案与生命周期](./tasks/README.md) | 可交付变更如何建档、推进、收口、确认完成与恢复？ |
| [自动化开发主流程](./architecture/automated-development-workflow.md) | 主 Agent 如何编排任务、环境、执行计划、总结和交付？ |
| [决策反馈闭环](./guides/decision-feedback-loop.md) | 如何在任务规划中消费决策、收集角色反馈、沉淀决策增量并验证下次可检索？ |
| [开发工作流](./guides/development-workflow.md) | 如何启动、构建、测试和定位常见问题？ |
| [测试指南](./guides/testing.md) | 如何按功能单元选择测试范围并完成验收？ |
| [插件与 Kit 开发指南](./guides/developing-plugins-and-kits.md) | 如何创建符合当前约定的插件与 Kit？ |
| [Kit 制品打包](./guides/kit-artifacts.md) | 如何校验、打包和检查本地 Kit 制品？ |
| `kits/<name>/README.md` | 某个 Kit 的能力、生命周期和所有权边界是什么？ |
| [文档维护指南](./guides/maintaining-docs.md) | 代码变化后应更新哪些文档，如何验证？ |
| [架构决策记录](./decisions/README.md) | 重要设计为何被采用，替代方案是什么？ |

## 文档职责

不同来源分别回答“应该怎样”和“当前怎样”，不能互相静默覆盖：

- 已接受 ADR 是决策约束的权威来源；`decisions/` 保留取舍上下文和历史，不随实现细节
  变化重写历史。决策的消费、反馈和沉淀按[决策反馈闭环](./guides/decision-feedback-loop.md)
  执行。
- 源码与测试是当前实现事实的权威来源，测试同时提供可复核的行为证据。
- `architecture/` 描述经验证的当前行为、边界和不变量，是实现事实与决策约束的正式
  投影；`guides/` 给出与两者一致的可执行步骤，不重复完整架构叙事。
- `tasks/` 保存需求、状态、来源和验证证据，不把未批准的角色反馈升级为长期决策。
- 外部 decision memory 只用于辅助发现可追溯的仓库来源，不能独立成为任务约束。
- `superpowers/` 保存说明体系本身的设计与实施计划，不面向普通使用者。

若源码或测试与已接受 ADR 冲突，必须显式升级并裁定是修正实现、批准例外还是新增 ADR；
不得用 architecture/guide 覆盖 ADR，也不得改写 ADR 来迎合未批准的当前实现。裁定后同步
更新相关正式投影和双向链接。

## 当前状态与适用范围

文档以当前 workspace 结构为准：

```text
packages/   Gateway、Server、Client 与共享插件类型
plugins/    框架内置插件
kits/       default、Harness 等 Kit 的独立目录
scripts/    Web 开发栈、Kit 发布与插件构建工具
```

仓库仍在演进。文档不会把尚未实现的设想写成当前能力，也不对未声明的 API 稳定性或
版本兼容作出承诺。发现偏差时请按[文档维护指南](./guides/maintaining-docs.md)核对源码入口。
