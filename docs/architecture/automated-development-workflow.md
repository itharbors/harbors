# 自动化开发主流程

本文档描述 Harbors 中由主 Agent 编排、由干净 sub-agent 执行阶段工作的自动化开发主流程。
它是当前流程的架构投影；Task CLI 和 `status.json` 仍是机器状态的唯一事实来源，已接受 ADR
仍是决策约束的权威来源。

## 主流程

所有可交付变更统一经过以下五段主流程：

```text
定义任务 → 工作环境确认 → 执行计划 → 总结沉淀 → 交付处理
```

主流程状态只有一个，由主 Agent 按 Task CLI 推进。工作环境确认不是新的 Task stage；交付处理
也不写入 `status.json` 的 stage。五段主流程与既有五个内部 stages 的映射如下：

| 主流程 | 内部 stage 映射 | 主要职责 | 进入条件 |
| --- | --- | --- | --- |
| 定义任务 | `requirements` | 补全需求、范围、验收、约束和决策上下文，写入 `task.md` | 用户意图已明确到可以建档 |
| 工作环境确认 | 无新增 stage | 固定询问使用当前工作区，或基于本地 `main` HEAD 创建 worktree | `task.md` 已完成，`requirements` 为终态 |
| 执行计划 | `design`、`implementation`、`verification` | 依次完成计划、二次审查、实现、代码审查、验证、有限自动修复和重验 | 用户已选择工作环境 |
| 总结沉淀 | `consolidation` | 生成总结，提取 Decision Delta，分类发布并报告发现项 | 执行计划产物和验证证据齐全 |
| 交付处理 | 无新增 stage | 通过 ready gate 后等待用户选择 PR、本地整合或暂不处理 | 阻塞问题已解决，正式文件完整 |

`requirements`、`design`、`implementation`、`verification`、`consolidation` 的状态仍只有
Task CLI 定义的状态；主流程不会另建状态机、数据库或镜像字段。阶段重入使用现有 `rewind`，
不通过自由文本伪造状态。

## 角色与责任

主 Agent 是 owner 和唯一的外部编排者，负责读取 Task、选择工作单元、派发最小上下文、推进
状态、汇总结果和独立验收。干净 sub-agent 只负责收到的一个阶段工作单元，不创建 worktree、
不修改 `status.json`、不执行 push/PR/本地整合，也不宣布整个 Task 完成。reviewer 负责计划、
实现或证据审查；approver 只负责用户门禁和长期决策批准。

用户门禁固定出现在两个位置：Task 定义完成后选择当前工作区或 worktree；ready gate 通过后
选择交付路径。创建 worktree 只需要用户对该环境选择的明确确认，不推导出 push、PR、删除或
本地整合授权。

## 工作环境

`current` 允许当前已有分支或 linked worktree，保留已有 dirty；detached HEAD、无法读取 branch
或 HEAD 时拒绝。主 Agent 必须记录绝对路径、mode、实际 branch、HEAD、dirty 状态与文件数/范围，
并避免覆盖无关改动。`worktree` 路径以本地 `main` 的当前 HEAD 为基线创建隔离环境，并安全携带
已经完成的 Task 档案；转移后初始仅允许 Task 目录 dirty，随后按 StagePacket 的声明路径保护执行。
流程不要求先 fetch，也不把 `origin/main` 作为本地开发或本地整合的强制基线。远端分支事实只在
用户明确选择 push 或 PR 后校验。

## 阶段通信契约

主 Agent 发给干净 sub-agent 的输入是最小 `StagePacket`，其可执行字段契约以 [change-workflow
protocol reference](../../.agents/skills/change-workflow/references/protocol.md) 为准，至少包含：

- `protocol_version`、`task`、内部 `stage` 和 `work_unit`；
- `objective`、`workspace`、`allowed_paths`、`inputs`；
- `acceptance`、`stop_conditions`，以及不得执行的外部动作。

sub-agent 返回结构化 `StageResult`，至少包含：

