# 归档对话删除与最近项目选择

Task ID: `2026-08-26-conversation-archive-delete-and-recent-projects`
Type: `feature`

## 背景与问题

Conversation Plugin 的设置页已能展示归档对话并提供恢复入口，但归档列表中的对话无法被永久删除，用户只能恢复后再从活动列表处理，缺少直接清理归档的能力。

同时，Chat Plugin 的项目选择器（DirectoryPicker）只能逐级浏览文件系统目录。用户在创建新对话或切换项目时，无法直接选择此前已经在对话中使用过的项目路径，每次都需要重新浏览定位，操作成本高。

## 目标

1. 归档对话设置页支持永久删除单个归档对话，删除前需明确确认，删除后该归档从列表消失且不可恢复。
2. Chat Plugin 的项目选择器支持展示并选择此前对话中已记录过的项目路径，减少重复浏览文件系统的操作。
3. 保持 Agent 对会话持久化事实的唯一所有权，Conversation 只负责 UI 协调与请求转发；Plugin 间仅通过 request/broadcast 交互。
4. 删除归档与项目选择均保持 fail-closed：非法 ID、不存在、文件状态变化、并发冲突等场景安全失败，不产生虚假成功。

## 范围

### 归档对话删除

- `kits/harness/plugins/agent/**`：新增 `deleteArchivedConversation` request，在 Adapter 层原子删除归档 JSONL 与 tombstone，返回稳定业务结果 envelope。
- `kits/harness/plugins/conversation/**`：新增 `deleteArchivedConversation` owner request，校验并转发至 Agent；设置页归档卡片新增"删除"按钮与确认交互，成功后从列表移除。
- `kits/harness/tests/**`：必要的跨 Plugin assembly 验证。

### 最近项目选择

- `kits/harness/plugins/conversation/**`：新增 `listKnownProjects` owner request，从活动与归档会话中聚合去重的项目路径列表。
- `kits/harness/plugins/chat/**`：DirectoryPicker 增加"最近项目"区域，展示已知项目并支持一键选择；保留原文件系统浏览能力。
- `kits/harness/tests/**`：必要的跨 Plugin assembly 验证。

### Task 档案

- 本 Task 的 `task.md`、`status.json`、`.work/**` 与收口阶段的 `summary.md`。

## 当前实现事实

- Conversation 设置页（`panel.settings`）渲染归档列表，每张卡片仅有"恢复对话"按钮，调用 `conversation.restoreConversation`。
- Agent 已有 `listArchivedConversations`、`archiveConversation`、`restoreConversation` 三个 request，底层使用 `storage-v1/.harbors-trash` 存放归档 JSONL、`storage-v1/sessions/<id>.deleted` 作为 tombstone。
- 归档摘要包含 `id`、`source`、`title`、`project?`、`createdAt?`、`updatedAt?`、`archivedAt`、`status`、`errorCode?`。
- Conversation Main 维护活动会话列表 `conversations`，每条会话含 `project?` 字段；Agent `listConversations` 返回的活动会话同样含 `project?`。
- Chat Plugin 的 `DirectoryPicker` 通过 `agent.listDirectory` 浏览文件系统，无最近项目概念。
- 现有归档/恢复协议使用 `BusinessResult<T> = { ok: true; value: T } | { ok: false; error: { code, message } }` envelope，稳定错误码见 `conversation-archive-settings` Task。

## 非目标

- 不提供批量删除归档或清空全部归档。
- 不修改活动会话的归档/恢复语义与存储格式。
- 不把归档删除扩展为活动会话的永久删除；活动会话仍只支持归档。
- 不在 Conversation 或 Chat 中直接读取磁盘文件；所有持久化事实由 Agent 提供。
- 不修改 Settings、Preview、Model Service 等其他 Plugin。
- 不更改会话 JSONL 内容格式或 Transcript 事件协议。

## 消息协议与完整链路

### 归档对话删除

- Agent 新增 `deleteArchivedConversation(id)` request，caller 白名单仅允许 `conversation`。
- Conversation 新增同名 owner request `deleteArchivedConversation(id)`，设置页只能请求 Conversation，不能直接请求 Agent。
- Conversation 的删除入口仅允许 Conversation 自身调用，避免其他 Plugin 绕过设置页确认；最近项目入口仅允许 Chat 调用。
- 请求参数为单个非空 namespaced ID 字符串（`harbors:<uuid>`），不接受路径或 options。
- 返回 `BusinessResult<{ id: string }>`：成功时 `value` 为被删除的归档 ID；失败时返回稳定错误码与不含路径的安全消息。
- 稳定错误码（在既有归档错误码基础上新增）：
  - `ARCHIVE_NOT_FOUND`：归档不存在或已被删除。
  - `ARCHIVE_FILE_INVALID`：归档 JSONL 或 tombstone 为 symlink/非普通文件。
  - `ARCHIVE_TOMBSTONE_INVALID`：tombstone 非法或 ID 不一致。
  - `ARCHIVE_OPERATION_FAILED`：删除失败但补偿已恢复原状态。
  - `ARCHIVE_STATE_INCONSISTENT`：补偿失败，保留证据并 fail closed。
