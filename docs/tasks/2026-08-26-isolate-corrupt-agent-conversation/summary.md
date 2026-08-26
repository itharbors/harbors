# 损坏对话隔离与健康列表恢复实现总结

## 最终结论

Harness 已把单个损坏 Agent 会话从“拖垮整个对话列表”改为“只隔离该条目”。健康对话继续可见和可用，损坏对话以安全的不可用占位项展示且不能选择、重命名或归档；既有 JSONL 未被移动、删除、截断、重写或自动修复。

## 需求完成情况

- Agent Adapter 逐会话读取并隔离失败，健康项与不可用占位项可同时返回。
- 不可用公开摘要仅包含 namespaced ID、来源、安全标题、`availability` 与稳定 `errorCode`，不暴露路径、底层异常、消息、模型或工具结果。
- Conversation 只会初始化、选择和回退到可用会话；不可用项不进入 Chat 选择状态。
- Conversation 列表明确显示“数据损坏，暂不可用”，鼠标和键盘均不能激活该项，也不提供重命名或归档菜单。
- 损坏会话的直接读取与变更操作继续 fail closed；测试验证原始 bytes 与 mtime 不变。

## 主要改动

- `kits/harness/plugins/agent/main/**`：增加可用性摘要协议、逐条 `Promise.allSettled` 隔离、安全公开白名单与显式排序。
- `kits/harness/plugins/conversation/main/**`：消费可用性状态，并将初始化、创建后回退和归档后回退限制在健康项。
- `kits/harness/plugins/conversation/panel.list/**`：增加不可用状态样式、提示和完整交互禁用。
- Agent、Conversation Main 与 Conversation Panel 增加损坏共存、公开字段、回退和禁用行为测试。

## 关键决定

- 保持 canonical JSONL 的严格校验，不把损坏内容伪装成空会话或健康会话。
- 列表读取按会话隔离，损坏事实由 Agent 投影为最小安全摘要，Conversation 不接触磁盘或底层异常。
- 不可用项保留可见性以提示数据问题，但所有可能触发读取或变更的交互均关闭。

## 验证结果

- 聚焦测试：49/49 通过，覆盖 Agent Adapter、Agent 公开列表、Conversation Main 与列表 Panel。
- Harness 完整单元测试：293/293 通过。
- Runtime Plugin smoke：2/2 通过；真实 Assembly：10/10 通过。
- Harness build、Kit validate、Web Host smoke 与 `git diff --check` 通过。
- `pnpm run kits:check harness` 的默认 `execFile` 输出捕获在测试全部通过前后两次返回命令失败；使用同一 `runKitMatrix` 流程、仅将子进程输出改为继承后完整通过，确认不是产品或测试断言失败。
- 正常环境 `48381` 重建、重启并返回 HTTP 200；浏览器验收显示 4 个健康历史对话和 1 个“无法读取的对话 / 数据损坏，暂不可用”，不可用项为 disabled 且无更多操作菜单。
- 真实损坏 JSONL 在部署前后 SHA-256 均为 `44bd108e58a8fae8ac53bc654991b19768bcdb19edeec5cc924d20f72387dfb2`，mtime `1787724910`、大小 `12803249` bytes 均未变化。

## 影响与风险

- `blocking`：无。
- `non_blocking`：既有损坏会话仍保持原样并显式不可用；本 Task 不尝试推断或修复其事件内容。
- `non_blocking`：默认 Kit matrix 的子进程输出捕获会在 Harness 大量 TAP 输出时失败；继承输出的等价矩阵流程完整通过，后续可单独优化检查器输出策略。
- `decision_candidates`：无。

## 偏差与遗留

没有产品需求偏差。损坏 JSONL 的恢复或迁移属于独立、可审计的数据修复任务，不在本次自动执行。

## 后续关注

- 如需找回损坏会话中的可恢复内容，应单独建立任务，先复制证据再设计确定性修复与回滚方案。
- 可单独调整 Kit matrix 的输出捕获方式，避免测试量增长后触发非断言型失败。

## 决策闭环收口

### Decision Delta

- `Task-only`：不可用摘要字段、占位文案、排序和交互禁用限定在 Harness Agent 与 Conversation Plugin。
- `ADR`：无新增或修订。
- `architecture`：保持 Agent 拥有 JSONL 与诊断事实、Conversation 拥有列表选择协调的既有边界；严格 JSONL fail-closed 语义未改变。
- `guide`：无需要提升为仓库通用规则的增量。
- `candidate`：无。

### 正式落点

- 需求、数据保护边界和验证规则保留在本 Task 的 `task.md`、`.work/**` 与 `summary.md`。
- 产品实现和测试仅落在 `kits/harness/plugins/agent/**` 与 `kits/harness/plugins/conversation/**`。

### 反向检索验证

- 查询“损坏对话”“CONVERSATION_FILE_INVALID”“数据损坏，暂不可用”可命中本 Task 与实现。
- 未发现需要更新的既有 ADR、architecture 或 guide，也没有待批准的长期决策候选。

## 相关正式文档

- [Task 需求](task.md)
- [Task 状态](status.json)
