# Conversation 设置与归档管理

Task ID: `2026-08-26-conversation-archive-settings`
Type: `feature`

## 背景与问题

Harness 的 Conversation Plugin 已在活动对话卡片菜单中显示“归档”，但它实际调用 Agent Plugin 的 `deleteConversation`：底层把会话 JSONL 移入 trash 并写入 tombstone。当前产品没有 Conversation 自有设置页，也没有列出归档对话或恢复对话的入口，导致“归档”在界面上表现为不可找回的删除，消息名与真实可恢复存储语义也不一致。

用户明确提出 Conversation Plugin 应该有设置，并支持对话归档。本 Task 将设置页定义为归档对话的管理入口，同时明确 Conversation 与 Agent 的所有权和消息链路。

## 目标

1. Conversation Plugin 注册并拥有自己的 Settings Panel，由全局 Settings Center 负责展示和导航。
2. 活动对话可以归档；归档后从活动列表消失，但会话历史和元数据仍可恢复。
3. Conversation Settings 可以查看归档对话并恢复到活动列表。
4. 将公开业务语义从误导性的“删除”收敛为“归档”，不把可恢复操作伪装成永久删除。
5. Conversation 负责选择状态和界面协调，Agent 负责会话持久化与原子归档/恢复；Plugin 之间仅通过定向 request 与既有 broadcast 交互。

## 范围

### Conversation Plugin 工作单元

- `kits/harness/plugins/conversation/**`：新增 Settings Panel contribution、归档管理 UI、owner 请求接口、活动/归档列表状态同步和针对性测试。
- 活动对话列表继续提供“归档”入口，并使用语义明确的 Conversation owner 请求。

### Agent Plugin 工作单元

- `kits/harness/plugins/agent/**`：提供活动会话归档、归档会话查询和恢复的消息接口与 Adapter 能力。
- 将现有 trash/tombstone 存储收敛为可查询、可恢复的 archive 语义，保留原子移动、锁、活动会话保护和损坏文件防护。

### Task 档案

- 本 Task 的 `task.md`、`status.json`、后续 `.work/**` 和 `summary.md`。

## 当前实现事实

- Conversation manifest 目前只贡献 `panel.list`，公开 request 只有 `getState` 与 `select`；列表 Panel 直接请求 Agent 的 `listConversations`、`renameConversation` 和 `deleteConversation`。
- Agent manifest 已有 schemaVersion 3 的 Agent Settings contribution，但 Conversation 尚未贡献 `panel.settings` 或 `settings`；Settings Center 已支持业务 Plugin 自有 Panel，页面请求会以所属 Plugin 为 caller 直接进入 owner，不需要 Settings 转发。
- Agent Main 的 `deleteConversation` 在 Adapter 成功后才从内存活动列表移除并广播 `{ action: "delete", id }`；失败路径不广播。Conversation Main/Panel 只识别 `create | delete | rename | update`。
- Harbors Adapter 的活动列表只扫描 `storage-v1/sessions/*.jsonl`；现有“删除”在同会话写队列与源文件锁内先把 JSONL 移到 `storage-v1/.harbors-trash/<id>-<timestamp>-<uuid>.jsonl`，再独占创建 `storage-v1/sessions/<id>.deleted`，内容为 `{ id, deletedAt }`。
- 现有实现已拒绝运行中的会话、源文件 symlink/非普通文件、tombstone 后旧实例写入，并在 tombstone 创建失败时尝试把 trash 文件移回源路径；但没有归档枚举、恢复、旧 tombstone 解析、目标冲突检查或回滚失败后的显式不一致错误。
- Harness 已有 Conversation runtime smoke、Kit assembly、Kit HTTP smoke 和单元测试脚本；现有 assembly 尚未覆盖 Conversation → Agent 的归档/恢复 request 与 `agent.conversation.changed` 顺序，HTTP smoke 也不等于浏览器交互验收。

## 非目标

- 不提供永久删除、批量清空归档或自动过期清理。
- 不在 Settings Plugin 中保存或代理 Conversation 业务数据；Settings 只负责注册页面的目录、导航和容器。
- 不把归档对话加入普通活动列表，也不允许直接选择或继续一个尚未恢复的对话。
- 不修改 Chat、Preview、Model Service 等其他业务 Plugin。
- 不更改会话 JSONL 内容格式、Transcript 事件协议或 Agent 执行语义。
- 当前 design/plan 工作单元不实施业务代码、不修改 Task 状态、不提交、不 push、不创建 PR；后续 implementation 仍需由主 Agent 按执行计划另行调度。

