# Agent JSONL v1 格式与持久化机制重构

Task ID: `2026-08-23-agent-jsonl-v1`
Type: `refactor`

## 背景与问题

Agent Plugin 当前使用“首行 `version: 0` session header + 后续宽松 `type/seq/time/data` 事件”的 JSONL。虽然已有按会话队列、跨实例文件锁、尾部修复、删除 tombstone 和 Chat trace 重放，但磁盘格式没有正式的 schema 版本，事件 envelope 与 `data` 缺少稳定的结构约束，写入也没有明确的 canonical 持久化 barrier。

本 Task 参考 sibling Codex 项目的 rollout JSONL：采用稳定 envelope、tagged payload、ordinal、规范化 writer、兼容 reader 和显式持久化 barrier；同时保留 Harbors 已有的 `conversationId`、`turnId`、`itemId`、`requestId` 业务关联及现有 request/broadcast 边界。

## 目标

- 定义并实现 canonical JSONL v1：顶层统一为 `timestamp`、`ordinal`、`type`、`payload` 与可选 `metadata`。
- codec 定义的 envelope、关联键和结构字段统一使用 snake_case；用户、模型或工具提供的 opaque `data`、`snapshot`、`delta` 对象键原样保存。Agent 对外继续投影为现有 camelCase `AgentTraceEvent`，避免要求 Chat 同步重写或破坏工具参数。
- 将 record 收敛为少量稳定 tagged union，并保持 Item `started -> delta* -> completed` 生命周期及 completed snapshot 权威语义。
- reader 同时支持 legacy v0 与 canonical v1；writer 只写 canonical v1，不长期双写。
- 明确同步 append、关键路径 sync 与“落盘后广播”的顺序；关键终态建立可验证的 sync barrier。后台 flush 和 async shutdown 留作未来边界。
- 保留按会话串行、跨会话并行、跨实例锁、尾部修复、删除 tombstone/trash 等已有安全语义。
- 为后续可重建 byte-offset 索引、冷会话压缩和显式迁移保留边界，但不在本 Task 引入数据库或物理压缩。

## 范围

- `kits/agent-chat/plugins/agent/**`：JSONL 类型、codec、读写、兼容投影、持久化 barrier、错误恢复及聚焦测试。
- 必要的 Agent Chat Kit assembly 回归，验证持久化后 broadcast、历史分页和 Transcript 等价性。
- `docs/architecture/**` 中与 Agent JSONL 存储协议直接相关的中文文档。
- 本 Task 三份正式文件和 `.work/` 过程材料。

## 非目标

- 不修改 Framework、Server SQLite Session Store、Gateway 或其他 Kit。
- 不改变 Agent/Chat 对外 request 与 broadcast 名称，不要求 Chat 直接读取 JSONL。
- 不引入 SQLite 索引、zstd、分段 manifest、跨会话事务或 raw event 物理删除。
- 不重新设计 Provider streaming、工具权限、模型能力或 UI。
- 不扫描或自动迁移旧家目录；不在普通读取时隐式重写 legacy 文件。
- 不加入 Electron、桌面 IPC 或其他非 Web 宿主假设。
- 不引入持久后台 writer、显式 flush API 或异步 shutdown 生命周期；`AgentAdapter.stop` 保持现有同步接口。

## 格式约定

每行是一个完整 JSON object，并以单个换行结束。首行是 `session_meta`，其 `payload.schema_version` 固定为 `1`；后续 `ordinal` 在单会话内单调连续。

```jsonl
{"timestamp":"2026-08-23T10:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000000","created_at":"2026-08-23T10:00:00.000Z"}}
{"timestamp":"2026-08-23T10:00:01.000Z","ordinal":1,"type":"turn_context","payload":{"type":"turn/start","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1"}}}
```

稳定 record 类别至少覆盖：

- `session_meta`：文件头与会话元数据。
- `turn_context`：一次 Turn 的模型、沙箱、审批等上下文。
- `response_item`：仅显式 `item/started`、`item/delta`、`item/completed` lifecycle 的 message、reasoning、tool_call、tool_result、approval 快照。
- `event_msg`：Turn、请求、审批及其他控制事件；`user/message`、`tool/call`、`tool/result`、`approval/asked`、`approval/resolved` 即使 opaque `data.item` 存在也归此类。
- `compacted`：逻辑 compaction 及其引用范围。

`metadata` 只保存不决定 Transcript 语义的附加信息；业务关联键必须位于对应 payload 内。物理顺序由 `ordinal` 表达，业务因果继续使用四类既有 ID，不新增 parent 链。snake_case 约束只作用于 codec 自己定义的结构字段，不能递归改写 opaque 业务对象的 key。

