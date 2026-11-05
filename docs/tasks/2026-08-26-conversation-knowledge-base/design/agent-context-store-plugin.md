# Agent Context Store Plugin 设计

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../../2026-10-22-agent-turn-durability/summary.md)。

## 1. 结论

`agent-context-store` 是 Harness Kit 内的 Session Plugin，负责 Conversation 持久化和历史 Context 选择。每 User + Plugin 使用一个 active SQLite Store，同 User 跨基础 Session 共享，不同 User 独立；`conversation_id` 隔离同 User 的 Conversation。`events` 是运行时事实源，状态和 Context Plan 都从 events 派生。

MVP 只实现当前问题需要的能力：

- 用 SQLite 替换 Agent 的 JSONL 运行时读写；
- 保存完整 trace，并维持现有 `surface-v1` 行为；
- 保存明确的当前状态；
- 在候选模式中选择当前状态、当前 Turn、最近 8 条 surface event 和精确锚点命中的旧证据；
- 保持 assistant tool call 与 tool result 的协议闭包；
- 支持空库初始化、归档、恢复和删除。

MVP 不引入 FTS、向量检索、segment 表、自动摘要器或新的分页协议。真实数据超过 P100 门禁后再决定是否增加索引投影。

## 2. 模块边界

Context Store 拥有 SQLite connection、schema、Conversation event、当前状态、Context Plan 和生命周期。Agent 拥有 Model Service、tool loop、权限校验、状态工具和最终 Provider request 装配。

Agent 只能通过同步 `runtime.plugin.callPlugin()` 调用 Store，不直接读取 SQLite；Store 也不调用 Model Service。公开 server methods 复用 manifest request/callers 授权，仅允许 `agent`，不新增独立 ACL。Framework 提供可信 User/基础 Session/Plugin 和 `runtime.paths.data`；Conversation schema、索引和生命周期留在 Plugin，旧无 User 路径不回退。

## 3. API

| Method | 作用 |
| --- | --- |
| `getStatus` | 返回 ready、schemaVersion 和 storeVersion |
| `createConversation` | 创建 active Conversation |
| `listConversations` | 按 active/archived 列表返回 Conversation |
| `loadConversation` | 返回 metadata、完整 events 和 current state |
| `appendEvent` | 幂等追加 event，分配连续 seq |
| `getConversationTrace` | 返回完整 trace |
| `getConversationTraceSince` | 返回 afterSeq 之后的 trace |
| `buildContext` | 构造 `surface-v1` 或 `candidate-v1` Context 和 Plan |
| `recallHistory` | 在当前 Conversation 内按 query/anchor 或最近条数召回 event |
| `archiveConversation` | 无 active Turn 时逻辑归档 |
| `restoreConversation` | 恢复已归档 Conversation |
| `deleteArchivedConversation` | 写外部 tombstone 后永久删除 |

以上与现行 Store methods 一致；分页、重命名、会话设置等外部 facade 由 Agent 组合 `loadConversation`、`appendEvent` 等接口完成。现行 Store 不提供 JSONL codec、导入或导出 API，不保留 exporter 验证承诺。

## 4. 存储

~~~text
<plugin-data>/storage-v2/
├── current.json
├── versions/<version-id>/
│   ├── context.sqlite
│   └── migration-journal.json
└── tombstones/
~~~

`<plugin-data>` 由 Framework 按 User + Plugin 绑定，不是整个应用唯一的公共根。各 Session runtime 可各自建立连接，打开同一 active 数据库。SQLite 使用 WAL、`synchronous=FULL`、foreign keys 和 `busy_timeout=5000`。`current.json` 保存当前 version ID 和 epoch；mutation 前校验 epoch，旧 Runtime 不得继续写入。初始化期间还使用 `migration.lock`；版本内 journal 仅负责空库初始化发布，不是通用 operation journal。

核心表只有：

| 表 | 作用 |
| --- | --- |
| `store_metadata` | format/schema/version/epoch |
| `conversations` | metadata、active/archived、可用状态 |
| `events` | 唯一事实源；`(conversation_id, seq)` 连续唯一 |
| `current_state` | 从 state/relation event 派生的有效状态 |
| `context_plans` | 每次 Context 选择的可清理诊断 |
| `active_turns` | 跨 Runtime 的 active Turn lease |

## 5. 追加与并发

`appendEvent` 在 `BEGIN IMMEDIATE` 中完成 Conversation 状态检查、幂等检查、seq 分配、event 插入、state reducer、Turn lease 和 metadata 更新，然后一次提交。

