# 插件广播 Topic 所有权校验总结

## 最终结论

插件广播入口现已按发布插件校验 Topic 的所有权前缀。调用方继续显式传入完整 Topic，Framework 不自动补前缀；底层 `MessageModule.broadcast(topic, ...args)` 保持不变。

## 需求完成情况

- 插件通过 `ctx.message.broadcast` 发布消息时，标准运行时入口会校验 Topic 是否属于当前插件命名空间。
- Main/session、application plugin、application child runner 与 Panel 广播入口均已覆盖。
- Agent Chat Kit 与 Default Kit 的现有 Topic 已完成命名空间迁移。

## 主要改动

- Main/session plugin runtime 使用闭包中可信的 `ownerName` 校验广播 Topic，要求以 `<ownerName>.` 开头。
- Application plugin runtime 同样使用 `ownerName` 校验 Topic。
- Application child runner 在广播命令入队前执行前缀校验；父进程收到命令后使用其掌握的插件身份再次校验。
- Panel 注入的 `ctx.message.broadcast` 使用 `panelPluginName` 校验 Topic 前缀。
- `MessageModule` 不感知发布者身份，接口和分发行为均未改变。
- Agent Chat Kit 的相关广播与订阅 Topic 迁移为 `agent.*` 命名空间。
- Default Kit 的 `plugin.selected` 迁移为 `plugin-list.selected`。

## 关键决定

- 调用方显式传入完整 Topic，Framework 只校验所有权，不自动补充插件名前缀。
- 所有权校验位于持有插件身份的运行时入口，`MessageModule` 继续只负责 Topic 分发。
- 本 Task 不扩展 Panel 身份认证或服务端鉴权。

## 验证结果

- `packages/plugin` 测试：17/17 通过。
- Server 聚焦测试：4 files、120 tests 通过。
- Agent Chat Kit validate：通过。
- Default Kit validate：通过。
- Plugin TypeScript typecheck：通过。
- Server TypeScript typecheck：通过。
- 浏览器验收：Agent Chat 成功加载 11/11 个插件，现有会话和消息调试面板工作正常，console errors 为空。

## 影响与风险

Panel 中的前缀校验位于浏览器侧，只用于约束标准 `ctx.message.broadcast` 调用，并非服务端安全边界。Panel 仍可通过手写 HTTP `fetch` 绕过该校验并发布其他插件命名空间的 Topic；本 Task 明确不扩展 Panel 身份认证或服务端鉴权。

## 偏差与遗留

本次尝试直接执行 `npm run dev:web`，但 workspace 命令识别失败。端口 `49380` 已有开发服务运行，因此浏览器验收基于该现有服务完成。

## 后续关注

如需把 Panel Topic 所有权校验提升为服务端安全边界，应另行设计可信的 Panel 实例身份与服务端校验机制。

## 相关正式文档

无。
