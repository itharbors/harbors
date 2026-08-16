# 2026-08-16-agent-chat

Task ID: `2026-08-16-agent-chat`
Type: `feature`

## 背景与问题

需要一个 AI 对话工作台 Kit，让用户可以与 AI agent 进行多轮对话。现有仓库只有 default Kit，缺少面向 AI 对话场景的产品能力。

## 目标

创建 `agent-chat` Kit，提供类似 Codex、DeepSeek Harness 等 AI 对话工具的界面：左侧对话列表，右侧消息列表与输入框。后端通过统一 Adapter 接口同时对接本机 Codex app-server 和 Harbors 自主管理的 agent。

## 范围

- 在 `kits/agent-chat/` 下创建 Kit，包含 layout、window entries 和三个插件。
- 三个插件：
  - `agent`：后端插件，持有对话和消息状态，实现统一 AgentAdapter 接口，聚合 Codex app-server 和 Harbors agent 会话。
  - `conversation-list`：纯 UI 插件，左侧对话列表面板。
  - `message-panel`：纯 UI 插件，右侧消息列表 + 输入框面板。
- 前端使用 @chatscope/chat-ui-kit-react 开源组件库，不自己造轮子。
- Codex app-server 通过 JSON-RPC over stdio 通信，spawn 子进程方式启动。
- Harbors agent 由 Harbors 管理会话与 turn，通过 `HARBORS_RELAY_API=openai-completions` 或 `anthropic-messages` 的 Relay 调用模型；会话列表同时展示两个来源，分别以 `⌘` 和 `⚓` 图标区分。

## 非目标

- 不实现用户认证、多用户隔离或云端同步。
- 不修改 Framework 核心运行时或插件协议。
- 不实现文件上传、图片、语音等多媒体消息。
- 不实现 HubBert Relay 的逐 token 流式输出（工具执行状态可实时展示）。

## 验收标准

- `kits/agent-chat/` 可通过 `pnpm run build` 构建。
- `kits/agent-chat/` 可通过 `pnpm run test:kit` 校验。
- 启动后可进入 agent-chat Kit，左侧显示对话列表，右侧显示消息区与输入框。
- 顶部“新对话”进入草稿态，首次发送时才创建 Codex 或 Harbors 会话；两类会话可在同一列表中切换。
- 会话列表按真实项目工作目录分组；从当前项目创建的 Harbors 会话继承该项目，因此可与 Codex 会话同组。旧 Harbors 会话没有项目元数据时保留独立分组。
- 面板背景与 Kit 页面背景保持一致，消息区占满右侧可用区域且输入框固定在底部；输入框为支持 Shift + Enter 换行的 textarea，并展示当前来源和默认模型。
- 对话内容保留换行，支持标题、列表、粗体、行内代码和代码块等常用 Markdown 格式。
- 右侧消息不足一屏时贴近底部输入框排列；空会话下输入框也固定在面板底部。Codex 回复通过 app-server 的增量通知逐步显示；HubBert 当前 Relay 保持完整回复模式，后续可在 Relay 提供 SSE 时扩展为增量输出。
- 新对话草稿页可选择 Codex 或 HubBert，并选择该来源可用模型。HubBert 默认读取 `~/.dsh/settings.yaml` 中的 `llm-pi-ai.providers.relay` 与 `agent-default-model`；`HARBORS_RELAY_*` 显式配置优先覆盖。密钥仍只通过 DSH 的 `apiKeyEnv` 环境变量引用获取。
- HubBert 复刻 DSH 的本地凭据首要路径：先读取继承的进程环境变量，未命中时读取权限为仅当前用户可读的 `~/.dsh/.credentials.yaml`；密钥不进入 UI、日志或会话存储。
- 使用 Anthropic Messages Relay 的 HubBert 可按 DeepSeek Harness 的循环方式调用受限工作区工具：列目录、读文本、搜索文本，以及发现并按需加载项目/用户 Skill。工具执行过程应在 UI 中实时显示；首期不开放写文件、任意命令或联网工具。
- 切换对话时消息列表正确切换。
- adapter 接口与 Codex 实现解耦，替换 adapter 不影响 UI 插件。

## 约束

- Kit 必须在 `kits/agent-chat/` 目录内独立闭环，不修改该目录外的代码。
- 仅支持 Web 宿主，不加入桌面相关假设。
- 插件之间通过 message 协议通信，不直接导入。
- UI 插件不持有数据，所有数据由 agent 插件管理。

## 需求变更

- 后端从 Coze App Search 改为本机 Codex app-server（通过 JSON-RPC over stdio）。
- 插件名从 `agent-coze` 改为 `agent`。
- adapter 改为目录结构：`adapter/base.ts`（接口）+ `adapter/codex.ts`（实现）。
- 前端 UI 使用 @chatscope/chat-ui-kit-react 开源组件库。
- 新增 Harbors adapter：借鉴 DeepSeek Harness 的「agent loop 与模型 transport 分离」结构，由 Harbors 持久化 session 和 history；`HARBORS_RELAY_BASE_URL`、`HARBORS_RELAY_API_KEY`、`HARBORS_RELAY_MODEL` 和 `HARBORS_RELAY_API` 配置 OpenAI-compatible 或 Anthropic Messages Relay，`HARBORS_AGENT_STORAGE_DIR` 可覆盖会话存储位置。
- 用户已明确授权修改 `packages/client/index.html`：Web 宿主使用 `visualViewport.height` 同步 `#app` 高度，修复 Safari 显示顶部 Tab 行时 `100vh` 大于可见区域、底部内容被截断的问题。