## 消息协议与完整链路

### 协议冻结点

- Conversation 新增 `panel.settings`（标题“对话设置”）及 `contribute.settings = { schemaVersion: 3, panel: "settings", order: 20 }`。Settings Center 只消费静态 contribution；设置页只能请求 `conversation`。
- Conversation 对外 request 固定为 `listArchivedConversations`、`archiveConversation`、`restoreConversation`；Agent 提供同名 request。Agent 这三个 route 的 caller 白名单只允许 `conversation`，防止 Settings Panel 或其他 Plugin 绕过 Conversation owner。
- Plugin 边界的会话 ID 始终为 `harbors:<uuid>`；Adapter 边界只使用本地 UUID。请求参数固定为单个非空 ID 字符串，不接受文件名、路径或任意 options 对象。
- 三个 Agent request 与三个 Conversation owner request 都使用显式业务结果 envelope：`{ ok: true, value: T } | { ok: false, error: { code, message } }`。其中 list 的 `T` 为 `ArchivedConversationSummary[]`，archive 的 `T` 为 `ArchivedConversationSummary`，restore 的 `T` 为恢复后的活动 `ConversationSummary`。已知校验、冲突、文件和补偿失败必须返回 `ok: false`，不能 throw；只有消息路由/调用者鉴权、Plugin 未加载、生命周期卸载或其他 transport/unavailable 才以异常结束。
- 可恢复归档摘要固定为 `{ id, source, title, project?, createdAt?, updatedAt?, archivedAt, status, errorCode? }`：`source` 当前只允许 `harbors`，`status` 为 `available | unavailable`。正常条目必须包含原始标题、项目（若有）、创建/更新时间及归档时间；损坏或不一致条目可用安全占位标题和 `errorCode` 表示，不返回路径、adapterId、Transcript、lastMessage、模型/权限配置或工具结果。
- `agent.conversation.changed` 新增两个互斥 payload：归档成功为 `{ action: "archive", id, archived }`，恢复成功为 `{ action: "restore", id, conversation }`。`archived` 使用上述白名单摘要；`conversation` 使用恢复后的既有活动会话摘要。公开协议移除可恢复操作的 `delete` 命名，且不保留 `deleteConversation` route。
- Agent 只有在持久化状态迁移和内存列表提交后才广播，且在返回 `ok: true` 前发出；任何业务失败都返回 `ok: false`，不发成功广播。广播订阅者异常只记录日志，不把已经提交的持久化结果改写为失败。Conversation Main 在收到 Agent 的 `ok: true` 后仍幂等应用 `value`，不能依赖 broadcast 订阅顺序来保证自身状态；收到 `ok: false` 时只映射安全错误 envelope，不改变列表或选择。

### Conversation 初始化与权威快照

- Conversation Main 在每次 lifecycle load 创建新的 `lifecycleGeneration`、`activityEpoch` 和单例 `initializationBarrier`。Agent 的 `listConversations` 是初始活动列表权威快照；`archiveConversation` 与 `restoreConversation` 必须先等待 barrier，不能基于空数组或 Panel 自有列表执行选择协调。
- 每个初始列表请求捕获 `{ lifecycleGeneration, activityEpoch }`。返回时 generation 已变化则丢弃并按 unavailable 异常结束；epoch 未变化才允许替换活动列表并完成 barrier。请求在等待期间若收到 `agent.conversation.changed`，先递增 epoch 并应用 delta；晚到快照不得覆盖该 delta，而应在同一 generation 下重新请求权威快照，直到某次返回时 epoch 未变化。
- “初始化列表尚未返回时点击归档”的冻结行为是：Conversation owner request 保持 pending 并等待 barrier，期间不得向 Agent 发出 archive request；barrier 成功后再校验/归档。初始化重试耗尽、Plugin unload 或 transport unavailable 时以异常结束，且不调用 Agent archive、不改变 Conversation 状态、不广播 `conversation.selected`。
- barrier 完成后的 archive/restore 命令各自捕获 generation 与递增的 command epoch；Agent envelope 晚到且 generation/command epoch 已失效时不得应用。有效 `ok: true` 与对应 broadcast 允许任意先后到达，但必须按 ID 幂等收敛；有效 `ok: false` 不递增状态 revision。

