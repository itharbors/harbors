# 阶段通信协议

主 Agent 与干净 sub-agent 之间只传递当前 work unit 所需的最小消息。消息可以使用 JSON 或等价结构化对象表达；字段名和枚举保持一致，便于审查和重入。

## StagePacket（主 Agent → sub-agent）

必填字段：

| 字段 | 约束 |
| --- | --- |
| `protocol_version` | 固定为 `1` |
| `task` | `{task_id, type, task_dir}`；`task_id` 是唯一 Task，`task_dir` 是绝对路径 |
| `stage` | 现有 stage 之一：`design`、`implementation`、`verification`、`consolidation` |
| `work_unit` | `plan`、`review`、`implementation`、`code-review`、`verification`、`repair`、`summary`、`knowledge-extraction`、`retrieval-review` 之一 |
| `objective` | 当前 work unit 的单一目标 |
| `workspace` | `{path, mode, branch, base_commit, dirty_policy}`；`mode` 为 `current` 或 `worktree` |
| `allowed_paths` | 允许读取/修改的精确路径或窄目录；空数组表示只读 |
| `inputs` | 完成目标所需的事实、文件、前序结果或命令输出；不得放入完整会话记录 |
| `acceptance` | 可独立核验的完成条件和命令 |
| `stop_conditions` | 必须停止并返回主 Agent 的条件，包括越界、缺少授权、不可重现或发现阻塞 |

`workspace.dirty_policy` 必须明确是 `preserve`、`clean-required` 或 `read-only`。worktree 在转移尚未提交的 Task 时必须先使用 `preserve`，且只允许 Task 文件和 packet 声明的路径处于 dirty；完成首个纳入 Task 正式文件的提交后，主 Agent 才能将后续 work unit 切换为 `clean-required`。不得由 sub-agent 自行改变策略。

示例：

```json
{
  "protocol_version": 1,
  "task": {"task_id": "2026-08-24-safe-login", "type": "feature", "task_dir": "/repo/docs/tasks/2026-08-24-safe-login"},
  "stage": "implementation",
  "work_unit": "implementation",
  "objective": "实现登录令牌的过期校验",
  "workspace": {"path": "/repo", "mode": "current", "branch": "main", "base_commit": "abc123", "dirty_policy": "preserve"},
  "allowed_paths": ["packages/auth/src", "packages/auth/test"],
  "inputs": ["task.md", "design.md"],
  "acceptance": ["目标包测试通过", "diff 只位于允许路径"],
  "stop_conditions": ["需要修改允许路径之外的文件", "发现安全决策尚未获批"]
}
```

## StageResult（sub-agent → 主 Agent）

必填字段：`protocol_version`、`task_id`、`stage`、`work_unit`、`outcome`、`recommendation`、`artifacts`、`evidence`、`issues`、`decision_candidates`、`follow_up`、`next_action`。

- `outcome` 只能是 `completed`、`needs_repair`、`blocked` 或 `not_applicable`。`not_applicable` 仅在 Task 范围和验收证据证明当前 work unit 不适用时合法；不能用来表示未运行、工具不可用、缺少输入或暂时失败。sub-agent 只能返回该建议，主 Agent 必须独立检查证据，并通过 Task CLI 明确 skip，不能因该值自动推进后续状态。
- `recommendation` 是给主 Agent 的短结论，不是状态转换请求。
- `artifacts` 是 `{path, kind, description}` 数组；路径必须在 packet 的允许范围内，或明确标记为只读输入。
- `evidence` 是 `{command, result, status}` 数组；`status` 只能是 `passed`、`failed`、`not_run`。
- `issues` 是 `{category, summary, evidence}` 数组；`category` 是唯一的阻塞判断来源，只能为 `blocking` 或 `non_blocking`。不要添加冗余的 `blocking` 布尔值，也不能把风险藏在自由文本中。
- `decision_candidates` 是 `{question, options, recommendation, rationale, approver}` 数组；候选不等于 accepted 决策。
- `follow_up` 是 `{action, owner, rationale, due_or_trigger}` 数组；记录后续建议或另一个 Task，不得把未授权动作自动执行。
- `next_action` 只描述主 Agent 下一步应调度或询问的动作，不执行该动作。

```json
{
  "protocol_version": 1,
  "task_id": "2026-08-24-safe-login",
  "stage": "verification",
  "work_unit": "verification",
  "outcome": "completed",
  "recommendation": "目标包测试和静态检查均通过",
  "artifacts": [{"path": "packages/auth/test/token.test.ts", "kind": "test", "description": "令牌过期回归测试"}],
  "evidence": [{"command": "pnpm test --filter auth", "result": "12 passed", "status": "passed"}],
  "issues": [],
  "decision_candidates": [],
  "follow_up": [],
  "next_action": "主 Agent 汇总结果并进入 consolidation"
}
```

sub-agent 不得修改 `status.json`、创建/删除分支或 worktree、push、创建/更新 PR、运行本地整合、代替用户批准决策，或宣布整个 Task 完成。主 Agent 必须检查返回值与实际 diff 后，才可用 Task CLI 推进唯一的现有 stage。
