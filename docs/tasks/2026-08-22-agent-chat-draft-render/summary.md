# 2026-08-22-agent-chat-draft-render 交付摘要

## 最终结论

Chat Panel 的生产消息接收链路正常，问题发生在挂载初始化竞态：缓存的 `conversation.selected` draft 与同 sequence 的旧 `conversation.getState` 空快照同时进入 UI state gate。旧 gate 因 generation 不同而接受空快照，清除了 draft。现已拒绝这类同 sequence 初始化快照。

## 需求完成情况

- 已修复 Chat Panel 草稿态被初始化空快照覆盖的问题。
- 已覆盖 gate 顺序规则及 mounted Panel 的真实渲染链路。
- 未修改 Conversation Plugin、Framework、Server 或 Chat 目录外代码。

## 主要改动

- `ui-state-gate.ts`：当 gate 已有 revision 时，拒绝复用同 sequence 的初始化快照，保留已接收的广播状态。
- `ui-state-gate.test.ts`：增加跨 generation、同 sequence 旧快照回归测试。
- `index.integration.test.ts`：在 JSDOM 中挂载构建后的 Chat Panel，模拟 bridge 先缓存 draft、setter 重放、`getState` 返回旧空快照，断言 textarea 和 composer 可见。

## 关键决定

只在 Chat Plugin 内修复消费端状态门控。真正的新 generation 广播仍会通过 setter 递增 sequence 并正常生效；仅阻断初始化请求复用的同 sequence 旧快照，避免改变正常会话切换语义。

## 验证结果

- Chat Plugin 全部测试：94/94 通过。
- Agent Chat Kit build：通过，9 个插件构建完成。
- Agent Chat Kit validate：通过，`FILES=8795`。
- `git diff --check`：通过。
- mounted Panel 集成测试：通过，确认 textarea/composer 出现且 empty state 消失。
- Task ready gate：提交后执行 `node scripts/task-status.mjs check 2026-08-22-agent-chat-draft-render --ready-for-pr`。

## 影响与风险

修复仅影响 Chat Panel 初始化 UI state 的顺序判定。风险较低；如果未来需要在相同 sequence 内处理独立的新快照，应由调用方递增 sequence，而不是复用初始化 sequence。

## 偏差与遗留

当前子 Agent 环境未能使用浏览器 iframe 控制工具，因此未宣称浏览器点击验收通过；已提供真实 Panel mount/消息消费集成测试，父 Agent 需在 Web 宿主中复验点击“新建对话”后的可见 textarea。

## 后续关注

父 Agent squash merge 后，使用当前 Web 宿主重新加载 Agent Chat Kit，点击“新建对话”并确认 Chat 面板进入草稿编辑态。

## 相关正式文档

- `docs/architecture/plugin-runtime-model.md`
- `docs/guides/testing.md`
