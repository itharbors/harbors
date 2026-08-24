---
name: change-workflow
description: 在 Harbors 仓库启动、继续、收口和交付 feature、bug、docs、refactor、optimize、test 或 maintenance 任务；当请求涉及 Task、工作区、worktree、分支、验证或本地整合时使用。不要用于 release 分支或仓库外工作。
---

# Harbors Change Workflow

这是一个主流程 Skill。不要把 `references/` 拆成可独立路由的阶段 Skill；它们是只在当前阶段需要时读取的操作契约。主 Agent 负责外部编排、Task 状态和授权，干净 sub-agent 只负责收到的一个阶段工作单元。

## 主流程

严格按以下顺序推进，不把阶段内部步骤变成第二套状态机：

1. **定义任务**：确认背景、目标、范围、非目标、验收标准、约束、类型和角色，创建或补全唯一 Task。需求字段覆盖：背景、目标、范围、非目标、验收、约束。定义完成后将 `requirements` 标记为 `completed`，其余现有 stages 保持 `pending`。
2. **工作环境确认**：Task 定义完成后，固定向用户询问使用 `current` 当前工作区，还是 `worktree` 独立 worktree；在得到选择前不得进入执行计划、创建分支或 worktree。选择规则见 [environment-selection.md](references/environment-selection.md)。
   工作环境确认必须在 Task 定义后进行，不能提前隐式选择。
3. **执行计划**：按计划、二次审查、实现、代码审查、验证、有限自动修复和重验推进。它只映射现有 `design`、`implementation`、`verification` 三个 Task stages，不新增状态。细节见 [execution-plan.md](references/execution-plan.md)。
4. **总结沉淀**：默认自动执行，从需求变化、用户决定、实现 diff、评审和验证提取 Decision Delta，写入 `summary.md` 并分类报告 `blocking`、`non_blocking`、`decision_candidates`、`follow_up`。阻塞项阻止 ready，其余项不阻止自动收口；accepted 决策仍需 approver 明确批准。细节见 [consolidation.md](references/consolidation.md)。
5. **交付处理**：完成现有 ready gate 后停止并向用户提供下一步选择：A 创建 PR；B 整合到本地 `main`；C 暂不处理。A 分别需要 push 和 `gh` 创建/更新 PR 的明确授权；B 需要用户选择 `ff`、merge commit 或 squash 并分别授权。交付脚本不 push、不创建 PR、不删除分支或 worktree、不自动解决冲突。

主流程与现有五个 Task stages 的映射是：定义任务→`requirements`；工作环境确认→不新增 stage；执行计划→`design`、`implementation`、`verification`；总结沉淀→`consolidation`；交付处理→ready gate 之后。不得建立独立于 `requirements`、`design`、`implementation`、`verification`、`consolidation` 的机器状态。

## 调度和所有权

- 主 Agent 独占 `status.json` 的状态推进、用户门禁、环境创建/选择、ready gate、交付授权和最终完成声明。只能通过 Task CLI 修改 `status.json`，不把原因、风险或交接文本写入 status。
- 阶段 sub-agent 通过最小 `StagePacket` 接收上下文，并返回结构化 `StageResult`；协议见 [protocol.md](references/protocol.md)。sub-agent 不创建环境、不改 `status.json`、不执行交付、不宣布整个 Task 完成。
- 每次委派只发送当前 work unit 所需的 Task/stage、目标、工作区事实、允许路径、必要输入、验收和停止条件；不要转发完整会话或无关历史。
- 主 Agent 必须独立检查 sub-agent 的实际 diff 和验证证据，再推进状态。失败按 `blocking` 处理；有限自动修复只允许在执行计划内重试并重验，不能绕过人工门禁。

## 重入和安全边界

恢复任务先读 `task.md`、`status.json`，再按需读 `.work/` 记录和本 Skill references，最后核对 Git 状态；不要猜测或重做已完成阶段。用户说“完成”不授权创建 worktree/分支、push、创建或更新 PR，亦不授权整合到 `main`。

环境启动唯一使用 `current <task-id>` 或 `worktree <task-id>`。创建 worktree 应基于本地 `main` HEAD，不能把 `origin/main` 当作强制开发基线；当前工作区路径须保留用户已有改动。整合使用 `scripts/integrate-change.sh`，仍须 clean、ready、冲突预检和显式授权：ff 不传标题；merge commit 与 squash 都必须提供合法标签和中文提交标题。

本 Skill 不负责 release 分支、远端事实以外的猜测、自动 push/PR、删除分支或 worktree，且不修改 Plugin、Kit、Framework 的业务行为或消息协议。

兼容收口契约：完成 `summary.md` 后必须停止；分别获得 push 和 `gh` 的授权；用户说“完成”不授权任何远端或 main 整合动作。
