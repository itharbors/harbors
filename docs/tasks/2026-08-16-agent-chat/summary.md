# Agent Chat Kit 交付摘要

## 最终结论

Agent Chat Kit 已同时对接 Codex app-server 与 Harbors 自主管理的 agent；两种来源会话在同一列表中展示并以图标区分。

## 需求完成情况

`agent-chat` Kit 已提供左侧对话列表、右侧消息区与输入框；UI 可读取所选 adapter 的会话，选择后加载真实历史，并可创建、发送、继续和删除对话。

## 主要改动

- 新增 `kits/agent-chat/`，包括 `agent`、`conversation-list`、`message-panel` 三个插件及左右分栏布局。
- UI 使用 React 18 与 `@chatscope/chat-ui-kit-react`；UI 插件仅通过 Harbors message 协议与 `agent` 插件交互。
- `CodexAdapter` 支持线程列表分页、历史读取、创建、续聊、归档和生命周期清理。
- 已有线程通过 `thread/read(includeTurns: true)` 懒加载历史；跨 app-server 进程续聊前自动 `thread/resume`。
- 新增 `HarborsAdapter`：会话、历史和 turn 由 Harbors 维护，模型通过 `HARBORS_RELAY_BASE_URL`、`HARBORS_RELAY_API_KEY`、`HARBORS_RELAY_MODEL` 和 `HARBORS_RELAY_API` 连接 OpenAI-compatible 或 Anthropic Messages Relay；会话默认保存于 `~/.harbors/pi-agent/sessions`，可由 `HARBORS_AGENT_STORAGE_DIR` 覆盖，删除采用移入 `.harbors-trash` 的可恢复策略。
- Agent 插件聚合 Codex 与 Harbors adapter 的会话，使用来源前缀避免 ID 冲突；会话列表以 `⌘` 表示 Codex、`⚓` 表示 Harbors，并按项目合并展示。新建 Harbors 会话会继承发起时的项目，使其与同项目 Codex 会话归在一起；没有历史项目元数据的旧 Harbors 会话保留独立分组。
- 会话列表改为紧凑卡片：来源图标与 badge、单行标题、截断预览和 hover 归档操作；消息区补充引导空态，并覆盖 ChatScope 在宿主深色主题下的消息文字与气泡颜色，保证可读性。
- Codex 会话读取其真实 `cwd` 并按项目分组，Harbors 会话独立分组；Kit 页面、左右 panel 统一为深色画布。右侧消息区使用全部可用高度，输入区固定在底部。
- 左侧顶栏改为“新对话”按钮：点击后右侧进入不落库的草稿页，显示项目上下文、多行 textarea、Agent 选择与当前默认模型；首次发送时才创建会话。消息面板采用安全的轻量 Markdown 渲染，保留换行，并支持标题、列表、粗体、行内代码与代码块。
- 草稿页在编辑器底栏提供 Codex / HubBert 选项卡与模型选择器。HubBert 会读取 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.relay` 模型目录和 `agent-default-model`；`HARBORS_RELAY_*` 仍是优先级更高的显式覆盖。
- 修复“新对话”无响应：消息面板入口补齐 `onConversationDraft` 派发方法，使 agent 的草稿事件能进入 React 状态并显示新对话编辑器。
- HubBert 草稿页会检查 DSH Relay 的地址与 `apiKeyEnv` 对应环境变量；缺失时直接展示可行动的配置提示并禁用发送，不再以“消息发送失败”掩盖真实原因。
- HubBert 新增轻量 `CredentialResolver`：复刻 DSH 的环境变量优先、`~/.dsh/.credentials.yaml` 后备解析，并拒绝其他用户可读的凭据文件。真实 Relay 验证已通过；临时会话与测试运行时均已清理，未输出凭据。
- 右侧消息区改为底部锚定，输入框始终处于面板最下方，短对话也贴在输入框上方；补齐 iframe 根节点高度，空会话也可保持该布局。CodexAdapter 已将 `item/agentMessage/delta` 转为 `message.delta` 事件，前端在 turn 完成前持续更新助手消息。
- 经用户授权，Web 宿主 `packages/client/index.html` 不再以固定 `100vh` 作为 `#app` 高度；优先使用 `100svh`，并在 `visualViewport` 变化时同步 CSS 变量，避免 Safari 显示顶部 Tab 行时底部内容落在可见区域外。
- HubBert 参考 DeepSeek Harness 的工具循环实现了 Anthropic Messages Relay 工具调用：模型可在每轮按需调用 `list_files`、`read_file`、`search_text`，也可先 `list_skills` 再 `load_skill` 注入项目或用户目录中的 `SKILL.md`。工具仅允许读取当前工作目录；不提供任意命令、写文件或联网能力。工具开始、完成后继续推理等状态经 `message.status` 实时展示在对话中。
- Codex Desktop 已占用写锁的既有 Codex thread 可在 Kit 中读取历史，但不能由 Kit 自行启动的第二个 app-server 续聊；发送失败时 UI 会明确提示该限制并引导新建 Kit Codex 会话或改用 HubBert，而不再显示无意义的通用失败。
- Codex transport 优先检测 `HARBORS_CODEX_APP_SERVER_SOCKET` 或 `~/.codex/app-server-control/app-server-control.sock`；存在时以 `codex app-server proxy --sock` 连接共享 daemon，缺失时才自行启动 app-server。当前桌面 Codex 仍为私有 stdio 模式，没有该控制 Socket，因而不能把现有桌面 thread 接入共享 transport。
- 模型选择器现在也适用于已选会话：Codex 从 app-server 的 `model/list` 获取真实目录，并在 `turn/start` 时传入选择的 `model`；HubBert 读取并持久化 session 的最后模型。切换会话时会显示该会话已记录模型或 adapter 默认模型。
- 修复草稿态与初始会话加载的竞态：初始 `getActiveConversation` 的旧响应不能再覆盖“新对话”草稿状态。

