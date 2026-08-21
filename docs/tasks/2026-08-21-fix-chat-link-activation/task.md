# 2026-08-21-fix-chat-link-activation

Task ID: `2026-08-21-fix-chat-link-activation`
Type: `bug`

## 背景与问题

Agent Chat 的 Markdown 链接由消息列表统一监听。此前监听器挂在 Transcript 表面，并在 `pointerup` 阶段直接触发链接处理；浏览器在主指针释放时可能提供 `button: -1`，导致合法的鼠标/触摸链接激活被错误忽略或与合成 `click` 重复处理。该问题影响消息中的普通外链、`file:` 链接和 `harbors:` 插件链接。

## 目标

- 将 Markdown 链接激活监听提升到 Chat App 的消息列表范围，覆盖消息列表内动态渲染的内容。
- 让普通指针激活统一由合成 `click` 处理，`pointerup` 仅结束拖拽状态；仍能识别拖拽并抑制其合成点击。
- 兼容浏览器在 `pointerup` 中将 `button` 报为 `-1` 的行为，避免一次合法点击丢失或重复广播。
- 保留键盘点击和非主指针过滤，并以自动化测试锁定回归行为。

## 范围

- `kits/agent-chat/plugins/chat/panel.main/src/app.tsx`：在 Chat App 生命周期中安装消息列表范围的委托监听，并转发链接激活。
- `kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx`：调整链接激活控制器的 pointer/click 协作及移除 Transcript 局部监听。
- `kits/agent-chat/plugins/chat/panel.main/src/markdown-links.test.ts`：覆盖 `pointerup button: -1` 后合成点击只广播一次。
- `docs/tasks/2026-08-21-fix-chat-link-activation/`：记录需求、验证和交接状态。

## 非目标

- 不改变链接协议、消息协议、外部打开策略或 `handleLinkClick` 的业务语义。
- 不修改 Preview、Client、服务端或其他插件。
- 不加入 Electron 或桌面宿主行为；本 Task 仅支持 Web 宿主。
- 不以自动化测试替代主 Agent 必须完成的 Web 浏览器验收。

## 验收标准

- Chat 消息列表中的普通 Markdown 链接可通过鼠标/触摸指针激活，并且一次用户操作只广播一次链接信息。
- `pointerup` 的 `button: -1` 随后产生合成 `click` 时，链接仍恰好激活一次。
- 拖拽离开链接、非主指针和键盘点击保持既有语义；拖拽不会错误广播链接。
- `pnpm exec tsx --test kits/agent-chat/plugins/chat/panel.main/src/markdown-links.test.ts` 通过。
- 主 Agent 在 Web 浏览器中确认消息列表内动态链接的鼠标/触摸激活、拖拽抑制及键盘激活行为。

## 约束

- 用户已授权在当前 `main` 为既有改动补建 Task；不创建分支或 worktree，不 push，不创建 PR。
- 允许修改范围限定为上述三个 Chat 文件及本 Task 目录；不得还原其他用户改动。
- 自动验证完成后可填写 `summary.md` 草稿，但在 Web 验收完成前不得将 verification 或 consolidation 标记为 completed。
- 任务状态只通过 `npm run task:status --` CLI 更新；主观风险和交接说明写入 Task 文档，不写入 `status.json`。

## 需求变更

本 Task 补建于既有 Chat 链接激活代码已在当前 `main` 工作区产生之后；既有代码保持为本 Task 的实现基线，仅补齐 Task 记录、验证证据和必要的小范围修正。
