# Agent Runtime 存储路径与会话写入总结

## 最终结论

Agent Plugin 已统一使用现有 `ctx.paths.data` 保存会话数据，完成按会话串行写入、跨实例锁和删除 tombstone/trash 语义；实现与验证证据均通过。

## 需求完成情况

- 新数据写入 `storage-v1/sessions`，不再依赖环境变量或 `~/.harbors/pi-agent`。
- 同一会话的追加、修复和删除共享独立队列，不同会话可并行。
- 删除将 JSONL 移入 `.harbors-trash`，并创建持久 `sessions/<id>.deleted` tombstone，阻止旧实例复活会话。
- 尾部 JSONL 可修复，中间损坏和路径/权限异常明确报错。

## 主要改动

- Plugin load 将已有 `ctx.paths.data` 传入 Agent 内部 Adapter；未新增 Context、路径注入或消息协议。
- 存储目录固定为 `storage-v1/sessions` 与 `storage-v1/.harbors-trash`，会话路径仅接受规范 UUID。
- 将全局写入队列收敛为 per-session queue，并保留跨进程文件锁。
- 删除流程使用队列与文件锁保护：先原子移动源 JSONL，再独占创建 tombstone；失败时回滚。

## 关键决定

- `ctx.paths.data` 是唯一数据根来源；旧家目录不自动发现、迁移或删除。
- `sessions/<id>.deleted` 是持久删除事实；后续读写通过磁盘 tombstone 返回 `SESSION_DELETED`，不会重新创建源文件。
- 活动会话删除返回 `CONVERSATION_ACTIVE`，不在存储任务中隐式取消 Turn 或请求。

## 验证结果

- Agent Plugin 测试：22/22 通过。
- Magnet build：通过。
- root build：通过。
- agent-chat kit build：通过。
- `ce-plugin check`：通过。
- `git diff --check`：通过。
- Web 验收：13/13 插件加载；新会话刷新后仍可见，删除后从列表消失；JSONL 仅写入 `runtime.paths.data`；删除后 source 不存在且 tombstone 与 trash 均存在；旧 `~/.harbors/pi-agent` 未写入。

## 影响与风险

- 旧家目录中的历史会话不会自动出现在新存储目录；导入或只读兼容需要单独设计。
- 本阶段只建立 tombstone 和 trash，不包含 trash 保留期限、容量清理、恢复 API 或恢复 UI。
- Plugin unload/reload、generation 隔离和 streaming cancellation 不属于本阶段。

## 偏差与遗留

- 原始范围包含生命周期清理、旧目录迁移和完整 trash 管理；设计确认后已收敛为 Agent Plugin 存储路径与并发/删除边界，超出部分保留为后续需求。
- 本阶段未修改 Framework 或其他 Plugin，符合既有 Plugin 边界。

## 后续关注

- 后续单独定义旧会话导入/只读兼容，以及 trash 的保留、清理和恢复策略。
- 另立生命周期任务处理 unload/reload、旧 runtime 引用和活动异步请求的完整收敛。

## 相关正式文档

- [Task 需求快照](./task.md)