### 存储与兼容契约

- 新归档继续使用 owner 私有的 `storage-v1/.harbors-trash` 与 `storage-v1/sessions/<id>.deleted`，不改变会话 JSONL。tombstone v1 是 UTF-8 JSON 对象，schema 精确为 `{ "version": 1, "id": "<local-uuid>", "archivedAt": "<ISO-8601>", "archiveBasename": "<basename>" }`，不接受缺字段、额外字段或其他类型。`archivedAt` 必须是 `Date#toISOString()` 形式的 UTC 字符串；`archiveBasename` 必须是单个 basename，精确匹配 `<id>-<Date.parse(archivedAt)>-<archive-uuid>.jsonl`，不得含 `/`、`\\`、`.`/`..` 段或不同 ID。
- 兼容既有 `{ id, deletedAt }` tombstone：只接受精确两个字段、本地 UUID ID 及非负安全整数毫秒时间；仅当 trash 中恰好存在一个匹配该 ID 的普通 JSONL，且完整只读解码、header ID 与文件名 ID 一致时，才投影为 `available`。v1 记录也要求引用文件是唯一匹配候选；缺失、多候选、tombstone/archive symlink 或非普通文件、坏 JSONL、ID 不一致或非法字段均 fail closed，并保留全部证据。
- 归档查询是严格只读路径：不得调用会触发 legacy import、mkdir、尾行 repair、rewrite、缓存调和或 session load/refresh 的活动会话初始化；目录不存在返回成功空数组。查询只允许 `readdir/lstat/stat/readFile` 与 `decodeJsonl(..., { repairTrailingLine: false })` 等无写入操作，且不能更新 Agent 活动缓存。
- `archivedAt` 取值优先级固定为：合法 v1 `archivedAt` → 合法 legacy `deletedAt` 转 canonical ISO → tombstone 自身 `lstat.mtime` 转 canonical ISO；symlink/坏 tombstone 等 `unavailable` 条目也使用最后一项回退，若 mtime 无法表示则使用 `1970-01-01T00:00:00.000Z`。查询按 `Date.parse(archivedAt)` 降序，再按 namespaced `id` 升序稳定返回；单个坏条目不能阻断其他健康归档，也不能泄露底层路径或错误细节。
- 归档与恢复都进入同一会话写队列并使用既有源会话 lock。归档在锁内二次检查运行状态、源文件、既有 tombstone/归档冲突和完整 JSONL；恢复在锁内二次检查 tombstone、唯一归档文件、目标不存在、文件完整性与 header ID。
- 归档失败时尽力恢复源文件并移除未发布元数据；恢复失败时尽力恢复归档文件与 tombstone。若补偿本身失败，返回 `ARCHIVE_STATE_INCONSISTENT`、保留现存证据并停止，不覆盖目标、不清理可诊断文件、不广播成功。正常失败不得留下半成功的内存状态。
- 同一 ID 的并发归档/恢复由队列与文件锁串行化：最多一个请求成功并广播；后到请求依据提交后的磁盘状态返回稳定冲突/不存在错误，不能重复广播。

### 稳定失败语义

- `INVALID_CONVERSATION_ID`：ID 非法或 source 不受支持。
- `CONVERSATION_NOT_FOUND`：待归档活动会话不存在。
- `CONVERSATION_ACTIVE`：会话有正在运行的 Turn；不得隐式 stop/cancel。
- `ARCHIVE_NOT_FOUND`：恢复目标没有可用 tombstone/归档记录，设置页刷新列表。
- `ARCHIVE_CONFLICT`：归档事实已存在，或恢复目标活动 JSONL 已存在；绝不覆盖。
- `ARCHIVE_FILE_INVALID`：归档或源 JSONL 为 symlink/非普通文件、损坏或 header ID 不一致。
- `ARCHIVE_TOMBSTONE_INVALID`：tombstone 非法、ID 不一致、缺少/多出候选归档或 basename 越界。
- `ARCHIVE_OPERATION_FAILED`：移动、写入、删除或同步失败但补偿已恢复原状态。
- `ARCHIVE_STATE_INCONSISTENT`：补偿无法恢复原状态；保留证据并 fail closed。

