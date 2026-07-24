# ITHARBORS 知识库

这里集中记录 ITHARBORS 的设计思路、当前架构、关键运行流程和扩展方式。根目录
[README](../readme.md) 用于快速了解与启动项目；本知识库用于回答“系统为何这样设计”
以及“各模块如何协作”。

## 主程序发布

主程序发布以 `app/v<semver>` 触发，使用 **Developer ID Application** 签名并由
`app-publish-v1` 工作流执行。请从[主程序构建、发布与验收](guides/app-releases.md)了解本地结构验收、
精确确认、Preview/Stable 环境、凭据边界和不可变 Release 恢复。

## 推荐阅读路径

### 第一次接触项目

1. [系统架构](./architecture/system-overview.md)：先建立进程、包和运行时模块的全局视图。
2. [核心原则](./architecture/core-principles.md)：理解架构边界与不变量。
3. [核心运行流程](./architecture/runtime-flows.md)：跟随会话、消息和窗口的端到端路径。
4. [开发工作流](./guides/development-workflow.md)：启动、构建、测试和排查项目。

### 维护框架

1. [Kit 与会话模型](./architecture/kit-and-session-model.md)
2. [插件运行时模型](./architecture/plugin-runtime-model.md)
3. [布局模型](./architecture/layout-model.md)
4. [UI 系统](./architecture/ui-system.md)
5. [架构决策记录](./decisions/README.md)

### 开发插件或 Kit

1. [插件运行时模型](./architecture/plugin-runtime-model.md)
2. [Kit 与会话模型](./architecture/kit-and-session-model.md)
3. [插件与 Kit 开发指南](./guides/developing-plugins-and-kits.md)
4. [开发工作流](./guides/development-workflow.md)
5. [Kit 制品与本地安装](./guides/kit-artifacts.md)

## 文档地图

| 文档 | 回答的问题 |
| --- | --- |
| [核心原则](./architecture/core-principles.md) | 哪些设计约束应长期保持？ |
| [系统架构](./architecture/system-overview.md) | Gateway、Server、Client、Electron 和各 workspace 如何分工？ |
| [核心运行流程](./architecture/runtime-flows.md) | 启动、会话、消息、Kit 切换和打开面板时发生什么？ |
| [Kit 与会话模型](./architecture/kit-and-session-model.md) | 能力如何按 Kit 组合、按 session 隔离？ |
| [插件运行时模型](./architecture/plugin-runtime-model.md) | 插件如何发现、注册、装载、贡献能力和卸载？ |
| [布局模型](./architecture/layout-model.md) | Window、Panel、Tab、Split 和实例状态如何表达？ |
| [UI 系统](./architecture/ui-system.md) | Web Components、主题、iframe 与 Electron 如何协作？ |
| [开发工作流](./guides/development-workflow.md) | 如何启动、构建、测试和定位常见问题？ |
| [插件与 Kit 开发指南](./guides/developing-plugins-and-kits.md) | 如何创建符合当前约定的插件与 Kit？ |
| [Kit 制品、Registry 与本地安装](./guides/kit-artifacts.md) | 如何校验、发现、下载和事务安装 Kit 制品？ |
| [文档维护指南](./guides/maintaining-docs.md) | 代码变化后应更新哪些文档，如何验证？ |
| [架构决策记录](./decisions/README.md) | 重要设计为何被采用，替代方案是什么？ |

## 文档职责

- `architecture/` 描述当前代码已经实现的行为、边界和不变量。源码与文档冲突时，
  先以源码为事实并修正文档；如果源码本身违背已接受的设计决策，再单独讨论代码修改。
- `guides/` 以任务为中心，给出可执行步骤和检查方式，不重复完整架构叙事。
- `decisions/` 保存重要取舍。ADR 记录作出决策时的上下文，不随着实现细节变化而重写历史。
- `superpowers/` 保存说明体系本身的设计与实施计划，不面向普通使用者。

## 当前状态与适用范围

文档以当前 workspace 结构为准：

```text
packages/   Gateway、Server、Client 与共享插件类型
plugins/    框架内置插件
kits/       可选择的产品能力集合
scripts/    开发栈、Electron 与插件构建工具
```

仓库仍在演进。文档不会把尚未实现的设想写成当前能力，也不对未声明的 API 稳定性或
版本兼容作出承诺。发现偏差时请按[文档维护指南](./guides/maintaining-docs.md)核对源码入口。
