# ADR 0005：Plugin 默认接口绑定可信身份与所有权

- 状态：已接受
- 日期：2026-10-18
- 决策者与批准者：当前需求发起人
- 批准范围：本 Task 已明确授权的默认身份、存储、owner、快照与调用权限修复及原则提炼
- 适用条件：受信 Plugin 使用 Framework 公开 runtime、贡献与控制面查询接口
- 排除条件：OS 沙箱、具体业务 schema、跨 Session 实时同步和真实旧数据迁移
- 来源 Task：[2026-10-18-plugin-default-boundaries](../tasks/2026-10-18-plugin-default-boundaries/task.md)

## 上下文

旧接口要求 Plugin 作者自行记住用户范围、路径归属与清理边界。持久目录、Config 和
Credentials 可能只按 Plugin 或 Kit 划分；部分清理接口能影响其他 owner，查询返回值能改写
内部控制元数据，同步直调与消息调用的权限也不一致。正常使用默认接口仍可能串扰。

用户已授权本轮一起修复，并同步设计文档、提炼通用原则。目标是让正确边界来自接口绑定，
同时维持插件优先和 Framework 不认识产品概念的分层。

## 决策

1. **默认正确，扩大共享显式化。** Host 从可信 Session owner 绑定 User、基础 Session 和
   Plugin 身份。必要身份缺失时失败，不回退公共根。默认持久数据与缓存属于 User + Plugin，
   Session 专属数据和临时目录再包含基础 Session；Config 和 Credentials 保留 Kit + Plugin
   namespace 并纳入 User。应用级 Plugin 保留应用级范围，不伪造 User。
2. **Framework 只管理通用边界。** User、Session、Plugin 的身份、作用域与能力约束属于
   Framework；Conversation、Project 及其 schema、索引和生命周期继续属于业务 Plugin。
   一个基础 Session 可有多个 Kit runtime，每个 runtime 拥有独立 Editor。
3. **写操作绑定 owner。** 普通 Plugin 对贡献资源的删除、重置与注销只影响自身 owner，并验证实际
   注册 owner。Host 全局清理与内置贡献控制器的窄化委托不进入普通 facade。
4. **读取与内部状态解耦。** 控制面查询、注册输入、Config JSON 值与 lifecycle attach 数据
   不向外保留内部可写引用；身份、权限、归属和装配元数据只能通过受控写接口改变。
5. **调用权限只有一种语义。** Host 绑定可信 caller。request 与保留的同步直调共享 manifest
   的 server request 声明及 callers 约束；不能通过换入口调用未公开方法或伪造身份。
6. **不猜测旧数据归属。** 新 User 绑定不回退旧无 User 的 Session Plugin 路径、Config 或
   Credential scope，不读取、迁移或删除真实旧数据。升级可能呈现空历史、默认配置或缺少
   凭据；迁移须另行明确来源 owner 和授权。

这些决策约束正常接口使用，不把同一 OS 账号下的 Node.js Plugin 描述成不受信代码沙箱。
作用域也不决定数据保留周期；跨 Session 共享持久数据不包含跨 Session 广播承诺。

## 替代方案

- **让每个 Plugin 自行过滤 User、拼路径和限制清理。** 未采用：同一错误需要在每个作者和
  入口重复避免，默认接口仍不可靠。
- **全部持久数据按 Session 隔离。** 未采用：会割裂同 User 的历史和设置，混淆运行时隔离
  与持久数据归属。
- **保留匿名直调或旧共享根回退。** 未采用：会留下 ACL 旁路，并把来源不明的旧数据归给
  某个 User。
- **在 Framework 引入 Conversation 或通用业务数据库。** 未采用：本问题只需通用身份和
  能力绑定，不需要扩大 Framework 的产品知识。

## 影响

正常使用公开 API 自动获得明确归属，owner 清理、快照与 ACL 可分别用跨 User、跨 Session、
跨 Plugin 和修改返回值的回归测试验证。代价是旧隐式共享不再可见，必要同步消费者必须显式
声明公开方法；未来共享与迁移需要独立契约。精确接口和路径以源码及架构文档为当前事实，
不把本 ADR 固化成所有实现细节的清单。

## 角色反馈与批准边界

- 角色反馈：审查指出默认共享、跨 owner 清理、可写查询引用和双调用入口问题；反馈是证据，
  不独立批准共享或迁移策略。
- 批准者与范围：用户已明确授权本轮修复及设计、原则更新；本 ADR 只记录上述方向。
- 未覆盖事项：旧数据迁移工具、OS 权限隔离、跨 Session 广播、多人协作与业务 schema。

## 关系与验证来源

- 部分取代 [ADR 0001](./0001-plugin-first-architecture.md) 第 5 项中一个基础 Session 仅有
  一个 Editor 的简化表述；插件优先、Kit 能力组合与 owner 清理结论继续有效。
- 细化 [ADR 0002](./0002-web-only-host.md) 第 6 项在统一 data root 下的 Plugin/Config
  归属范围；统一 `~/.harbors`、Web-only 和隔离测试根契约继续有效。其历史启动迁移文字
  不作为新 User 绑定读取旧无 User 数据的依据，本 ADR 不新增旧设备或 Session 数据库迁移决策。
- 当前事实：[Plugin 运行时模型](../architecture/plugin-runtime-model.md)、
  [Kit 与会话模型](../architecture/kit-and-session-model.md)、
  [Kit 配置模型](../architecture/kit-configuration-model.md)、
  [核心原则](../architecture/core-principles.md)。
- 执行方法：[Plugin 与 Kit 开发指南](../guides/developing-plugins-and-kits.md)。
- 源码：[身份与 runtime 类型](../../packages/plugin/src/runtime.ts)、
  [Plugin 路径](../../packages/plugin/src/paths.ts)、
  [Editor 装配](../../packages/server/src/editor/index.ts)、
  [Credential scope](../../packages/server/src/credentials/scope.ts)。
- 验证与后续结论：[来源 Task](../tasks/2026-10-18-plugin-default-boundaries/task.md)。
- 被取代或部分取代：无。

## 检索提示

Plugin 默认隔离、可信身份、User Session Plugin、global 配置、Credential scope、owner 清理、
查询快照、callPlugin、request callers、旧无 User 数据、扩大共享显式化。
命中后核对适用条件与排除条件；本 ADR 不提供 OS sandbox、业务数据库或迁移授权。