## 关键决定

- Agent 插件集中维护会话、选中状态和消息缓存，两个 UI 面板不持有业务状态。
- 第一阶段等待整轮 Codex 回复完成后再显示，不实现流式输出。
- 历史读取以本机 Codex app-server 的 thread/turn 数据为权威来源。
- HarborsAdapter 参考 DeepSeek Harness 的分层：Harbors 是 agent/session owner，Relay 是模型 transport；没有将 Codex 的进程状态混到一起。
- 未把完整 `pi-ai` provider catalog 打进 Kit：其全量云 SDK 依赖会违反 Kit 的单版本生产依赖校验；当前以 OpenAI-compatible Relay 保留可部署的最小 transport 边界。
- 模型控件当前如实显示 adapter 的默认模型（Codex 默认或 Harbors Relay）；后端尚未暴露按会话切换模型的能力，因此没有伪造实际切换。

## 验证结果

- `cd kits/agent-chat && pnpm run build`：通过。
- `cd kits/agent-chat && pnpm run test:kit`：通过。
- 直接本机 Codex 验证：读取到 30 个既有线程；首个线程读取到 83 条历史消息。
- 跨进程续聊验证：临时线程完成两轮 `user → assistant`，历史共 4 条，随后已归档。
- Harbors 运行时验证：临时 session 完成列表、活动对话、已有历史、新建、发送、读取和归档；Codex 返回 `HARBORS_RUNTIME_UI_OK`，临时资源已清理。
- 浏览器验证：`http://localhost:49480` 的页面显示 30 条本机 Codex 对话和右侧历史消息。
- Harbors mock relay 验证：创建、持久化列表、携带历史发送、读取和归档均通过，标记为 `HARBORS_PI_ADAPTER_OK`。
- 聚合会话验证：同一次 agent 插件生命周期读取到 31 条会话，包含真实 Codex 与临时 Harbors 会话；`codex:`、`harbors:` 来源前缀和选择路由均通过，标记为 `HARBORS_AGGREGATE_CONVERSATIONS_OK`。
- HarborsAdapter 重命名后的真实 Relay 验证：使用 `HARBORS_RELAY_*` 配置完成一轮 Anthropic Messages 请求，标记为 `HARBORS_ADAPTER_REAL_RELAY_OK`；测试会话已归档且未输出凭据。
- 浏览器视觉验证：新建入口、来源图标、来源 badge、紧凑列表卡片和消息气泡均已在 `localhost:49480` 实际渲染确认。
- 浏览器布局验证：项目分组与计数、统一深色背景、右侧全高消息区及底部固定输入框均已在 `localhost:49480` 实际渲染确认。
- DeepSeek Harness 真实 Relay 验证：读取其 `relay` 配置的 endpoint、模型和凭据引用，使用 Anthropic Messages 协议完成一轮真实请求，标记为 `HARBORS_PI_REAL_RELAY_OK`；测试会话已归档且未输出凭据。
- 本轮 UI 改动后再次执行 `cd kits/agent-chat && pnpm run build` 与 `pnpm run test:kit`：均通过。
- 本轮 DSH 配置与模型选择改动后再次执行 `cd kits/agent-chat && pnpm run build` 与 `pnpm run test:kit`：均通过。
- 本轮工具调用与空页布局改动后再次执行 `cd kits/agent-chat && pnpm run build`、`pnpm run test:kit`、`git diff --check`：均通过。
- Safari 视口修复后执行 `pnpm --filter @itharbors/client test`（257 tests）及 Kit 构建/校验：均通过。
- 会话级模型选择改动后再次执行 Kit 构建与校验：均通过；临时 Codex app-server 验证了 `model/list` 与携带 `model` 的 `turn/start` 参数可用，测试线程已归档。
- 空会话浏览器验证：点击“新对话”后 textarea 的底边位于面板底部输入区（面板内视口高度 691px，textarea 底边为 606px，余量为输入区内边距）。
- 真实 DSH Relay 工具验证：临时 HubBert 会话调用 `list_files` 并完成后续推理，记录到 3 个过程状态；会话随后移入可恢复的归档目录，未输出凭据或模型回复内容。

