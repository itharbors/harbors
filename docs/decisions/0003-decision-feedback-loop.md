# ADR 0003：决策反馈闭环嵌入现有 Task 生命周期

- 状态：已接受
- 日期：2026-08-23
- 决策者：项目维护者
- 批准者：需求发起人（本次决策批准者）
- 批准日期：2026-08-23
- 批准范围：决策反馈闭环方向、嵌入现有 Task 生命周期的流程契约及本 ADR 的文档范围
- 来源 Task：[2026-08-23-decision-feedback-loop](../tasks/2026-08-23-decision-feedback-loop/task.md)
- 检索提示：决策反馈闭环、Decision Context、Decision Disposition、Decision Compliance、Decision Delta、Retrieval Verification、Task 生命周期

适用条件：需要在任务之间复用决策、架构事实、角色反馈或执行证据，并要求收尾产物可被下一项任务检索的文档或开发任务。

排除条件：不改变业务代码、Plugin/Kit 协议、Web-only host 边界、Task CLI、`status.json` schema 或测试实现；不把外部 decision memory 作为独立决策来源。

## 上下文

任务开始时需要了解历史架构决策和角色信息，规划过程中需要逐条判断适用性并收集反馈，执行过程中还要证明决策确实被落实。若收尾只记录“已完成”，而不提炼新增决策、架构事实、例外和操作方法，下一项任务就无法稳定检索本次工作的结论，决策信息会停留在一次性对话或过程记录中。

仓库已经有由 `requirements`、`design`、`implementation`、`verification`、`consolidation` 组成的 Task 内部 stages，并由 `status.json` 与 Task CLI 管理机器状态。需要的是决策信息的消费、反馈、证据、沉淀和反向检索约定，而不是再建立一套并行生命周期。已接受 ADR 是决策约束权威；源码和测试是当前实现事实权威；architecture 和 guide 是必须与二者同步的正式投影。外部 decision memory 只能发现和定位仓库来源，无法回链时不能独立约束；索引 `partial` 或失败不能证明不存在决策。

## 决策

1. 采用“启动检索 Decision Context → 规划逐条处置与角色反馈 → 执行中 Decision Compliance → 验证 → 收尾 Decision Delta 分类发布 → Retrieval Verification 反向检索”的闭环。
2. 将闭环嵌入现有五个 Task stages：`requirements` 负责检索，`design` 负责处置和反馈，`implementation` 负责证据映射，`verification` 负责遵循检查，`consolidation` 负责分类发布和反向检索。
3. 以已接受 ADR 作为决策约束权威，以源码和测试作为当前实现事实权威；architecture 和 guide 作为需与二者同步的正式投影。外部 decision memory 仅用于发现和定位仓库来源，无法回链时只能标为 candidate 或待确认，不能独立约束；只有形成完整 ADR 草案时，ADR 才可标为 proposed。partial/失败结果必须显式记录并触发仓库 Markdown 定向扫描。
4. ADR 正式状态仅为 `proposed`、`accepted`、`rejected`、`partially superseded` 和 `superseded`。`candidate`、`conflict` 和 `exception` 是检索、反馈和执行中的闭环处置标记，不是 ADR 状态，也不形成状态机。只有 approver 的人工明确批准和成功发布，才能将 ADR 标记为 `accepted`。
5. 要求 owner、reviewer、approver 的责任和审查动作可追溯；角色反馈本身不等于批准。
6. 任务范围、关键依赖、适用边界、实现遵循或反向检索结果发生变化时，使用现有 Task CLI 的重入/rewind 规则回到对应 stage，不在闭环之外创建状态文件。
7. 收尾时将信息分类为已批准决策、架构事实、操作方法、待讨论方案、一次性任务证据、冲突或例外，并写入相应权威 Markdown 或 Task 记录。

本决策不新增第二状态机：决策状态是文档内容的审核属性，Task stage 状态仍是唯一机器生命周期；两者通过各阶段产物和人工闸门关联，而不是互相复制或竞争。

用户已于 2026-08-23 明确批准闭环方向。具体发布内容和 Retrieval Verification 证据在 consolidation 阶段由本 Task 的 summary 收口记录；在反向检索成功前，不得将该阶段标记为 ready 或宣称闭环完成。

## 替代方案

### 仅在任务结束时写总结

未采用：无法在规划开始时消费历史决策，也无法在执行中发现范围变化和决策偏离；下一项任务仍可能重复踩坑。

### 建立独立的决策状态机和数据库

未采用：会复制现有 Task stages、引入两套状态转换和一致性问题，并把长期事实从仓库审查流程中分离。当前需求是明确闭环契约，不是增加运行时系统；沿用 Task CLI 和 Markdown 更易审查、交接和恢复。

### 只依赖外部 decision memory

未采用：外部索引可能 partial、失败或滞后，无法作为仓库的可审查权威；也不能替代 ADR、架构文档和 Task 中的来源与批准记录。

### 自动把角色反馈或提案升级为 accepted

未采用：反馈、模型推断和提案不代表团队批准。自动升级会把未经裁定的方案变成后续任务的强约束，破坏决策可追溯性。

## 影响

### 正面影响

- 任务从启动到收尾形成可复用的决策输入/输出闭环。
- 每条决策都有适用条件、角色责任、执行证据和来源，下一项任务可以反向检索消费。
- 仓库已接受 ADR 是跨任务决策约束的权威发布位置；源码和测试继续作为实现事实权威，外部索引不可用时仍能恢复工作。
- 冲突、例外和未批准提案被显式隔离，降低误把意见当约束的风险。
- 不改变现有 Task CLI 和 status schema，减少流程迁移成本。

### 负面影响与约束

- owner、reviewer、approver 需要增加记录和人工审查成本。
- 任务范围变化可能触发重检和阶段重入，收尾时间会增加。
- 文档标题、关键词、索引和关联关系需要持续维护；反向检索失败会阻止闭环宣称完成。
- 现有历史文档不会自动获得完整的闭环元数据，需要在后续相关任务中逐步补齐。

## 关联

- [决策反馈闭环指南](../guides/decision-feedback-loop.md)
- [开发工作流](../guides/development-workflow.md)
- [文档维护指南](../guides/maintaining-docs.md)
- [Task 档案](../tasks/2026-08-23-decision-feedback-loop/task.md)
- [Task 收口总结](../tasks/2026-08-23-decision-feedback-loop/summary.md)
- [架构决策记录](./README.md)
- [ADR 0001：插件优先、由 Kit 组合产品能力](./0001-plugin-first-architecture.md)
- [ADR 0002：主程序收敛为单一 Web host](./0002-web-only-host.md)