格式校验还必须保证：文件名 ID 与 header/session_meta 的 `conversation_id` 一致；每条
`response_item` 带 `item_id`，同一 item 的关联字段稳定，且只接受 singleton completed、
`started -> delta* -> completed` 或文件 EOF 未完成的 `started -> delta*`；completed 必须
带 snapshot。`source_event_seqs`/`surface_op` 只能引用当前记录之前已存在的 seq；canonical
item 字段必须能在投影时重建 `data.item`。record 分类只依据显式 `item/*` lifecycle verb，
不依据 opaque `data.item`；业务 verb 即使携带该字段仍为 `event_msg`。

## 兼容与写入机制

1. v1 在读取层解码 canonical record，再投影为现有 `AgentTraceEvent`；legacy v0 先投影为 `AgentTraceEvent`，再执行既有 normalize（包括尾部/seq/reference 修复）；普通读取不回写原文件。
2. canonical v1 writer 在每会话队列和文件锁内构造并冻结待写记录、分配 ordinal 后再追加，失败重试不得重新编号。
3. append 成功后才能更新内存与 broadcast；header、migration、审批结果和 Turn 终态等关键路径经过 sync barrier。当前没有显式 flush 或 async shutdown 生命周期。
4. legacy migration 的临时文件必须完整写入并 file sync，再执行同目录 atomic rename；当前
   没有父目录 fsync，只保证文件内容不会混合或半迁移，不宣称断电后目录项绝对持久。
5. 尾部未完成行可在锁内截断；中间损坏不能被静默解释为完整 Transcript。
6. 未知 record 不得投影成成功内容；未知 schema version fail closed。
7. JSONL 是 source of truth；任何索引都必须可从 JSONL 重建且不能成为本 Task 的强依赖。

## 验收标准

- 新会话首行和后续事件符合 canonical v1 envelope，字段命名、ordinal 和 tagged payload 有聚焦测试。
- legacy v0 会话继续可列出、读取、分页并重建与改造前等价的 Transcript。
- Agent 对外 request/broadcast 继续返回现有 `AgentTraceEvent` 契约，Chat 无需直接理解磁盘格式。
- 文件名 ID 与 header conversation_id 不一致、response_item 缺少 item_id、item 生命周期或关联不稳定、completed 缺少 snapshot、未来 source/surface seq 引用均返回稳定错误；singleton completed 与 EOF 未完成 started item 通过合法语义校验。
- canonical response_item 投影从 item_id/item_kind/phase/snapshot/delta 重建 `data.item`，不依赖 opaque data 中恰好存在 item。
- 只有显式 `item/started`、`item/delta`、`item/completed` 分类为 response_item；`user/message`、`tool/call`、`tool/result`、`approval/asked`、`approval/resolved` 即使携带 opaque `data.item` 仍分类为 event_msg。
- legacy migration 验收临时文件完整写入并 file sync 后同目录 atomic rename，不出现混合或半迁移文件；不把缺少父目录 fsync 的实现描述为断电后目录项绝对持久。
- 同会话与跨实例并发追加不丢失、不重复、不倒序；不同会话仍可并行。
- append 失败不会产生提前 broadcast；当前 append 与关键 sync barrier 的成功和失败路径可测试。后台 flush/async shutdown 属未来边界和非目标。
- 尾部中断可恢复，中间损坏与未知 schema 返回稳定错误；一个损坏会话不会被静默隐藏。
- 删除、tombstone、trash、symlink fail-closed 与路径隔离的既有测试继续通过。
- Agent Plugin 聚焦测试、Agent Chat Kit assembly、目标 Plugin 构建/检查与 `git diff --check` 通过；共享可见行为如有变化，在 Web 宿主验收。

## 需求变更

- 按现有实现验收同步 append、header/migration/turn/end/approval-resolved 等关键路径的 sync barrier，以及持久化后才广播的顺序。
- 由于 `AgentAdapter.stop` 是同步契约，当前也没有持久后台 writer，因此不凭空增加异步 flush、显式 flush API 或 async shutdown 生命周期；这些属于未来需求，不作为本 Task 的完成条件。

## 约束

- 用户明确要求本 Task 从本地 `main` 切出；`refactor/agent-jsonl-v1` 已 fast-forward 到本地 `main` 的 `476d270`。
- 变更保持在 Agent Plugin、必要的 Agent Chat Kit 测试和正式文档边界内；若实现必须修改 Framework 或其他 Kit，先停止并请求用户确认。
- 文档默认使用中文，提交标题使用 `[Refactor]` 与简洁中文摘要。