同一个 `(conversation_id, idempotency_key)`：intent 相同返回原 event；intent 不同返回 `EVENT_CONFLICT`。两个 Runtime 写同一 Conversation 时仍由 SQLite 串行分配连续 seq。

`active_turns` 保存 turnId、owner epoch、PID 和进程启动标识。第二个不同 Turn 不能覆盖现有 lease；只有匹配 turnId 的 `turn/end` 能释放它。启动时只回收可证明 owner 已死亡的 lease：事务写入 `failed / RUNTIME_INTERRUPTED` 的 `turn/end` 后再精确删除。live owner 不按 TTL 回收。

## 6. 状态

Agent 私有工具 `update_conversation_state` 校验后写入 `state/set`、`state/clear`、`relation/cancel`、`relation/supersede` 或 `relation/confirm`。只有这些明确 event 能改变 `current_state`。取消或替代会停用旧状态；普通自然语言不会直接改状态。

## 7. Context 装配

`surface-v1` 从全部 events 重放现有 append/replace 语义，用于 Context 差分诊断。

`candidate-v1` 按以下顺序选择：

1. 全部有效 `current_state`，作为 mandatory message；
2. 当前 Turn 的全部 surface event；
3. 最近 8 条 surface event；
4. 精确匹配本 step path、error 或 ID 锚点的旧 surface event；
5. 与所选 tool call/result 配对的另一半。

当前 Turn 不做旧历史压缩。同一 Turn 先后读取两个文件时，下一 step 必须同时看到两次 assistant tool call 和两次 tool result。跨 Turn 后可不再携带旧文件全文；锚点重新出现时召回旧证据，但调用方仍重新读取当前文件。

如果 mandatory/current Turn 已超过预算，返回 `CONTEXT_BUDGET_EXCEEDED`；只移除未保护的旧历史，不拆开 tool 协议。每次构造保存 planId、source seq、token breakdown、evidence reason 和 history digest。

`recallHistory` 只读取指定 Conversation，返回原 event 和 source seq。MVP 允许它和 `surface-v1` 线性读取单会话历史；P100 超标后再增加投影，不提前设计第二套检索系统。

## 8. 初始化与生命周期

- Archive 在同一写事务中确认无 active Turn、追加 archive event 并改为 archived。
- Restore 检查无外部 tombstone，追加 restore event 并恢复 active。
- Delete 只允许 archived；在 `BEGIN IMMEDIATE` 内检查状态，原子写入版本目录外的 tombstone，然后 DELETE Conversation 并提交 SQLite 事务，外键级联删除 events 和投影。失败时数据库回滚；已写出的 tombstone 保留，启动时应用 guard 删除残留数据，不撤销 guard。
- 首次启动在新 version 中建立空 SQLite，完成 schema、metadata 和 integrity check 后原子发布 current。
- Context Store 不接收 legacy root，也不枚举、打开、解析或导入旧 JSONL、archive 和 `.deleted` 文件。
- stale 初始化锁只在 owner PID 已死亡、current 不存在且 journal 阶段可证明安全时回收；其他情况 fail closed。
- 当前没有通用 operation journal、新版本恢复发布或对象引用校验平台；不能把初始化 journal 或 tombstone 启动处理解释为这些能力已完成。

## 9. 错误

稳定错误码：`CONTEXT_STORE_NOT_READY`、`CONVERSATION_NOT_FOUND`、`CONVERSATION_BUSY`、`CONVERSATION_ARCHIVED`、`CONVERSATION_DELETED`、`EVENT_CONFLICT`、`STORE_VERSION_STALE`、`PROJECTION_UNAVAILABLE`、`CONTEXT_BUDGET_EXCEEDED`、`MIGRATION_FAILED`、`DATABASE_CORRUPT`。

Plugin load 失败时 Framework 使用 `PLUGIN_LOAD_FAILED`，同时保留 Store code 为 `causeCode`。

## 10. 验证

- 连续 seq、幂等冲突和跨 Runtime 写入；
- `surface-v1` replace、candidate 锚点、负例、预算和 tool closure；
- 同一 Turn 多文件工具累积、M3、M10、L20、O1；
- active Turn CAS、错误 end、dead owner 恢复和 archive 互斥；
- JSONL 诱饵被忽略、空库初始化、stale lock 和 tombstone 防复活；
- P100 同机性能门禁和 Q30 真实模型对照。

上列是验收范围，不代表全部完成。2026-10-22 复核：严格 Q30 尚缺 1/90 可评分结果；Agent 流式持久化与 Stop 收口仍有 P1 实现缺口，见 [Agent 集成](agent-plugin-integration.md) 和 [兼容性门禁](compatibility-and-regression.md)。本次只修订文档。
