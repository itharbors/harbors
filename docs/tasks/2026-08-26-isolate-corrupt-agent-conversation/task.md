# 2026-08-26-isolate-corrupt-agent-conversation

Task ID: `2026-08-26-isolate-corrupt-agent-conversation`
Type: `bug`

## 背景与问题

正常环境升级到 `1f45410` 并重建 Harness 后，Conversation 活动列表为空。现场证据表明 Agent 私有存储仍有 5 个活动 JSONL，其中 `6cc17027-1cba-4065-9eef-7d72cdc1b8b6.jsonl` 因 `ITEM_AFTER_COMPLETED` 被严格读取器拒绝；`HarborsAdapter.listConversations()` 使用 `Promise.all`，导致单个损坏会话使整个 Adapter 列表失败，Agent 聚合层再把失败来源投影为空数组，最终隐藏了另外 4 个健康会话。

## 目标

- 单个损坏活动会话必须 fail closed，不能投影其消息或允许选择、执行、重命名、归档等操作。
- 同一存储根中的健康会话仍需出现在活动列表并可正常使用。
- 损坏会话不能被静默过滤；活动列表必须显示一个不泄露路径或底层异常的不可用占位项和可理解提示。
- 不移动、删除、截断、重写或自动修复任何现有用户 JSONL。

## 范围

- `kits/harness/plugins/agent/**`：让 Harbors Adapter 的列表读取按会话隔离失败，返回安全的不可用摘要；Agent 公开列表保留该状态。
- `kits/harness/plugins/conversation/**`：活动列表展示不可用摘要、禁用选择和菜单操作；Conversation 选择状态只在可用会话间回退。
- 本 Task 的 `task.md`、`status.json`、`.work/**` 与 `summary.md`。

## 非目标

- 不修复或迁移损坏 JSONL 的事件内容。
- 不降低 canonical JSONL 的 `ITEM_AFTER_COMPLETED`、未知 schema、ID 不一致等 fail-closed 校验。
- 不修改 Chat、Settings、Framework 或其他 Plugin。
- 不新增永久删除或批量清理入口。

## 验收标准

1. 一个合法 JSONL 与一个 `ITEM_AFTER_COMPLETED` JSONL 同时存在时，`listConversations` 返回合法会话和一个不可用摘要，不抛出导致整表为空的异常。
2. 不可用摘要只公开 namespaced ID、安全占位标题、`availability: "unavailable"` 和稳定 `errorCode`；不包含路径、原始异常、Transcript、lastMessage、模型配置或工具结果。
3. Conversation 列表明确显示不可用状态；该卡片不能选择、重命名或归档，键盘与鼠标行为一致。
4. Conversation 初始化和当前项回退只选择 `availability !== "unavailable"` 的健康会话；损坏项不能进入 Chat 选择状态。
5. 对损坏 JSONL 的直接读取、执行、重命名和归档继续返回稳定错误，原始 bytes 与 mtime 不变。
6. Agent 与 Conversation 的聚焦单元/组件测试、Harness build、Kit check 和浏览器验收通过；正常环境中 4 个健康历史对话重新可见，损坏对话显示为不可用且原始文件未变。

## 约束

- 仅支持 Web 宿主；共享可见行为必须通过浏览器验收。
- Agent 是 JSONL 和不可用诊断事实的 owner；Conversation 只消费安全摘要并管理列表/选择状态。
- Plugin 间继续使用现有 `agent.listConversations` request；新增字段必须向后兼容，不改变请求顺序或引入跨 Plugin 源码导入。
- 业务代码只修改 Agent 与 Conversation Plugin 目录，各自闭环实现并用公开摘要字段衔接。
- 用户已明确要求并行开发使用独立 worktree；本 Task 使用基于本地 `main` 的 bug worktree。此前也已明确本地交付采用 squash merge 并在合并后清理 worktree/分支。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- 仓库扫描命中 `docs/architecture/agent-jsonl-format.md`：中间损坏、未知 schema 与非法 item 生命周期必须 fail closed，且损坏会话不能被静默投影为“没有会话”。本修复保留严格解析，只隔离列表故障并显式投影不可用摘要。
- `docs/tasks/2026-08-21-agent-runtime-storage/task.md` 与 `docs/tasks/2026-08-23-agent-jsonl-v1/task.md` 同样要求列表不能静默过滤损坏会话，因此不能只 catch 后丢弃坏文件。
- `docs/tasks/2026-08-26-conversation-archive-settings/task.md` 规定 Agent 拥有持久化事实，Conversation 拥有列表与选择协调；本修复沿用该所有权。
- owner/reviewer/approver：主 Agent 负责方案、实现、复核和验证；当前用户是产品语义与交付 approver。本次不委派 sub-agent。

### 逐条处置与分工

- **严格 JSONL 校验**：适用并保持；Agent Adapter 不读取或投影损坏 Transcript。
- **列表不能静默隐藏损坏项**：适用；Agent 返回白名单不可用摘要，Conversation 显式渲染并禁用交互。
- **Plugin 所有权**：适用；Agent 生成诊断事实，Conversation 不直接访问磁盘。
- **原始数据修复策略**：不在本 Task 自动执行；用户 JSONL 保持原样，后续如需修复须单独设计可审计迁移。

### 过程关联

- Agent Adapter 测试证明健康与损坏条目并存、敏感信息白名单及原始文件不变。
- Conversation 组件与 Main 测试证明不可用项展示、禁用与选择回退。
- Harness 构建/检查与正常环境浏览器验收证明真实 4 个健康对话恢复可见。

## 需求变更

本 Task 未发生需求变更。
