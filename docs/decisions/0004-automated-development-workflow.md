# ADR 0004：采用自动化开发主流程与阶段通信契约

- 状态：已接受
- 日期：2026-08-24
- 决策者：项目维护者
- 批准者：需求发起人（本次流程决策批准者）
- 批准日期：2026-08-24
- 批准范围：自动化开发主流程、工作环境选择顺序、阶段编排和总结输出契约
- 排除范围：push、PR、merge、发布、删除分支或 worktree 的授权；Plugin、Kit、Framework 业务行为
- 来源 Task：[2026-08-24-automated-development-workflow](../tasks/2026-08-24-automated-development-workflow/task.md)

## 上下文

原有流程把需求、Task、设计、实现、验证和交付混为一个连续流程，并固定以远端 `origin/main`
作为启动基线。这样会让主 Agent 承担过多阶段细节，也会在本地 `main` 已领先远端时阻止本地
开发。现有 Task CLI 已有 `requirements`、`design`、`implementation`、`verification`、
`consolidation` 五个内部 stages；需要的是一层清晰的外部编排，而不是第二套机器状态。

## 决策

1. 采用“定义任务 → 工作环境确认 → 执行计划 → 总结沉淀 → 交付处理”五段主流程。
2. Task 定义完成后固定询问使用 `current <task-id>` 或 `worktree <task-id>`；`current` 允许
   当前已有分支或 linked worktree 并保留 dirty，但拒绝 detached HEAD。`worktree` 基于本地
   `main` HEAD 创建，转移未提交 Task 后初始只允许 Task 档案 dirty。两种模式都记录实际路径、
   branch、HEAD、dirty 状态与文件数/范围；worktree 选择不推导出任何远端或交付授权，执行计划
   之后按 StagePacket 声明的 `allowed_paths` 保护修改边界。
3. 执行计划统一覆盖计划、二次审查、实现、代码审查、验证、有限自动修复和重验，并映射到
   既有 `design`、`implementation`、`verification` stages。
4. 主 Agent 独占状态推进和外部编排；干净 sub-agent 通过最小 `StagePacket` 接收单一工作单元，
   返回结构化 `StageResult`，不得修改 `status.json` 或执行交付动作。
5. 总结沉淀默认自动执行，必须输出 `blocking`、`non_blocking`、`decision_candidates`、
   `follow_up` 四类发现项。自动提取不等于自动批准；长期决策仍须 approver 人工批准。
6. 本地开发和本地整合以本地 `main` 事实为准；`origin/main` 仅在用户明确选择的 push/PR
   路径中作为远端事实校验，不是强制本地基线。

## 替代方案

### 继续使用旧的线性流程

未采用：把主流程和内部阶段混在一起，迫使所有执行者加载无关细节，并使工作环境选择过晚或
与 Task 建档耦合。

### 为每个阶段建立独立状态机

未采用：会复制 Task CLI 的五个 stages，产生状态同步和恢复歧义。主流程只作为编排和说明层，
机器状态仍由 `status.json` 唯一记录。

### 固定从 `origin/main` 启动

未采用：远端可能不可用、落后或与本地 `main` 不同；本地开发不应被远端同步状态强制阻止。
远端校验保留在 push/PR 的明确授权边界内。

### 自动把提取结果升级为 accepted

未采用：模型或工具提取的候选不具备批准权，会把未裁定方案变成长久约束。

## 影响

### 正面影响

- 任务先完成需求快照，再由用户选择工作环境，减少隐含环境变更。
- 主 Agent 只需掌握统一编排、状态和协议，阶段 sub-agent 可以按最小上下文独立执行。
- 计划、审查、实现、验证和有限修复形成可重入闭环；总结问题分类明确且可自动报告。
- 本地 `main` 领先远端时仍可继续本地开发和整合。

### 负面影响与约束

- 主 Agent 必须维护 StagePacket/StageResult 的边界并独立验收结果。
- 自动修复有范围和轮次限制，无法安全修复时必须阻塞并交还用户。
- 总结提取增加文档整理工作；候选仍需人工裁定，不能把自动化当作批准流程。
- push、PR 和本地整合继续是独立的用户授权动作。

## 与 ADR 0003 的关系

本 ADR 不取代 ADR 0003。ADR 0003 规定决策反馈闭环如何嵌入五个既有 Task stages；本 ADR 规定
这些 stages 之上的外部主流程、工作环境门禁、sub-agent 通信和总结发现项。两者共同约束时，
仍以五个内部 stages 为唯一机器生命周期，沿用 Decision Context、Decision Compliance、
Decision Delta 和 Retrieval Verification。若新流程与闭环记录要求冲突，应回到 design 并由
approver 裁定，不静默绕过 ADR 0003。

## 角色反馈与批准边界

- 角色反馈：本 Task 中关于主流程、阶段协议和本地基线的用户决定已纳入本 ADR；后续 reviewer
  意见仍需单独记录，反馈本身不扩大批准范围。
- 批准者：需求发起人或项目维护者明确批准本 ADR 的流程条目。
- 批准范围：仅覆盖本 ADR“决策”列出的流程和边界，不包含任何远端写入或交付授权。
- 待批准事项：具体工具实现、自动修复策略细节、未来发布平台集成留在对应 Task 或另行 ADR。

## 关联

- [自动化开发主流程](../architecture/automated-development-workflow.md)
- [开发工作流](../guides/development-workflow.md)
- [Task 档案](../tasks/README.md)
- [决策反馈闭环](../guides/decision-feedback-loop.md)
- [ADR 0003：决策反馈闭环](./0003-decision-feedback-loop.md)
- [架构决策记录](./README.md)
