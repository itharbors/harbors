# 新增 Codex Subagent 并行委派 Skill

Task ID: `2026-08-15-routing-subagents-skill`
Type: `feature`

## 背景与问题

当前仓库缺少统一的 Subagent 委派规则。用户希望处理任何非琐碎工作时先拆清边界、尽可能并行交给 Codex CLI，并把主 Agent 限定为编排者和验收者。

## 目标

增加项目级 `delegate-codex-subagents` Skill，使 Agent 能用结构化 Brief 拆分任务、并行派发、强制写入边界并独立验收结果。

## 范围

- 新增项目级 Skill 元数据与工作流说明。
- 新增批量启动器，通过 `relay-alwaysday1` profile 固定使用 `auto_model/alwaysday1`。
- 支持多个 JSON Brief 并行派发互不冲突的子任务。
- 校验 Brief 字段、写入边界互斥性和结构化返回结果。
- 使用 macOS `sandbox-exec` 强制每个 Brief 的写入范围。
- 增加启动参数、并行执行、协议校验和 OS sandbox 的聚焦测试。

## 非目标

- 安装到用户级 Skill 目录。
- 自动执行发布、部署、合并、凭据操作或其他不可逆外部动作。
- 允许主 Agent 在 Subagent 失败后静默接管实现。
- 在缺少等价强制隔离能力的平台降级运行。

## 验收标准

- Skill 对所有非琐碎仓库任务给出明确的拆分、并行派发和主 Agent 验收规则。
- 启动器实际使用 `codex --profile relay-alwaysday1 --model auto_model/alwaysday1 exec`。
- 多个互不冲突的 Brief 能并发运行；重叠写入边界在启动前被拒绝。
- 每个进程只能写自己的 `allowed_changes`；越界写入被 OS sandbox 拒绝。
- Subagent 自报完成不会被表述为主 Agent 验收通过。
- Skill 校验、聚焦测试和真实模型 smoke 通过。

## 约束

- 主 Agent 只执行拆分、派发、监控、只读检查和独立验收，不亲自实现。
- Codex 内层 `danger-full-access` 只能在外层 `sandbox-exec` 包裹下使用，不能单独运行。
- Relay 认证必须读取本机认证源；普通 Brief 禁止凭据访问或修改。
- 并行任务必须具有互不重叠的文件边界和可独立执行的验收条件。

## 需求变更

- 初始讨论暂以可替换模型设计；用户随后明确要求固定使用 `auto_model/alwaysday1`，实现同步固定 `relay-alwaysday1` profile 和模型参数。
- 真实 smoke 发现 macOS sandbox 不能嵌套，最终改为外层 `sandbox-exec` 强制边界、Codex 内层 `danger-full-access`，并增加真实允许/拒绝集成测试。
