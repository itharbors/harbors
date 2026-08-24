# 2026-08-24-automated-development-workflow

Task ID: `2026-08-24-automated-development-workflow`
Type: `feature`

## 背景与问题

现有开发工作流把需求确认、Task 建档、设计、实现、验证、收口和交付写成连续步骤，但主流程与节点内部流程混杂，导致主 Agent 需要持续加载过多细节，也会在本地可逆动作与真正需要用户决定的动作之间产生过多确认。现有启动脚本还固定从 `origin/main` 创建工作分支，而本仓库的本地 `main` 可能显著领先远端。

本 Task 将流程改为“定义任务 → 工作环境确认 → 执行计划 → 总结沉淀 → 交付处理”。定义任务先形成完整 Task；随后由用户选择当前工作区或独立 worktree。主 Agent 只负责外部编排，阶段工作由接收最小上下文的干净 sub-agent 完成；总结沉淀自动执行，并把阻塞问题、非阻塞问题和决策候选明确反馈给用户。

## 目标

1. 将任务定义与工作环境启动解耦，Task 定义完成后再询问是否创建 worktree。
2. 将计划、实现、审查、验证和自动修复统一为“执行计划”流程。
3. 让主 Agent 只加载主流程、阶段状态和统一通信协议，阶段 sub-agent 通过最小 `StagePacket` 独立执行并返回结构化 `StageResult`。
4. 自动执行总结沉淀，分类发布知识增量并向用户输出发现的问题。
5. 支持用户选择当前工作区或基于本地 `main` HEAD 的独立 worktree，不再把 `origin/main` 作为本地开发的强制基线。

## 范围

- 重构仓库级 `change-workflow` Skill，定义主流程、阶段调度、用户门禁和重入规则。
- 按实际需要新增阶段 Skill 或按阶段延迟加载的 reference，使干净 sub-agent 不需要完整会话上下文。
- 定义 `StagePacket`、`StageResult` 以及总结沉淀的问题输出契约。
- 调整启动与本地整合脚本，使本地开发基线和本地整合不再强制依赖 `origin/main`。
- 更新对应 Skill 测试、开发工作流、Task 规范、测试指南、决策闭环指南、架构文档和 ADR 索引。
- 维护本 Task 的 `task.md`、`status.json` 和 `summary.md`。

## 非目标

- 不自动执行 push、创建或更新 PR、发布、删除分支或删除 worktree。
- 不自动批准新的长期架构决策。
- 不建立独立于现有 `requirements`、`design`、`implementation`、`verification`、`consolidation` 的第二套机器状态。
- 不修改 Plugin、Kit、Framework 的业务行为或消息协议。
- 不要求所有任务都创建 worktree；工作环境由用户在 Task 定义完成后选择。

## 验收标准

1. 主流程明确为“定义任务 → 工作环境确认 → 执行计划 → 总结沉淀 → 交付处理”，并说明与现有五个 Task stages 的映射。
2. Task 定义在工作环境选择之前完成；进入执行计划前固定询问使用当前工作区还是创建 worktree。
3. 选择 worktree 时基于本地 `main` HEAD；选择当前工作区时保留用户已有改动，不强制创建分支或 worktree。
4. “执行计划”内部覆盖计划、二次审查、实现、代码审查、验证、有限自动修复和重验。
5. 主 Agent 与干净 sub-agent 使用明确的最小输入和结构化结果协议，阶段状态仍由主 Agent 统一推进。
6. 总结沉淀能够从需求变化、用户决定、实现 diff、评审和验证中提取知识增量，分类到 ADR、architecture、guide、Task-only 或 candidate。
7. 总结阶段固定输出阻塞问题、非阻塞问题、决策候选和后续建议；非阻塞问题不阻止自动收口。
8. 本地开发和本地整合不因 `origin/main` 缺失或落后而失败；push/PR 路径仍保留远端事实校验和独立授权。
9. Skill、脚本、文档和测试通过针对性验证，Task 通过普通 check 和 ready gate。

## 约束