Agent 只在 `ok: false` envelope 中返回稳定 code 和不含路径的安全消息，底层 cause 仅写 owner 日志。Conversation 校验 Agent envelope 并把已知 code 映射成 Conversation owner 的中文可操作 `ok: false`；Panel 对业务失败读取 envelope，不依赖 catch。未知/畸形 envelope 视为 protocol unavailable 异常，Panel 显示通用传输错误和重试入口。

### 查询归档

1. Conversation Settings Panel 定向请求 Conversation Main：`conversation.listArchivedConversations`。
2. Conversation Main 定向请求 Agent：`agent.listArchivedConversations`。
3. Agent 从 Adapter 的严格只读查询读取归档元数据，返回 `BusinessResult<ArchivedConversationSummary[]>`；不得把原始文件路径或完整 Transcript 暴露给设置页。
4. Conversation Main 严格校验 envelope 和摘要白名单，再以相同 envelope 形状返回 Settings Panel；设置页不直接请求 Agent。

### 归档活动对话

1. Conversation List Panel 定向请求 Conversation Main：`conversation.archiveConversation(id)`。
2. Conversation Main 定向请求 Agent：`agent.archiveConversation(id)`。
3. Agent 校验会话存在且没有运行中的 Turn，调用 Adapter 原子归档。
4. Agent 广播 `agent.conversation.changed`，action 为 `archive`，包含会话 ID 和必要摘要。
5. Conversation Main 幂等更新活动列表；若归档的是当前选中对话，按归档前顺序优先选择后一条、否则前一条活动对话；若没有剩余项，进入继承原项目（缺失时使用默认工作目录）的空草稿，并广播 `conversation.selected`。归档 request 返回前该 owner 状态必须已收敛，Chat 不得继续持有归档 ID。
6. Conversation List Panel 与 Settings Panel 接收变化并更新各自列表；业务失败以 `ok: false` 返回，transport/unavailable 才抛异常，两者都不广播虚假成功。

### 恢复归档对话

1. Conversation Settings Panel 定向请求 Conversation Main：`conversation.restoreConversation(id)`。
2. Conversation Main 定向请求 Agent：`agent.restoreConversation(id)`。
3. Agent 校验归档记录、tombstone、目标冲突和文件完整性，调用 Adapter 原子恢复。
4. Agent 广播 `agent.conversation.changed`，action 为 `restore`，携带恢复后的活动会话摘要。
5. Conversation Main、活动列表和设置页幂等同步；恢复条目按既有活动列表排序规则重新出现，但不自动切换当前选中对话，也不广播无变化的 `conversation.selected`。

## 验收标准

