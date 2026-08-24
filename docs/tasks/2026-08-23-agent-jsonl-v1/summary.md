# Agent JSONL v1 Task 总结

## 最终结论

canonical JSONL v1、兼容读取/迁移、并发写入保护、append recovery、关键 sync barrier 和落盘后 listener 顺序已实现并通过目标范围验证；仓库级检查仍有与本次变更文件无交集的门禁阻塞/非目标失败。

## 需求完成情况

- canonical v1 envelope 与 `session_meta`、`turn_context`、`response_item`、`event_msg`、`compacted` record 闭集已实现。
- opaque `data`、`snapshot`、`delta` 保真；legacy 读取先投影为 `AgentTraceEvent` 再执行既有 normalize，首次写入执行 read-only 读取后的原子迁移。
- per-session queue、file lock、记录构造/冻结、ordinal 分配、尾部 append recovery、关键 sync 和持久化后 listener 顺序已实现。
- 格式校验与验收已纳入文件名 ID/header `conversation_id` 一致、response_item `item_id`、稳定关联、合法局部生命周期、completed snapshot、历史 seq 引用边界，以及从 canonical item 字段重建 `data.item`；singleton completed 与 EOF 未完成 started item 属于合法语义。
- record 分类已明确仅显式 `item/*` lifecycle 进入 response_item；`user/message`、`tool/call`、`tool/result`、`approval/asked`、`approval/resolved` 即使带 opaque `data.item` 仍为 event_msg。
- 当前没有持久后台 writer、显式 flush API 或 async shutdown 生命周期，按需求变更保持同步 stop 契约。

## 主要改动

- `jsonl-format` 实现 canonical 编解码、record 分类、API 投影、opaque 数据保留和 legacy 兼容。
- `harbors` 实现 per-session queue、file lock、迁移、append recovery、内存更新及 trace listener 调用顺序。
- 聚焦测试覆盖 envelope、生命周期、legacy 等价性、并发追加、锁/尾部恢复、损坏 fail-closed、删除和路径隔离。
- migration 规范明确临时文件完整写入并 file sync 后执行同目录 atomic rename；当前不含父目录 fsync。

## 关键决定

- 顶层 record type 是闭集；`payload.type` 只要求非空并原样保留，不作为事件类型闭集。
- response_item 分类只依据显式 `item/started`、`item/delta`、`item/completed` verb，不依据 opaque `data.item`。
- 记录在 queue 与 file lock 内构造并冻结；写入成功、内存更新后，listener 在锁释放前执行完毕。
- header、migration、`turn/end`、`approval/resolved` 等关键路径执行 sync barrier；不新增异步生命周期。
- migration 的当前保证是文件内容不会混合或半迁移，不宣称断电后目录项绝对持久；父目录 fsync 列为未来增强。

## 验证结果

- Agent Plugin：47/47 通过。
- Agent Chat assembly：6/6 通过。
- 目标 Plugin check：通过。
- Kit build：通过。
- `git diff --check`：通过。
- 无 UI 源码或共享可见交互变化，按测试指南未额外进行浏览器验收；assembly 已覆盖 request/broadcast 契约与重启恢复路径。

## 影响与风险

以下是与本次变更文件无交集的仓库级门禁阻塞/非目标失败现象；未在独立 main worktree 复跑：

- `host-security`、`kit-core`、`kit-cli` 缺少 vitest 声明。
- server 的 4 个既有 Kit/session/config 测试稳定失败。
- client 的 1 个既有 bootstrap 测试稳定失败。
- architecture boundary 报既有 `assembly.test.ts` 越界。
- build-clean 测试的既有清理断言失败。

## 偏差与遗留

- 底层 append/write/sync 故障注入尚未直接覆盖恢复的三个分支；当前由代码审查以及正常路径、前置失败路径覆盖。
- 当前没有持久后台 writer、显式 flush API 或 async shutdown 生命周期。
- migration rename 后没有父目录 fsync，因此不提供断电后目录项绝对持久保证；这是未来增强项。

## 后续关注

- 后续可补充底层 append/write/sync 故障注入，直接验证 recovery 三分支。
- 索引和压缩属于未来扩展，当前 JSONL 仍是唯一 source of truth。
- 如未来引入 flush 或 shutdown 生命周期，需先重新定义并验证与同步 `AgentAdapter.stop` 的契约边界。

## 相关正式文档

- [Agent JSONL v1 格式与持久化架构](../../architecture/agent-jsonl-format.md)
- [Agent JSONL v1 Task](./task.md)