- `protocol_version`、`task_id`、`stage`、`work_unit` 和 `outcome`；
- `recommendation`、`artifacts`、`evidence`、`issues`；
- `decision_candidates`、`follow_up` 和 `next_action`。

结果是主 Agent 推进状态和编排下一工作单元的输入，不是对全局完成的声明。协议的字段、停止
条件和示例以 [开发工作流](../guides/development-workflow.md) 为操作入口。

### 字段契约

| 契约 | 必填字段 | 禁止事项 |
| --- | --- | --- |
| `StagePacket` | `protocol_version`、`task`、`stage`、`work_unit`、`objective`、`workspace`、`allowed_paths`、`inputs`、`acceptance`、`stop_conditions` | 不携带无关会话历史；不授予环境创建、状态写入或交付权限 |
| `StageResult` | `protocol_version`、`task_id`、`stage`、`work_unit`、`outcome`、`recommendation`、`artifacts`、`evidence`、`issues`、`decision_candidates`、`follow_up`、`next_action` | 不宣称整个 Task 完成；不把推断当验证证据；不隐式批准决策 |

其中 `outcome` 只能是 `completed`、`needs_repair`、`blocked` 或 `not_applicable`；主 Agent 根据
结果和独立验收决定是否推进、重派、重入或请求用户处理。`artifacts`、`evidence` 和 `issues`
必须使用路径、命令、结果和阻塞性组成可复核证据。`issues.category` 只能是 `blocking` 或
`non_blocking`；`decision_candidates` 不等于 accepted 决策。

## 执行计划内循环

执行计划至少按以下顺序调度：

1. 计划：将需求拆成可独立验收的工作单元，明确文件边界和验证策略。
2. 二次审查：由独立 reviewer 检查计划、决策约束、边界和风险；实质性意见先回到计划。
3. 实现：由干净 sub-agent 在允许路径内实现工作单元。
4. 代码审查：检查 diff、消息顺序、兼容性和测试归属；必要时回到实现。
5. 验证：按 Plugin、Kit、Framework 边界运行针对性检查，并保留证据。
6. 有限自动修复与重验：仅处理验证证据明确指向、范围内且可逆的修复；每轮都重新验证，
   达到停止条件仍失败时标记 `blocking` 并交还用户。

这些动作仍归入 `design`、`implementation`、`verification` 三个内部 stages，不产生额外
机器状态。

## 总结沉淀与发现项

总结阶段自动从需求变化、用户决定、实现 diff、评审意见和验证证据提取 Decision Delta，并
写入 `summary.md` 或相应的正式 architecture、guide、ADR。自动提取只产生候选和分类建议，
不等于自动批准；ADR 进入 `accepted` 仍需要 approver 明确批准和发布。

每次总结必须显式输出四类发现项：

| 类别 | 含义 | 对自动收口的影响 |
| --- | --- | --- |
| `blocking` | 阻止继续、验证或 ready gate 的事实问题 | 必须解决或由用户处理 |
| `non_blocking` | 不影响本次收口的风险、缺口或观察项 | 不阻止自动收口，但必须报告 |
| `decision_candidates` | 可能需要长期批准的方案或冲突 | 不自动升级为 accepted |
| `follow_up` | 建议后续任务处理的事项 | 不阻止自动收口，保留来源 |

`blocking` 为空且正式文件、验证和反向检索满足要求时，主 Agent 才能进入 ready gate；其余
三类即使存在也必须随最终报告交给用户。

## 交付边界

ready gate 通过后，主 Agent 停止并询问用户选择：创建 PR、本地整合到 `main` 或暂不处理。
每条路径都需要独立授权；“完成”不授权 push、PR、merge、删除分支或删除 worktree。远端事实
校验仅服务于用户已选择的 push/PR 路径；本地整合只依赖本地 `main` 与源 worktree 的清洁、
冲突预检和明确策略。

## 相关文档

- [开发工作流](../guides/development-workflow.md)
- [Task 档案](../tasks/README.md)
- [决策反馈闭环](../guides/decision-feedback-loop.md)
- [ADR 0004：自动化开发主流程](../decisions/0004-automated-development-workflow.md)