- 用户已明确选择本次直接在本地 `main` 工作区修改，不创建分支或 worktree；该授权不包含 push、PR 或任何远端操作。
- `status.json` 只通过 Task CLI 修改，只记录客观阶段状态。
- 仓库已接受 ADR 是长期决策约束权威，源码和测试是实现事实权威，architecture/guide 是正式投影。
- 外部决策记忆查询未命中，且 `freshness=partial`、`failed_files=1`；因此继续以仓库 Markdown 定向检索为准，不能把无命中当作不存在约束。
- 文档默认使用中文；Skill 入口保持精简，阶段细节按需加载。
- 遵守 Plugin、Kit、Framework 测试边界；本 Task 不涉及 UI 行为时不引入无关浏览器验收。

## 决策上下文与处置

### 启动检索

外部已批准决策记忆未命中，索引状态为 `partial` 且有一个文件失败。仓库定向扫描命中 ADR 0003 和现有决策反馈闭环指南：闭环必须复用现有五个 Task stages，不能增加第二状态机；accepted 决策仍需人工批准；反向检索失败时不能宣称沉淀完成。这些约束继续适用。

现有 `change-workflow` Skill 要求创建 worktree 前取得明确授权，并固定基于已 fetch 的 `origin/main`；用户本次明确选择直接在 `main` 工作区执行，同时批准将未来流程改为 Task 定义后再选择工作环境。前者是本 Task 的执行授权，后者是待实现并通过 ADR 沉淀的仓库级流程变化。

### 角色与处置

| 角色 | 来源 | 负责范围 | 当前结论 |
| --- | --- | --- | --- |
| owner | 主 Agent | 定义 Task、编排 sub-agent、推进状态、独立验收 | 只负责调度和验收，不重复实现子任务 |
| approver | 用户 | 工作环境选择、长期流程决策、交付授权 | 已选择本次直接在本地 `main` 工作区实施；尚未授权远端操作 |
| implementation reviewers | 后续干净 sub-agent | 分别审查 Skill/协议、脚本/测试、文档/决策的一致性 | 待设计阶段委派 |

### 设计结论

本 Task 采用一个可触发的 `change-workflow` 主 Skill，不新增可被独立路由的阶段 Skill。主入口只定义五段主流程、状态所有权、人工门禁和重入；阶段细节拆入 `references/protocol.md`、`references/environment-selection.md`、`references/execution-plan.md` 和 `references/consolidation.md`，由收到最小任务包的干净 sub-agent 按职责读取。这样既能降低主 Agent 上下文，又不会形成多个流程入口或第二套状态机。

主流程与内部状态映射如下：定义任务对应 `requirements`；工作环境确认不新增状态；执行计划覆盖 `design`、`implementation`、`verification`；总结沉淀对应 `consolidation`；交付处理位于 ready gate 之后。Task 初始化应形成 `requirements=completed`、其余 stages 为 `pending`，只有用户选定当前工作区或 worktree 后才开始 `design`。

环境启动采用两条显式路径：`current <task-id>` 只验证当前工作区、保留已有改动并开始 design；`worktree <task-id>` 基于本地 `main` HEAD 创建隔离环境，并安全转移选择前已经形成的 Task 目录。旧的 `<type> <slug>` 入口只作为兼容路径。本地整合继续保留 clean、ready、冲突预检和显式授权，但不再因为 `origin/main` 缺失或落后而失败；远端事实只在 push/PR 路径校验。

`StagePacket` 只传 Task/stage/work unit、目标、工作区事实、允许路径、必要输入、验收和停止条件；`StageResult` 返回建议、产物、验证证据、阻塞/非阻塞问题、决策候选和下一动作。阶段 sub-agent 不得修改 `status.json`、创建环境、执行交付或宣布整个 Task 完成，状态转换仍由主 Agent 独占。

总结沉淀自动提取 Decision Delta，并将发现项分为 `blocking`、`non_blocking`、`decision_candidates` 和 `follow_up`。阻塞项阻止 ready；其余类别不阻断自动收口，但必须写入 summary 并在最终用户报告中显式展示。自动提取不等于自动批准，ADR 的 accepted 状态仍需要 approver 明确确认。

## 需求变更

讨论过程中曾将“准备任务”作为独立节点，随后用户明确更正：任务定义只负责补全必要信息和写 Task；是否创建 worktree 是 Task 定义完成后的用户选择。用户同时将计划、实现和验收合并为“执行计划”，并要求总结沉淀默认自动执行，但必须将发现的问题显式反馈给用户。本 Task 以这一最终结构为准。