- 删除成功后 Agent 广播 `agent.conversation.changed`，payload 为 `{ action: "delete", id }`（仅用于归档列表同步，不影响活动列表）。Conversation Main 收到后不改变活动列表，仅通知设置页刷新。
- 删除在 Adapter 层进入同一会话写队列并使用文件锁；先删除 tombstone 再删除归档 JSONL，任一步失败时尽力补偿（恢复已删文件），补偿失败返回 `ARCHIVE_STATE_INCONSISTENT`。

### 最近项目选择

- Conversation 新增 `listKnownProjects()` owner request，返回 `BusinessResult<string[]>`，值为活动与归档会话中出现过的去重项目路径，按最近使用时间降序并限制为 12 条。
- Conversation Main 聚合 `conversations`（活动）与 `listArchivedConversations`（归档）的 `project` 字段，去空、去重，按 `updatedAt`/`archivedAt` 降序排序。
- Chat 的 DirectoryPicker 在文件系统浏览区上方新增"最近项目"列表，点击后先由 Agent 重新验证目录可读，再确认选择；无已知项目时该区域不展示。
- 最近项目数据在选择器打开时请求一次，不做实时订阅；选择后关闭选择器并切换项目。

## 验收标准

1. 归档设置页每张归档卡片除"恢复对话"外，提供键盘可达、名称明确的"删除"按钮；点击后弹出确认，说明该操作不可恢复。
2. 确认删除后，归档从列表消失；Agent 磁盘上对应归档 JSONL 与 tombstone 被移除，重启后不再出现。
3. 删除失败（文件不存在、已被恢复、symlink、并发冲突）时返回稳定错误码，设置页显示可理解的错误提示，不产生虚假成功。
4. Agent `deleteArchivedConversation` 的 caller 白名单仅允许 `conversation`；其他 caller 被拒绝且零磁盘副作用。
5. 删除补偿失败时返回 `ARCHIVE_STATE_INCONSISTENT`，保留可诊断证据，不覆盖或清理残留文件。
6. Chat 项目选择器展示"最近项目"列表，包含此前对话中使用过的项目路径；点击可直接选中并切换。
7. 最近项目列表按最近使用时间降序，去重去空；无已知项目时不展示该区域，原文件系统浏览不受影响。
8. 业务代码变更仅限 `kits/harness/plugins/agent/**`、`kits/harness/plugins/conversation/**`、`kits/harness/plugins/chat/**`。
9. Agent、Conversation、Chat 分别完成针对性单元/组件测试；`kits/harness/tests/assembly.test.ts` 覆盖归档删除 request、broadcast、caller 白名单与最近项目聚合。
10. 在唯一 Web 宿主中用隔离 data root 浏览器验收：归档删除（成功/失败/确认）、最近项目选择与切换。

## 约束

- Harbors 仅支持 Web 宿主；UI 与共享可见行为必须通过 Web 浏览器验收。
- Agent 是会话文件与归档事实的唯一 owner；Conversation 不直接读取 trash、tombstone 或 JSONL。
- Plugin 之间仅通过 request/broadcast 消息交互，不导入彼此内部源码或共享可变状态。
- 归档删除是不可恢复操作，必须有明确确认；不得在未确认时执行。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- `docs/tasks/2026-08-26-conversation-archive-settings/` 已实现归档/恢复协议与设置页，并明确不提供永久删除；本 Task 在其基础上新增归档删除能力。
- 现有归档存储使用 `.harbors-trash` + `.deleted` tombstone，删除需同时清理两者并保持原子性。
- 项目路径已存在于活动与归档会话摘要中，无需新增存储；Conversation 可直接聚合。
- owner：后续任务主 Agent，负责协议冻结、Task 状态、跨 Plugin 验收和实际 diff 检查。
- implementer：Agent、Conversation、Chat 各自独立工作单元的负责人，只修改所属 Plugin 路径。
- reviewer：后续独立审查角色，重点检查删除原子性、补偿、caller 白名单与最近项目聚合。
- approver：当前用户，负责产品语义和后续交付选择。

### 逐条处置与分工

- **Agent 文件所有权**：适用；归档删除的磁盘操作与补偿位于 Agent Plugin。
- **Conversation UI 所有权**：适用；删除确认、反馈与列表投影位于 Conversation Plugin。
- **归档可恢复原则**：删除是显式的不可恢复操作，与归档/恢复的可恢复语义分离，必须二次确认。
- **Plugin 边界**：Chat 不直接请求 Agent，最近项目由 Conversation 聚合后提供。

## 需求变更

- 初始归档 Task 明确不提供永久删除能力。
- 本 Task 根据用户反馈新增归档对话的永久删除入口，以及 Chat 项目选择器的最近项目快捷选择能力。
- 不改变既有归档/恢复协议与存储格式，仅在其基础上扩展。