## 影响与风险

- 真实 Relay 已通过当前机器的 DeepSeek Harness 配置验证；其他环境需设置 `HARBORS_RELAY_BASE_URL`、`HARBORS_RELAY_API_KEY`、`HARBORS_RELAY_MODEL` 和 `HARBORS_RELAY_API` 后启用。
- Kit 使用 esbuild 构建；未声明 `@types/react`，额外手工 strict TypeScript UI 检查会因缺少 React 类型声明失败，但实际构建、运行时消息链路和浏览器渲染均通过。

## 偏差与遗留

- 当前开发宿主的客户端可正常监听但自动化浏览器新建页仅显示空白画布；构建、Kit 校验和此前已通过的页面视觉验证不受影响。需要在现有用户预览会话刷新后再作最终交互验收。

## 后续关注

- 若后续需要完整静态类型检查，可在 Kit 的开发依赖中补充 React 类型声明。
- 在提交前应确认 `scripts/dev.mjs` 的 Kit source 支持是否作为独立可评审改动处理。
- HubBert 当前为安全起见只开放工作区只读工具；若需要终端执行或文件写入，应单独设计权限策略与用户确认机制。
- HubBert 的 Relay 文本 token 仍使用完整响应；工具状态已实时显示，逐 token 输出需 Relay 支持 SSE 后扩展。
- 如需在 Kit 中续聊被 Codex Desktop 占用的现有 thread，需要 Codex Desktop 暴露可复用的 app-server transport；当前 stdio app-server 不允许第二个 writer 并发占用同一 thread。

## 相关正式文档

- 本 Task 的目标、范围和验收标准：`docs/tasks/2026-08-16-agent-chat/task.md`。
