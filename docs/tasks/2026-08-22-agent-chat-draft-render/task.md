# 2026-08-22-agent-chat-draft-render

Task ID: `2026-08-22-agent-chat-draft-render`
Type: `bug`

## 背景与问题

Web 宿主中点击“新建对话”后，Conversation Plugin 已成功请求 `conversation.select(null)`，并通过真实 SSE 将 `conversation.selected` 广播送达 Chat Panel。广播 payload 包含 `selectedConversationId: null` 和 draft，但 Chat 仍显示“选择或新建一个对话”，未渲染 composer。

根因是 Chat Panel 挂载期间的状态竞态：广播先由 bridge 缓存，React effect 注册 setter 时重放草稿；随后 effect 启动时捕获的同一 sequence 对应的 `conversation.getState` 返回旧的空快照。原 UI state gate 将 generation 变化误判为可接受的新状态，清除了已进入的 draft。

## 目标

- 修复 Chat Panel 初始化 `getState` 与已到达的 `conversation.selected` 广播之间的竞态。
- 确保真实 Panel 消息链路收到 draft 后进入编辑态并渲染 textarea。
- 用聚焦的 gate 单测和 mounted Panel 集成测试锁定回归。

## 范围

- `kits/agent-chat/plugins/chat/panel.main` 的 UI state gate、Panel 集成测试。
- 本 Task 文档及状态记录。

## 非目标

- 不修改 Conversation Plugin、Chat 之外的插件、Framework、Server 或 Web 宿主控制层。
- 不改变正常的新 generation 广播、会话切换或已有消息同步语义。

## 验收标准

- 同 sequence 的初始化旧快照不能覆盖已接收的 draft 广播。
- mounted Chat Panel 在“广播缓存 → setter 重放 → getState 返回旧空快照”链路下显示 composer/textarea，不显示空态。
- Chat Plugin 测试、Agent Chat Kit build/validate、`git diff --check` 和 Task ready gate 通过。
- 浏览器验收如受 iframe 控制层限制，必须如实记录，并由父 Agent 使用 Web 宿主复验。

## 约束

- 严格限制修改在 `kits/agent-chat/plugins/chat/**` 与本 Task 文档内。
- 仅支持 Web 宿主，不引入桌面或 Electron 假设。
- 提交标题使用规范中文 Bug 提交，子 Agent 不合并 main、不 push、不建 PR。

## 需求变更

- 2026-08-22：补充 Chat 侧新 Bug Task，确认生产广播已到达，修复重点从 Conversation producer 调整为 Chat UI state gate 的初始化竞态。
