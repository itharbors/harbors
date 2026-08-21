# Agent Runtime 存储与生命周期收敛

Task ID: `2026-08-21-agent-runtime-storage`
Type: `refactor`

## 背景与问题

Agent 会话数据目前需要从宿主运行时取得稳定的数据目录，但部分实现自行依赖家目录或固定路径；同一会话的 trace/状态写入也缺少明确的串行边界，多个会话的并发能力和故障恢复边界不清晰。会话删除、trash 保留和插件 unload/reload 的资源清理规则没有形成可验证契约，重启后可能残留旧 listener、活动请求或 runtime 引用。

## 目标

- 将新 Agent 会话数据统一写入 Framework 提供的 `runtime.paths.data`，并为既有目录提供可验证的迁移或只读兼容策略。
- 保证同一会话的事件/trace 写入严格串行，同时允许不同会话独立并发，避免丢事件、重复序列或损坏 JSONL。
- 明确会话删除的可恢复 trash 策略，包括保留时间、容量边界、恢复入口和清理时机。
- 完善 Agent Plugin unload/reload，清理活动请求、listener、订阅和旧 runtime 引用，确保重启后仅新实例接收事件。

## 范围

- Agent Plugin 内会话数据路径解析、旧路径兼容、trace/状态写入队列和删除流程。
- Agent Plugin 的 unload/reload、活动 Turn/工具请求、广播订阅及资源清理。
- 与上述行为直接相关的 Agent 聚焦测试、Kit 局部验证和必要的 Task 文档。
- 会话切换、删除、恢复、并发写入及插件重启的 Web 可见验收。

## 非目标

- 不在本 Task 中改造 Framework 的 runtime API、路径协议或宿主生命周期。
- 不实现 Agent Turn/Item 事件协议本身；关联键和事件生命周期由 `agent-turn-event-protocol` Task 负责。
- 不实现 Provider streaming、模型能力/ACL、工具 SSRF 或 workspace 安全修复。
- 不改变用户可见的会话产品功能、默认保留时长之外的业务语义或模型行为。
- 不在 Framework 边界外增加 Electron、桌面打包或原生窗口假设。

## 验收标准

- 新建会话及其 trace、状态和恢复数据均位于 `runtime.paths.data` 下，不再依赖未经宿主声明的家目录固定路径。
- 既有会话目录有明确的迁移或只读兼容方案；升级、读取失败和路径不可用时给出稳定错误，不能静默丢失历史。
- 同一会话的并发追加经过单一串行队列，序列不重复、不倒退、不丢失，进程异常不会留下可解析性损坏的半条 JSONL；不同会话可独立并发写入。
- 会话删除先进入可恢复 trash；实现并记录明确的保留时间、容量上限、清理触发条件和恢复规则，过期或超限清理不影响活动会话。
- unload/reload 会终止或标记活动请求，移除所有 listener/subscription，释放旧 runtime 引用；重启后旧实例不再接收广播，且新实例能继续读取会话。
- Web 验收覆盖新建会话、切换会话、并发写入、删除/恢复、插件重启和重启后继续对话；Agent Plugin 聚焦测试、构建和类型检查通过。
- 若任何验收需要修改 Framework 或超出 Agent Plugin/Kit 边界，必须停止实现并将该部分记录为阻塞，另建独立 Framework Task，不越界修改。
- 运行 `node scripts/task-status.mjs check 2026-08-21-agent-runtime-storage` 通过。

## 约束

- 仅通过现有 Framework runtime 能力获得数据路径和生命周期通知，不自行猜测宿主路径。
- 写入队列必须以会话为隔离单元，错误要可观察且不能静默丢弃后续写入；关闭时等待或明确终止队列。
- 删除操作必须可恢复，不能使用不可逆的递归删除作为正常路径；trash 清理范围必须由明确的会话目录解析结果确定。
- 旧会话兼容优先保证可读和可恢复，不要求无停机批量迁移所有历史文件。
- 变更严格位于 Agent Plugin/Agent Kit 相关边界；涉及 Framework 的需求按阻塞处理。

## 需求变更

- 原始审查中的运行时路径、按会话写队列、trash 策略和插件资源清理合并为本 Task。
- 由于 Framework 改动不在当前授权范围内，本 Task 增加“需要 Framework 即阻塞并另建 Task”的边界要求。
