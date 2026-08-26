# 归档对话删除与最近项目选择 — 总结

Task ID: `2026-08-26-conversation-archive-delete-and-recent-projects`
Type: `feature`

## 最终结论

归档对话永久删除和 Chat 最近项目快捷选择的实现与自动化验证已完成；真实 Web 宿主加载通过，但嵌套 iframe 的自动点击定位不稳定，删除确认与最近项目点击尚未取得浏览器交互完成证据，因此 verification 暂不收口。

## 需求完成情况

1. 归档设置页支持永久删除单个归档对话，删除前有明确确认，删除后归档从列表消失且磁盘文件被移除。
2. Chat 项目选择器展示此前对话中已记录的项目路径，支持一键选择。
3. Agent 保持会话持久化事实唯一所有权，Conversation 负责 UI 协调与请求转发，Plugin 间仅通过 request/broadcast 交互。
4. 删除归档与项目选择均 fail-closed：非法 ID、不存在、文件状态变化、并发冲突等场景安全失败。

## 主要改动

### Agent Plugin

- `adapter/base.ts`：`AgentAdapter` 接口新增 `deleteArchivedConversation(id): Promise<{ id: string }>`。
- `adapter/harbors.ts`：`HarborsAdapter` 实现 `deleteArchivedConversation`，在会话写队列与文件锁内原子删除 tombstone 与归档 JSONL，失败时尽力补偿，补偿失败返回 `ARCHIVE_STATE_INCONSISTENT`。
- `main/src/index.ts`：新增 `deleteArchivedConversation` request route，解析 namespaced ID、调用 adapter、广播 `agent.conversation.changed` 的 `delete` action。
- `package.json`：注册 `deleteArchivedConversation` request，caller 白名单仅允许 `conversation`。

### Conversation Plugin

- `main/src/index.ts`：
  - 新增 `deleteArchivedConversation` owner request，校验 ID 后转发至 Agent。
  - 新增 `listKnownProjects` owner request，聚合活动与归档会话的 `project` 字段，去重去空、稳定排序并返回最近 12 条。
  - 对异步初始化和归档读取增加 lifecycle 重校验，避免卸载后的旧 runtime 返回结果。
  - `ConversationChangedPayload` 增加 `delete` action。
- `package.json`：删除入口仅允许 Conversation 自身调用，最近项目入口仅允许 Chat 调用。
- `panel.settings/src/index.ts`：归档卡片新增"删除"按钮，点击后弹出确认，确认后调用 `conversation.deleteArchivedConversation`，成功后刷新列表。
- `panel.settings/src/index.css`：新增危险按钮样式与操作容器布局。

### Chat Plugin

- `panel.main/src/app.tsx`：`DirectoryPicker` 新增"最近项目"区域，点击项目先通过 Agent 验证目录再确认选择。
- `panel.main/src/directory-picker.ts`：封装最近项目目录的 owner 验证。
- `panel.main/src/styles.css` / `index.css`：新增最近项目区域样式。

### 测试

- `tests/assembly.test.ts`：覆盖删除成功、广播顺序、Agent 与 Conversation caller 白名单及最近项目 caller 白名单。

## 关键决定

- 归档删除采用与归档/恢复一致的 `BusinessResult` envelope 和稳定错误码，不引入新的错误分类。
- 删除顺序为 tombstone 先于归档 JSONL；若 tombstone 删除成功但 JSONL 删除失败，tombstone 可恢复，JSONL 已删则标记不一致。
- 最近项目由 Conversation 聚合活动与归档会话的 `project` 字段，无需新增存储；仅目录有效性复核通过 Agent request 完成。
- 删除操作必须经用户确认（`confirm`），未确认不执行。

## 验证结果

- 聚焦 Agent、Conversation、Settings 与 Chat 测试：55/55 通过。
- Harness 全量单元测试：299/299 通过。
- Harness assembly 测试：10/10 通过，含 `deleteArchivedConversation` caller 白名单验证。
- Conversation runtime smoke：2/2 通过。
- Web host smoke：通过。
- 真实 Web 宿主：13/13 Plugin 加载、无 console error；嵌套 iframe 自动点击定位不稳定，未执行真实数据删除，也未将功能点击记为通过。

## 影响与风险

- 归档删除是不可恢复操作，依赖 UI 层确认；若调用方绕过确认直接调用 request，仍会执行删除。caller 白名单限制只有 conversation 可调用，降低误调用风险。
- 最近项目列表在选择器打开时请求一次，不做实时订阅；若会话在选择器打开期间归档/恢复，列表不会自动更新。
- 归档 JSONL 已 unlink 后若最终目录 sync 失败，无法恢复已删除 bytes，会返回 `ARCHIVE_STATE_INCONSISTENT` 并保留 tombstone 诊断证据。

## 偏差与遗留

- 未提供批量删除归档或清空全部归档（非目标）。
- 未对活动会话提供永久删除（非目标）。
- 最近项目未持久化到独立存储，仅从现有会话聚合；删除所有含某项目的会话后该项目不再出现在最近列表。

## 后续关注

- 可考虑为归档删除增加二次确认弹窗（替代浏览器原生 `confirm`）以提升体验一致性。
- 可考虑为最近项目增加"清除历史"入口。

## 相关正式文档

- `docs/tasks/2026-08-26-conversation-archive-settings/`：归档/恢复协议与设置页基础。
- `docs/tasks/2026-08-26-remove-corrupt-conversation/`：损坏会话隔离移除。

## blocking

- 浏览器交互验收尚未完成，verification 保持进行中。

## non_blocking

- Assembly 仍会偶发输出临时数据根清理后的 ENOENT 日志，但测试通过；这是既有异步清理噪声，本次未扩大范围处理。

## decision_candidates

无。

## follow_up

- 归档删除确认可替换为自定义弹窗以统一 UI 风格。
- 最近项目可增加清除历史或固定项目能力。
