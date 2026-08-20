# 2026-08-20-chat-final-response

Task ID: `2026-08-20-chat-final-response`
Type: `bug`

## 背景与问题

Chat 面板解析 assistant trace 时对所有 assistant 文本统一应用长度截断。思考过程、工具参数和工具结果可以限制长度，但最终回复属于用户必须完整阅读的内容；统一截断会使较长回复在完成后丢失尾部文本，并影响 Markdown 渲染和最终回复展示。

## 目标

- 保留完整的 assistant 最终回复文本，不因 trace 展示长度限制丢失内容。
- 继续限制思考过程、工具调用参数和工具结果等高体积过程数据，避免面板被异常大消息拖垮。
- 仅在 turn 明确完成且存在无工具调用的真实最终回复时默认折叠过程；运行中、失败或中断 turn 不得伪造完成态最终回复。

## 范围

- `kits/agent-chat/plugins/chat/panel.main/src/trace-events.ts`：assistant text/thinking 分离解析和截断策略。
- `kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx`：最终回复识别、过程折叠和 Markdown 展示边界。
- `kits/agent-chat/plugins/chat/panel.main/src/*test.ts`：长回复、思考块、工具调用、完成/中断状态回归测试。

## 非目标

- 不改变模型服务返回内容、对话持久化格式、trace 事件协议或服务端分页接口。
- 不无限制放大思考过程、工具参数/结果或错误消息；这些仍使用现有安全上限。
- 不改变 Chat 的 Mermaid、语音输入、模型选择或权限请求功能。
- 不加入 Electron 或桌面宿主行为。

## 验收标准

- 超过过程消息截断阈值的最终 assistant 文本在解析、投影和渲染后仍保持完整。
- `thinking` 内容仍按既有上限截断；包含 tool call 的 assistant step 不会被误当作最终回复。
- 完成 turn 且有真实最终文本时默认折叠过程并显示完整最终回复。
- 运行中、失败、中断或只有工具调用的 turn 不默认折叠，也不会从普通 surface text 制造虚假的最终回复。
- Markdown 链接、代码和换行在长最终回复中保持可渲染；相关 Chat 面板聚焦测试通过并完成必要 Web 验收。

## 约束

- 只修改 Chat 面板对 trace 的展示投影，不改动服务端原始 trace 数据。
- 必须保留现有消息去重、增量更新、过程折叠和中断状态语义。
- 用户要求直接在当前 `main` 整理现有工作区改动，不创建分支或 worktree，不 push。
- 只支持 Web 宿主，不加入 Electron 或桌面宿主假设。

## 需求变更

- 用户要求先将现有未提交修复按独立 Task 建档并提交，后续再讨论过程数据截断、资源占用和其他 Chat 优化；本 Task 当前只固定“最终回复必须完整”的缺陷修复边界。
