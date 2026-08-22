# 新建对话草稿态缺陷修复总结

## 最终结论

Conversation Plugin 的现有生产链路已通过真实 Web SSE 证据确认：Panel 调用 `conversation.select(null)` 后返回带 `draft` 的状态，服务端广播 `conversation.selected`，并向 `chat.main` 派发 `onConversationSelected`。本轮没有继续修改生产状态机，改为补足列表按钮点击边界测试；父 Agent 浏览器操作耗时达到控制层超时，需将最终“不显示 textarea”归因到浏览器 iframe 控制或 Chat 消费侧继续排查。

## 需求完成情况

- 已通过自动化和真实 SSE 证明 Conversation Plugin 的 Panel request、Conversation method、广播及 Chat Panel 派发链路。
- 已补充 `conversation.list` 真实按钮点击测试，断言点击“新建对话”调用 `conversation.select(null)`，并将草稿广播交给 Chat 订阅方。
- 未修改 Chat、Agent、Model Service、Framework 或 Server。
- 未执行 main 合并、push、PR 或 worktree 删除。

## 主要改动

- `kits/agent-chat/plugins/conversation/panel.list/src/index.test.ts` 新增基于 JSDOM 的按钮点击测试，覆盖 React button → Panel SDK request → selected broadcast → Chat subscriber。
- `kits/agent-chat/plugins/conversation/main/src/index.test.ts` 保留 Conversation method 的状态与广播测试，覆盖初始化列表未完成时的 Panel 选择边界。

## 关键决定

- Conversation main 仍是 `conversation.selected` 的唯一生产广播方；Panel 测试中的广播调用只模拟服务端派发到 Chat 的边界，不改变运行时协议。
- 未发现 Conversation Plugin 生产状态机或服务端消息路由缺陷，避免在证据不足时扩大生产改动。

## 验证结果

- `/Users/bytedance/Project/harbors/node_modules/.bin/tsx --test kits/agent-chat/plugins/conversation/main/src/index.test.ts kits/agent-chat/plugins/conversation/panel.list/src/index.test.ts`：4/4 通过。
- `git diff --check`：通过。
- `npm run task:status --` 状态推进：requirements/design/implementation/verification/consolidation 已按阶段记录。
- `node /Users/bytedance/Project/harbors/packages/kit-cli/dist/cli.js build kits/agent-chat`：通过，9 个 Kit 插件构建完成。
- `node /Users/bytedance/Project/harbors/packages/kit-cli/dist/cli.js validate kits/agent-chat`：通过，8795 个文件校验完成。
- 真实 SSE：服务端在 `conversation.select(null)` 后向 `conversation.list`、`chat.main`、`preview.preview` 派发 `onConversationSelected`，payload 含 `selectedConversationId: null` 和 `draft`。
- Web 浏览器：本子 Agent 的浏览器控制插件脚本不可用；父 Agent 报告 iframe click 调用耗时 30 秒且未完成，当前应继续检查控制层或 Chat 消费侧。

## 影响与风险

本轮仅增加 Conversation Plugin 的 Panel 点击测试，生产代码状态机无新增行为变化。已有会话选择与草稿广播语义保持不变。

## 偏差与遗留

真实 SSE 已证明消息广播到达 `chat.main`；但尚未获得 Chat iframe 内部 React state 和 textarea 的浏览器截图证据。若父 Agent 在可靠控制层仍能复现，应提供 Chat 消费逻辑的只读证据后另建越界修复授权。

## 后续关注

父 Agent 应在集成前保留本轮 SSE 和 Panel 点击测试证据；若浏览器控制层恢复，再完成点击“新建对话”后的 textarea 验收。

## 相关正式文档

无。
