# 初始化与运行保障设计

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../../2026-10-22-agent-turn-durability/summary.md)。

## 1. 结论

Context Store 首次启动只创建空 SQLite。旧 JSONL、旧 archive 和旧删除标记即使存在，也不会被 Conversation、Agent 或 Context Store 枚举、打开、解析或导入。

已有 `current.json` 时只打开它指向的 SQLite。版本目录、锁和初始化 journal 负责空库的原子发布与该过程的崩溃恢复，不承担旧数据迁移或任意旧版本恢复。每 User + Plugin 一个 active Store，同 User 跨基础 Session 共享；Framework 绑定目录，Store 不自行选 User，也不回退旧无 User 路径。

## 2. 初始化链路

~~~text
storage-v2/
├── versions/<version-id>/
│   ├── context.sqlite
│   └── migration-journal.json
├── current.json
├── migration.lock
└── tombstones/<conversation-id>.json
~~~

首次启动按以下顺序执行：

1. 获取初始化锁；
2. 创建新的版本目录和 SQLite；
3. 建立 schema 与 store metadata；
4. 应用版本目录外的永久 tombstone guard；
5. 运行 `PRAGMA integrity_check`；
6. checkpoint WAL；
7. 原子写入 `current.json`；
8. 再次检查 active pointer 与数据库完整性；
9. journal 进入 `accepted` 并释放初始化锁。

整个链路不接收 legacy root，也不访问 `storage-v1`、`sessions/*.jsonl`、旧 archive 或旧 `.deleted` 文件；不创建 legacy quarantine 记录。

## 3. Framework 边界

Framework 负责通用 User、基础 Session、Plugin 身份及目录边界，Conversation schema 与生命周期属于 Store。旧无 User 数据不会自动读取、迁移或归属给当前 User；历史迁移操作不构成当前运行时回退能力。

Harness manifest 不再为 `agent-context-store` 声明 `legacyPluginDataDirectories`，Context Store 也不消费 `runtime.paths.legacyData`。因此即使通用迁移复制了旧 JSONL，它也不会进入 Conversation 运行链路。

## 4. 崩溃恢复

- `current.json` 已存在：只打开 active version，不重新初始化；
- lock owner PID 已死亡、current 不存在且遗留 journal 为可证明安全的 prepare、verified 或 failed 时：只回收 stale 初始化锁，保留旧未发布版本目录，再以新 version 重新初始化；当前不自动清理旧版本目录；
- lock owner 仍存活、journal 已 accepted，或状态无法证明安全：返回 `MIGRATION_FAILED`，不猜测、不创建第二个 active Store；
- current 指针与 SQLite metadata 的 version/epoch 不一致：返回 `STORE_VERSION_STALE`；
- integrity check 失败：返回 `DATABASE_CORRUPT` 或初始化失败，不降级为空库。

文件名 `migration-journal.json` 和错误码 `MIGRATION_FAILED` 为现有磁盘与错误协议兼容名；它们现在描述版本初始化/发布失败，不表示支持 JSONL 数据迁移。

## 5. Conversation 生命周期

### Archive

确认没有 active Turn，写入 archive event，并在同一数据库事务中把 Conversation 设为 archived。附件和产物目录保持原位。

### Restore

确认外部 tombstone 不存在，写 restore event，并恢复 active 状态。

### Delete

Delete 只允许 archived Conversation：

1. 开始 SQLite `BEGIN IMMEDIATE` 并确认 Conversation 已 archived；
2. 原子写入并持久化版本目录外的 tombstone；
3. 删除 SQLite 中的 Conversation，外键级联删除 events 和投影；
4. 提交 SQLite 事务；异常则回滚数据库。

tombstone 写入后不随数据库回滚撤销。当前启动会应用 guard 删除残留 Conversation，restoreConversation 也检查 guard；因此 tombstone 已落盘、DELETE 未提交的窗口通过下一次启动收敛。当前没有 operation journal，不保证任意故障点都立即呈现完整 archived 或完整 deleted，也没有旧版本恢复入口可据此验收。

## 6. 备份与恢复的边界

当前实现有空库初始化发布、active pointer 检查、SQLite integrity 检查和 tombstone 启动处理；数据库缺失或损坏不会静默创建空库覆盖原数据。当前不提供 JSONL 导入或导出接口。

一致快照备份、新版本恢复发布、跨对象引用校验若将来成为运维需求，需要另行明确范围和验收，均未在现行产品实现。本次不补建 operation journal 或恢复平台。2026-08-29 的一次性真实 data root 迁移及备份仅作为 [历史证据](../summary.md) 保留，不能证明当前具有通用恢复能力。旧 JSONL 是否保留或清理由独立授权决定。

## 7. 验证

- valid、invalid、archive JSONL 诱饵存在时，首次启动仍得到 0 Conversation 的空 SQLite；
- 不生成 legacy quarantine 记录，不修改诱饵文件；
- 重启继续使用同一 `current.json`，不会重新初始化；
- 两个 Runtime 并发 append 保持连续 seq，active Turn lease 互斥；
- stale 初始化锁只在可证明安全时回收；
- tombstone 在当前启动及 restoreConversation 路径阻止已删除 Conversation 复活；
- Agent 正式 Runtime 缺 Context Store 时 fail closed；
- Web 中新建、发送、刷新、归档、恢复和删除正常，控制台无新增错误。

这些是验证范围。历史执行结果见 [Task](../task.md)；2026-10-22 只读复核和本次文档修订不构成新一轮行为验收，流式及 Stop 实现缺口与严格 Q30 仍待闭环。