1. Settings Center 中出现由 Conversation Plugin 注册的“对话设置”页面；页面直接请求 Conversation owner，不直接访问 Agent 或依赖 Settings 业务转发。
2. 活动对话菜单中的“归档”调用 `conversation.archiveConversation`，公开 Plugin manifest 与业务调用不再使用 `deleteConversation` 表达可恢复操作。
3. 归档成功后，对话从活动列表移除并出现在“对话设置”的归档列表；标题、项目、来源、更新时间和归档时间展示清楚。
4. 归档当前选中对话时，Conversation 选择状态可靠回退且 Chat 不保留已归档 ID；归档运行中对话被拒绝并显示可理解的错误。
5. 归档操作保持 fail-closed：文件移动、tombstone 或 sync 任一步失败且补偿可完成时恢复原状态并返回 `ARCHIVE_OPERATION_FAILED`；补偿失败时返回 `ARCHIVE_STATE_INCONSISTENT` 并保留全部证据。两者都不产生虚假成功广播或半成功缓存状态。
6. 设置页可以恢复归档对话；恢复后原 ID、标题、项目和完整历史保持不变，重新出现在活动列表，但不会抢占当前选择。
7. 恢复发生 ID 冲突、归档文件损坏、tombstone 不一致或文件缺失时安全失败，不覆盖活动文件，也不删除归档证据。
8. 归档列表不返回原始磁盘路径、凭据、完整消息内容或工具结果；空态、加载态、错误态和重试入口明确。
9. Settings Panel 支持键盘操作、焦点可见、读屏语义和窄面板布局；归档与恢复的成功/失败反馈不只依赖颜色。
10. Conversation 与 Agent Plugin 分别完成针对性单元/组件及必要 runtime 测试；`kits/harness/tests/assembly.test.ts` 使用真实 Kit/Plugin/MessageModule 覆盖 Conversation → Agent request、Agent broadcast、Conversation 选择回退及失败不广播；在唯一 Web 宿主中用隔离 data root 浏览器验收设置页、归档、恢复及选择回退。
11. 业务代码变更仅限 `kits/harness/plugins/conversation/**` 与 `kits/harness/plugins/agent/**`；每个工作单元由对应 Plugin 自己闭环实现，先冻结上述消息协议再并行开发。
12. Agent archive route 的 caller 白名单由 assembly 负向证明：callerless、`settings`、`agent` 和其他业务 Plugin 均在进入 handler 前被拒绝；拒绝前后归档/活动文件 bytes 与 mtime、Agent 活动缓存和相关 broadcast 完全不变。
13. 只读归档查询前后 tombstone、archive JSONL 与活动 JSONL 的 bytes/mtime 完全不变；tombstone symlink 不被跟随。归档/恢复每个 rename、exclusive write、unlink、文件 sync、目录 sync 及其补偿失败均有磁盘状态断言，并区分 `ARCHIVE_OPERATION_FAILED` 与 `ARCHIVE_STATE_INCONSISTENT`。

## 约束

- Harbors 仅支持 Web 宿主；UI 和 Kit 装配行为必须通过 Web 浏览器验收。
- Settings Center 是目录、导航和容器，不拥有 Conversation 数据；Conversation Settings Panel 及其请求接口归 Conversation Plugin 所有。
- Agent Plugin 是会话文件和归档事实的唯一 owner；Conversation 不直接读取 trash、tombstone 或 JSONL。
- Plugin 之间仅通过 request/broadcast 消息交互，不导入彼此内部源码或共享可变状态。
- 归档是可恢复状态迁移，不是永久删除；未实现恢复前不得把现有归档入口宣称为完整完成。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- 用户明确提出 Conversation Plugin 应有设置，并指出对话可以归档；结合现有可恢复 trash/tombstone 行为，将设置页收敛为归档对话管理入口。
- 仓库现有 Settings 架构规定：全局 Settings 只管理页面目录、导航与容器，各业务 Plugin 注册并拥有自己的 Settings Panel，页面直接请求所属 Plugin。
- 已查询批准决策记忆，未找到 Conversation Settings 或归档恢复的 repository/global 条目；索引 freshness 为 `partial`，有 1 个失败文件，因此不能把空结果解释为完整知识库证明。
- owner：后续任务主 Agent，负责协议冻结、Task 状态、跨 Plugin 验收和实际 diff 检查。
- implementer：Conversation 与 Agent 各自独立工作单元的负责人，只修改所属 Plugin 路径。
- reviewer：后续独立审查角色，重点检查归档原子性、恢复冲突、选择状态、消息顺序和 Settings 所有权。
- approver：当前用户，负责产品语义和后续交付选择；本轮已明确只建 Task、不实施。

### 逐条处置与分工

- **复用现有设置架构**：Conversation 注册 schemaVersion 3 Settings contribution；Settings Plugin 无业务改动。
- **修正业务命名**：可恢复操作统一使用 archive/restore，不继续暴露 delete 作为产品 API。
- **保持事实所有权**：Agent 管理归档存储，Conversation 管理 UI、选择状态和设置页投影。
- **默认恢复而非删除**：提供归档列表和恢复，不新增永久删除能力。
- **多 Plugin 边界**：先冻结 request/broadcast 链路，再分别在 Conversation、Agent 文件夹内闭环实现和测试。

## 需求变更

- 初始需求为“Conversation Plugin 也应该有设置；对话可以归档”。
- 结合当前实现，Task 明确现有卡片已能触发底层 trash/tombstone，但缺少归档查询、恢复、设置页和语义正确的消息协议。
- 本轮只完成 Task 定义，后续由其他负责人选择环境并实施。
