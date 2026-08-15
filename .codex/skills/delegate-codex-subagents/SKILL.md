---
name: delegate-codex-subagents
description: 在当前仓库处理任何非琐碎工作时使用。先把工作拆成边界明确、可独立验收的原子子任务，尽可能并行交给使用固定 Codex CLI 模型的 Subagent；主 Agent 只负责拆分、派发、监控、整合判断和验收，不亲自实现。适用于功能、修复、重构、测试、文档、调研、审查和混合任务。
---

# Codex Subagent 并行委派

## 坚持职责边界

把主 Agent 限定为编排者和验收者：理解目标、拆分边界、安排依赖、派发任务、监控结果、验证证据并决定是否通过。不得由主 Agent 编写实现、测试或文档，也不得在 Subagent 失败后静默接管。

允许主 Agent 执行只读检查和验收命令。若任务无法安全委派，报告阻塞条件并请求用户决策。

以下内容不得委派后自动执行：发布、部署、合并、凭据操作、权限扩大、外部消息和不可逆动作。只有用户明确授权时才能把它们放入 Brief。

## 拆分原子任务

先画出依赖关系，再把工作拆成满足以下条件的最小任务：

- 只有一个可验证目标。
- 上下文可由 Brief 独立表达。
- 写入范围使用精确文件或窄目录，且不与并行任务重叠。
- 验收命令和禁止事项明确。
- 不依赖另一个并行任务尚未产生的结果。

把有依赖的任务分批执行；每一批内尽可能并行。不要为了增加并发而切出无法独立验收的碎片。

## 编写 Brief

为每个子任务创建一个 UTF-8 JSON 文件：

```json
{
  "task_id": "稳定且唯一的任务标识",
  "mode": "execute|review",
  "objective": "一个明确结果",
  "context": ["完成任务必需的事实、路径和约束"],
  "allowed_changes": ["精确文件或窄目录"],
  "acceptance_checks": ["主 Agent 可复核的命令或检查"],
  "prohibitions": ["不得触碰的内容或动作"]
}
```

`execute` 必须填写 `allowed_changes`、`acceptance_checks` 和 `prohibitions`。`review` 必须保持 `allowed_changes` 为空。Brief 只放完成该任务所需的最小上下文，不复制完整对话。

## 并行派发

一批任务使用一次启动器调用，并重复传入 `--brief`：

```bash
python3 .agents/skills/delegate-codex-subagents/scripts/run_subagents.py \
  --workdir /absolute/path/to/worktree \
  --brief /absolute/path/task-a.json \
  --brief /absolute/path/task-b.json
```

启动器通过 `relay-alwaysday1` profile 固定使用 `auto_model/alwaysday1`，默认最多同时运行 4 个任务。每个 Codex 进程都由 macOS `sandbox-exec` 包裹，只能写自己的 `allowed_changes` 与必要运行时目录；Codex 内层使用 `danger-full-access` 是为了避免 macOS sandbox 嵌套失败，不能脱离外层 sandbox 单独运行。启动器还会在批次前后核对 Git 工作区，任何超出整批边界的实际变更都会返回 `policy_error`。运行环境缺少 `/usr/bin/sandbox-exec` 时必须报告 blocker，不得降级为无隔离执行。

Relay 认证仍必须由 Codex 进程读取本机认证源。不得在 Brief 中要求读取、输出或修改任何凭据；若任务本身需要凭据操作，停止委派并请求用户明确授权。

每批结束后读取精简 JSON 结果。顶层 `completed` 只表示 Subagent 执行成功，不表示主 Agent 已验收；结果中的 `validation_required` 会保持为 `true`。若某个 Subagent 阻塞或失败，优先缩小问题、补充 Brief 或重新派发；不得由主 Agent 直接实现。

## 只做验收

主 Agent 对每个结果执行以下验收：

1. 检查实际变更是否全部位于 `allowed_changes`。
2. 独立运行 `acceptance_checks`，不接受 Subagent 的自报结果作为唯一证据。
3. 检查并行任务之间的接口、命名和行为是否一致。
4. 检查用户既有改动没有被覆盖或还原。
5. 对失败项创建修复 Brief，再次委派并验收。

只有所有任务都通过独立验收后，主 Agent 才能汇总交付。最终说明派发范围、实际验证和残余风险。
