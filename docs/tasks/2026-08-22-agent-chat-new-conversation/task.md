# 2026-08-22-agent-chat-new-conversation

Task ID: `2026-08-22-agent-chat-new-conversation`
Type: `bug`

## 背景与问题

Agent Chat 的对话列表已经可以显示“新对话”按钮，但在 Web 宿主中点击后，Chat 主面板仍停留在“选择或新建一个对话”，没有进入可输入的草稿态。现有链路应为 Panel 调用 `conversation.select(null)`，Conversation Plugin 更新状态并广播 `conversation.selected`，Chat 消费带 `draft` 的状态后渲染 composer；需要在 Conversation Plugin 边界内锁定并修复这条链路的竞态或状态丢失问题。

## 目标

- 修复从对话列表点击“新建对话”后 Chat 进入草稿态的行为。
- 保证 `conversation.select(null)` 的结果以带 `draft` 的 `conversation.selected` 广播送达订阅面板。
- 增加能复现 Panel request → Conversation select → broadcast → Chat 可见 draft 链路的聚焦自动化测试。

## 范围

- `kits/agent-chat/plugins/conversation/**`：Conversation Plugin 生产代码和测试。
- `docs/tasks/2026-08-22-agent-chat-new-conversation/**`：Task 记录、验证和交接材料。
- 与该消息协议直接相关的中文文档（仅在确有必要时）。

## 非目标

- 不修改 Chat、Agent、Model Service、Framework 或 Server 代码。
- 不改变已有会话选择、归档、重命名和持久化语义。
- 不引入 Electron、桌面宿主或原生窗口假设。
- 不合并 main、push、创建 PR 或删除 worktree。

## 验收标准

- 自动化测试能复现 Panel 请求 `conversation.select(null)`，并断言 `conversation.selected` 广播包含 `selectedConversationId: null` 和有效 `draft`。
- 测试覆盖初始化列表请求与新建草稿请求并发时，旧的选择结果不会覆盖新草稿状态。
- Conversation Plugin 全部测试通过；Agent Chat Kit build/validate 通过；`git diff --check` 通过。
- Task ready gate 通过。
- 主 Agent 使用 Web 宿主点击“新建对话”后确认 Chat 显示 composer/textarea；若当前会话无法使用浏览器工具，提供真实 Panel/消息链路自动化证据并记录阻塞。

## 约束

- 严格遵守 Conversation Plugin 边界，若证据表明根因在 Chat 对 `conversation.selected` 的消费，先暂停并向父 Agent 报告，不越界修改。
- 使用 `npm run task:status --` 推进 Task 状态；状态文件只记录结构化阶段事实，原因、风险和交接写入 summary 或 `.work/`。
- 提交标题使用规范中文 Bug 标题 `[Bug] 修复 Agent Chat 新建对话草稿态`，不以句号结尾。

## 需求变更

本 Task 针对 Web 宿主中点击对话列表“新建对话”后 Chat 不进入草稿态的回归问题建立，收口 Conversation Plugin 内的状态竞态、消息广播和聚焦验证。
