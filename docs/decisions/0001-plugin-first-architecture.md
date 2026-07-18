# ADR 0001：插件优先、由 Kit 组合产品能力

- 状态：已接受
- 日期：2026-07-18
- 决策者：项目维护者

## 上下文

ITHARBORS 需要支撑不同形态的桌面开发工具。它们共享窗口、布局、消息、配置和主题等
基础设施，但使用不同的 Panel、菜单和业务行为。

如果把每个产品能力直接写进 Framework，核心包会持续认识更多业务概念，功能难以按
产品拆装，测试和发布边界也会混合。只使用普通 npm imports 又无法统一处理 Panel
资源、跨窗口消息、生命周期和会话隔离。

系统因此需要两个层次：

- 一个稳定、通用的运行时扩展协议；
- 一个描述单个会话产品能力集合的组合单元。

## 决策

1. 采用插件作为功能扩展和贡献的基本单元。
2. 插件在 manifest 中声明 Panel、Message、Menu 和 public assets，在 main entry 中
   通过 `editor.plugin.define()` 声明生命周期与 methods。
3. Framework 内置能力也实现为插件贡献控制器，并由 Editor 装配层保持装载。
4. 采用 Kit 组合单个 session 的外部插件、命名布局、窗口入口和主题。
5. Server 为每个 `sessionId` 创建独立 Editor；Kit 切换只影响该 Editor。
6. 外部插件卸载时按 owner 清理贡献；Kit 切换失败时清理新集合并尽力恢复旧集合。
7. Panel 通过受限 runtime 和消息中枢协作，不直接导入其他插件或 Server 内部实例。

## 替代方案

### 单体应用核心

把所有 Panel、菜单和业务流程写进 Server/Client。

未采用：初期路径短，但 Framework 会与具体产品绑定，无法安全切换能力集合，也难以把
会话隔离和卸载语义统一起来。

### 仅使用 npm 包和静态 imports

让每个功能以普通包导出代码，由应用入口选择 import。

未采用：npm 解决代码分发，但不定义贡献发现、Panel 资源安全、运行时所有权、卸载清理
和跨窗口通信。

### 每个 Kit 独立运行完整 Server

把产品隔离提升为进程隔离，每个 Kit 拥有自己的 Server。

未采用：隔离清晰，但开发和资源成本更高，无法在单个 Server 中承载多个会话，也重复
通用基础设施。未来若出现强安全隔离需求，可在部署层重新评估，不改变当前插件协议。

### 全局插件集合，Kit 只提供主题

所有插件始终装载，Kit 只选择布局和外观。

未采用：产品能力不能真正卸载，消息和菜单注册会跨 Kit 泄漏，Kit 无法成为清晰的能力
边界。

## 正面影响

- Framework 保持通用，产品功能可独立组织。
- Kit 可以通过声明组合不同工作台。
- session 拥有独立的插件、消息和窗口状态。
- 贡献点具备统一 attach/detach 与 owner 清理语义。
- Web 与 Electron 使用同一运行时和插件模型。

## 负面影响

- 插件必须维护 manifest、源码与 dist 三者一致。
- 动态装载、贡献互相 attach 和失败回滚增加运行时复杂度。
- 插件边界要求更多间接通信，简单功能也需要遵循消息协议。
- 插件自身的外部副作用仍需作者在 unload 中正确清理，Framework 无法自动撤销一切。

## 后续约束

- 新产品能力默认进入 Kit 插件，不直接加入 Framework。
- 新贡献点必须定义所有权、装载顺序、卸载/失败清理和 session 范围。
- 改变 Kit 的能力边界、插件身份或 Panel 权限模型时应新增 ADR。
- 架构文档必须区分内置插件与 Kit 外部插件，但不能把内置插件描述成协议例外。

## 关联

- [核心设计原则](../architecture/core-principles.md)
- [系统架构](../architecture/system-overview.md)
- [插件运行时模型](../architecture/plugin-runtime-model.md)
- [Kit 与会话模型](../architecture/kit-and-session-model.md)
- [Editor 装配源码](../../packages/server/src/editor/index.ts)
- [PluginModule 源码](../../packages/server/src/framework/plugin/index.ts)
