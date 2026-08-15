# 2026-08-15-extract-plugin-package

Task ID: `2026-08-15-extract-plugin-package`
Type: `refactor`

## 背景与问题

将当前内嵌在 `@itharbors/server` 的插件核心抽取为根 workspace 下的独立 npm 包
`packages/plugin`（包名 `@itharbors/plugin`）。Server 改为消费该包，不再持有重复的插件
注册、Manifest 校验、动态加载、生命周期和插件存储实现。

插件协议虽然已有 `@itharbors/plugin-types`，但负责 Manifest 校验、插件身份、状态机、入口动态
导入、生命周期编排和插件私有路径的 `PluginModule` 仍属于 Server 内部，无法由其他宿主作为 npm
依赖复用。

## 目标

- 让 `packages/plugin` 成为可构建、可打包、可由 Server 之外的 Node 宿主消费的插件核心包。
- 保持当前插件 Manifest、生命周期和宿主行为兼容。
- 让 Server 通过明确依赖使用插件核心，不再保存内部实现副本。

## 范围

- 新建可构建、可导出的 workspace 包 `packages/plugin`。
- 将插件 Manifest/身份类型、`Plugin`、`PluginModule`、definition load lock 和插件路径实现迁入该包。
- 通过宿主 runtime factory 解耦 Server 的 Editor/ApplicationRuntime 类型；包负责插件生命周期，宿主
  负责提供具体运行时能力及其可撤销资源。
- Server 依赖 `@itharbors/plugin`，所有生产代码和相关测试改从包入口导入。
- 更新架构与开发文档，明确核心包和 Server adapter 的边界。

## 非目标

- 不改变现有插件 Manifest 格式、Kit 插件选择方式或消息协议。
- 不把 Application 插件子进程、Session/Kit、Panel、Menu、Message 等宿主模块一并迁入核心包。
- 不发布到公共 npm registry，也不改变现有包版本或仓库发布流程。

## 验收标准

- `packages/plugin/package.json` 存在，包名为 `@itharbors/plugin`，提供公开根导出并能独立 build/typecheck/test。
- `packages/server/src/framework/plugin` 不再保存插件核心实现，Server 通过 workspace 依赖使用新包。
- 原有插件注册、校验、加载、卸载、owner 限制、凭据撤销和私有路径行为保持通过测试。
- 新包测试覆盖不依赖 Server 的独立消费路径。
- 插件构建校验及 Server 聚焦测试通过。

## 约束

- 遵循仓库 workspace、构建缓存和 Kit clean-checkout 构建顺序。
- 保持 Web 与 Electron 共享的 Server 插件行为不变。
- 不覆盖主 checkout 中与本需求无关的未跟踪运行数据。

## 需求变更

实现过程中没有缩减原始目标。为保证 npm 包真实可消费，额外把 Manifest schema 和插件凭据/
公共类型的权威实现一并迁入 `packages/plugin`，并保留 Kit Core、plugin-types 的兼容转发。
