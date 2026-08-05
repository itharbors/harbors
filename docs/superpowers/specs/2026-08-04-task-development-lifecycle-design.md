# Task 驱动的需求开发生命周期设计

## 背景

当前 Harbors 已经用 `change-workflow` 和 `kit-workflow` 约束隔离分支、检查、提交、推送和
Pull Request，但一次需求在进入分支之前、开发会话之间以及 PR 合并之后缺少统一的事实载体：

- 需求确认结果主要留在对话中，后续难以确认原始范围和验收标准；
- spec、plan、调研和验证记录数量多、生命周期短，默认全部提交会持续增加文档噪声；
- 新会话无法只依靠一个客观状态文件判断当前处于哪个阶段；
- PR 创建、PR 合并和开发任务完成之间没有明确边界；
- 合并后的会话归档缺少可验证的完成条件。

本设计建立一个以 Task 档案为中心、GitHub PR 为交付事实、Codex 会话为协作载体的六阶段
开发生命周期。方案已经过独立审查；首轮发现 PR 标识、不可变链接、合并后状态和临时材料
移交四个闭环问题，修订后复审通过。

## 目标

- 每次变更在开发前保存确认后的需求快照。
- 保留现有七类变更，并使 Task 类型与分支、提交和 PR 类型一致。
- 用纯结构化状态支持同机和跨环境的会话移交。
- 将临时 spec、plan 与需要长期维护的正式文档分开。
- 在 PR 创建前把零散过程信息收口为长期可读的任务总结。
- 明确 PR 提交不等于任务完成，PR 合并后才允许归档开发会话。
- 避免在仓库中复制会过期的 GitHub 实时状态。

## 非目标

- 不迁移或重写已有的 `docs/superpowers/specs`、`plans` 和 `reports`。
- 不把 Task 档案建设成通用项目管理、工时或人员绩效系统。
- 不在 `status.json` 中记录开发日志、设计决定、阻塞原因或下一步建议。
- 不保存终端原始日志、完整聊天记录或其他低价值过程数据。
- 不用仓库自动提交来同步 PR 的实时状态。
- 第一版不处理多个仓库共同交付一个 Task 的编排。

## 变更分类

Task 使用现有七类变更，语义与分支和提交规范保持一致：

| 类型 | 适用范围 |
| --- | --- |
| `feature` | 新能力及其配套测试和文档 |
| `bug` | 错误、回归或不符合预期的行为 |
| `optimize` | 已有行为的性能或资源使用改善 |
| `docs` | 不伴随行为变化的独立文档修改 |
| `refactor` | 不改变预期行为的结构和维护性调整 |
| `test` | 不伴随产品行为变化的独立测试建设 |
| `chore` | 依赖、构建工具和日常维护 |

`[Init]` 继续只用于仓库初始化，不作为日常 Task 类型。

## Task 目录与信息边界

每个 Task 使用一个不可复用的目录：

```text
docs/tasks/YYYY-MM-DD-<slug>/
├── task.md
├── status.json
├── summary.md
└── .work/              # 本地过程材料，默认不进入 Git
```

`slug` 必须符合现有分支 slug 规则，并与当前变更的语义名称一致。相同日期和 slug 已存在时，
必须选择新的明确 slug，不允许覆盖历史 Task。

目录中的信息源边界如下：

| 载体 | 唯一职责 | 生命周期 |
| --- | --- | --- |
| `task.md` | 确认后的需求事实 | Task 建档时创建，需求变化只追加记录 |
| `status.json` | 结构化流程位置和稳定 PR 编号 | 阶段切换时更新 |
| `.work/` | 活跃开发所需的 spec、plan、调研和临时验证材料 | 收口前保留，默认不提交 |
| `summary.md` | 最终开发结论 | Task 收口时创建，实质审查变更时同步更新 |
| Git 与测试输出 | 当前实现和验证事实 | 由仓库工具提供 |
| GitHub PR | 审查、required checks 和合并事实 | 从 GitHub 实时查询 |
| Codex 会话 | 需求沟通和执行上下文 | 派生完成条件满足后归档 |

### `task.md`

`task.md` 必须包含：

- Task 标识、标题和七类之一的类型；
- 背景和待解决的问题；
- 确认后的目标；
- 范围与非目标；
- 可验证的验收标准；
- 已知的安全、兼容、数据和平台约束；
- 需求变更记录。

需求变化不得静默覆盖原始共识。变更记录至少保存时间、变更内容和确认结果；不会改变范围的
文字修正可以直接修改正文。

### `status.json`

`status.json` 只保存客观、可校验的结构化字段：

```json
{
  "schemaVersion": 1,
  "taskId": "2026-08-04-task-development-lifecycle",
  "type": "feature",
  "updatedAt": "2026-08-04T10:00:00+08:00",
  "stages": {
    "requirements": "completed",
    "design": "in_progress",
    "implementation": "pending",
    "verification": "pending",
    "consolidation": "pending"
  },
  "pullRequest": null
}
```

`pullRequest` 只允许 `null` 或只包含 JavaScript 安全正整数编号的对象：

```json
{
  "pullRequest": {
    "number": 51
  }
}
```

它不得复制 PR 标题、状态、检查结果或合并状态。接手者用稳定编号查询 GitHub 的当前事实。
关闭但未合并的 PR 被替换时，`number` 更新为当前 PR；旧 PR 历史继续由 GitHub 保存。

阶段值只允许：

- `pending`
- `in_progress`
- `completed`
- `blocked`
- `skipped`

状态必须满足以下不变量：

1. `completed` 和 `skipped` 是终态。
2. 按固定阶段顺序，状态只能由一个终态前缀、最多一个 `in_progress` 或 `blocked`、以及后续
   `pending` 组成。
3. 同一时间最多一个阶段处于 `in_progress` 或 `blocked`。
4. `blocked` 解除后，原阶段恢复为 `in_progress`，不得直接越过。
5. 只有所有阶段进入终态后才能创建 PR，也只有保持全部终态才允许合并。
6. 每次有效状态变化都自动更新 `updatedAt`。
7. Task 建档由目录和两个初始文件的存在表示，不重复增加 `task_setup` 阶段。
8. `skipped` 只能通过 CLI 对 `in_progress` 阶段执行 `skip` 形成，不能靠手改 JSON 绕过阶段入口。

验证失败时，`implementation` 恢复为 `in_progress`，`verification` 和 `consolidation` 重置为
`pending`。PR 审查导致行为、范围、关键决定、验证证据或风险发生实质变化时，按照实际影响
回退到 `implementation`、`verification` 或 `consolidation`，不得只修改代码而保留旧总结。

`status.json` 禁止自由文本、建议、设计决定、阻塞原因、验证日志和主观判断。相关信息分别由
`task.md`、`.work/`、Git、测试、`summary.md` 和 PR 承担。

### 过程材料

spec、plan、调研、排查笔记和临时验证记录是开发工具，不默认是项目产品。活跃开发期间，
它们可以保存在 Task 的 `.work/` 目录并由仓库忽略：

- 同机跨会话移交时，接手会话可直接读取 `.work/`；
- Task 收口完成前不得清除仍用于实施或验证的材料；
- 跨机器、干净工作区或其他开发者移交时，必要材料必须提交到变更分支、升级为正式文档，
  或通过用户授权的共享载体提供；
- 形成长期架构、安全、迁移、兼容或维护约束的内容，应升级到 `docs/architecture`、
  `docs/guides` 或 `docs/decisions`，而不是以临时 spec/plan 名义长期保存；
- 收口后无长期价值的过程材料不得进入最终 PR。

本设计本身定义长期开发约束，因此属于需要提交的正式设计材料，不代表普通 Task 的 spec/plan
默认提交。

### `summary.md`

`summary.md` 是未来理解本次变更的首选入口，必须包含：

1. 最终结论；
2. 需求完成矩阵；
3. 按功能或模块组织的主要改动；
4. 具有长期解释价值的关键决定；
5. 实际执行的验证及结果；
6. 安全、兼容、数据、性能和发布影响；
7. 与原计划的偏差、遗留问题和后续关注；
8. 需要长期保留的相关正式文档。

它不得逐文件复述 diff、粘贴大量日志、重复完整过程材料、隐藏未完成事项或包含敏感信息。

## 六阶段生命周期

### 阶段一：需求确认与分类

**入口：** 一个待处理的想法、问题或维护事项。

**活动：** 明确背景、目标、范围、非目标、验收标准和七类变更类型。小的实现细节可以由执行者
决定；改变用户行为、需求范围、安全边界或验收标准的内容必须由用户确认。

**产物：** 已确认的需求信息。

**退出：** 用户确认需求，且信息足以创建隔离变更。

### 阶段二：Task 建档

**入口：** 需求已确认，隔离变更分支和 worktree 已创建。

**活动：** 创建不可复用的 Task 目录、`task.md`、初始 `status.json` 和本地 `.work/` 工作位置。

**产物：** 可校验的需求快照和状态文件。

**退出：** `requirements` 为 `completed`，`design` 为 `in_progress`，Task 标识、类型和当前分支
一致。

### 阶段三：设计与计划

**入口：** Task 已建档。

**活动：** 形成足够实施的设计、计划、安全边界、失败处理、兼容方案和验证方法。过程材料默认
放在 `.work/`；需要长期遵守的内容升级为正式文档。

**产物：** 当前环境可访问的实施依据，以及必要的正式长期文档。

**退出：** 所需设计已经确认，风险和验证方式明确；`design` 为 `completed`，`implementation`
进入 `in_progress`。

### 阶段四：实施与验证

**入口：** 设计阶段完成。

**活动：** 按方案修改代码和测试，运行聚焦测试与 `check:preflight`；完成后执行与风险相称的
验收。实施和验证可以循环，验证失败必须回到实施。

**产物：** 代码、测试、Git 差异和真实验证证据。

**退出：** 所有验收标准满足，必要检查通过；`implementation` 和 `verification` 为终态，
`consolidation` 进入 `in_progress`。

### 阶段五：Task 收口与 PR

**入口：** 实施和验证完成。

**活动：**

1. 对照 `task.md`、实际 diff、提交、测试结果和过程材料；
2. 编写 `summary.md`，明确完成、偏差、风险和后续关注；
3. 升级具有长期价值的正式文档，排除其余过程材料；
4. 校验 Task 文件、状态和代码一致；
5. 完成收口提交，将 `consolidation` 设为 `completed`；
6. 取得包含最新版 `summary.md` 的 head SHA；
7. 创建或恢复 PR 前验证 base/head、当前仓库 owner、`isCrossRepository=false` 与 head owner；同名 fork PR 不得被编辑或记录；
8. 创建 PR，PR body 使用 `summary.md` 的精简内容，并链接该 SHA 下的不可变文件地址；
9. 将 PR 安全正整数编号写入 `status.json`，提交并推送到同一 PR。已记录 PR 只有在 GitHub 证明其 closed 且 unmerged 时才可替换，并更新为当前 PR 编号。

不可变链接格式为：

```text
https://github.com/itharbors/harbors/blob/${headSha}/docs/tasks/${taskId}/summary.md
```

只更新 `status.json` 中 PR 编号时，不需要改变总结链接。审查期间 `summary.md` 发生实质变化时，
必须在推送后把 PR body 链接更新到包含新版总结的 head SHA。记录 PR 编号的提交至少执行结构化
状态校验，并由该 push 触发远端 required checks。

**产物：** 完整 Task 档案、PR、稳定 PR 编号和可审查的最新实现。

**退出：** 所有内部阶段保持终态，PR 已创建且编号已记录。实质审查变更会回退到受影响阶段。

### 阶段六：合并确认与会话归档

**入口：** PR 存在。

**活动：** 查询 GitHub 的最新 PR、最新 head required checks 和合并状态，确认 Task 三个正式文件
已经进入 `main`。

Task 完成是一个派生条件：

```text
status.json 所有阶段为终态
+ pullRequest.number 存在
+ GitHub 显示该 PR 已合并
+ PR 最新 head 的 required checks 通过
+ task.md、status.json、summary.md 已存在于 main
= Task completed
```

满足后归档当前 Codex 会话，不再创建合并后状态提交。PR 关闭但未合并时不算完成，应继续、
替换 PR 或按用户决定终止。

**产物：** 已合并的实现、主分支 Task 档案和已归档会话。

**退出：** 派生完成条件全部满足。

## 跨会话恢复协议

接手 Task 的会话必须按以下顺序恢复：

1. 读取 `task.md`，确认需求和验收标准；
2. 读取并校验 `status.json`，定位首个未完成或被阻塞的阶段；
3. 检查实际分支、worktree 和 Git 状态，不把文件记录替代为真实环境；
4. `pullRequest.number` 存在时查询 GitHub 当前状态；
5. 读取当前阶段需要的 `.work/`、正式文档、diff 和测试证据；
6. 文件与环境不一致时，先恢复为合法结构化状态；
7. 从当前阶段继续，不重复已经有可靠证据的工作。

`status.json` 只在阶段切换、阻塞、解除阻塞、回退、恢复或 PR 创建时更新，不记录微观进度。

## 校验与自动化边界

第一版需要提供：

- `status.json` 的 JSON Schema；
- 创建和更新状态的受控命令，自动维护 `updatedAt`；
- 状态顺序、不变量、Task 标识、类型和 PR 编号校验；
- Task 模板和文档说明；
- Framework 与 Kit 变更流程的建档、收口和恢复约束；
- finish 流程在创建 PR 前检查 `task.md`、`status.json` 和 `summary.md`；
- 创建 PR 后记录编号并推送的可靠步骤；
- PR 最新 head required checks 与 Task 完成派生条件的说明。

自动化不得生成主观内容，不得替用户决定需求、设计、风险或总结，也不得在 PR 合并后自动向
`main` 写状态提交。

## 错误处理与边界情况

- 非法 JSON、未知字段、未知状态或状态顺序错误必须阻止阶段推进。
- Task ID 与目录名不一致必须失败。
- Task 类型与变更分支主类型不一致必须失败。
- `.work/` 缺少必要移交材料时不得宣称跨环境交接完成。
- 验证失败必须回退，不得把失败验证标记为完成。
- PR 创建失败时保持所有内部阶段终态、`pullRequest` 为 `null`，允许安全重试。
- PR 编号记录提交失败时，PR 已存在但 Task 未完成第五阶段；恢复时按分支查询 PR 后补记编号。
- PR 被替换时更新当前编号，不在 `status.json` 中维护历史列表。
- 合并后 Task 文件未出现在 `main` 时不得归档会话。
- 被放弃的 Task 不伪装成完成；终止结论记录在 `summary.md` 或正式决策载体，并由用户决定后续
  保留方式。

## 测试策略

- Schema 测试覆盖合法最小文件、全部类型、全部状态和 PR 编号。
- 失败测试覆盖未知字段、自由文本字段、非正整数 PR、多个活动阶段、阶段越过和非法回退。
- 状态命令测试覆盖阶段前进、阻塞与恢复、验证失败回退、审查回退和 `updatedAt` 更新。
- Task 目录测试覆盖 ID/目录一致、必需文件、`.work/` 忽略和 summary 收口门禁。
- workflow 合约测试覆盖 PR 前收口检查、不可变 summary 链接、PR 编号回写和合并派生条件。
- 文档测试覆盖 Framework 与 Kit 都采用同一 Task 生命周期。
- 使用一个真实变更完成从建档到 PR 的端到端演练；合并和会话归档只做受控验收，不在测试中
  写入 `main` 或操作无关会话。

## 推出与兼容

- 新规范只应用于合并本变更后新创建的 Task，不追溯迁移历史变更。
- 已存在的 specs、plans 和 reports 保持原路径和历史语义。
- 先交付 Schema、状态命令、模板、指南和流程校验，再用后续真实 Task 验证体验。
- 如自动化阻碍合法开发，可以回滚命令和 finish 集成；已经提交的 `task.md` 与 `summary.md` 仍是
  普通 Markdown，不依赖专用运行时读取。

## 需求覆盖矩阵

| 需求 | 方案 | 状态 |
| --- | --- | --- |
| 需求确认后建档 | `task.md` 与 Task 目录 | 已覆盖 |
| 保留七类变更 | Task 类型与现有规范一致 | 已覆盖 |
| spec/plan 不必提交 | 本地 `.work/` 与正式文档升级规则 | 已覆盖 |
| PR 前归总改动 | 强制 `summary.md` 收口门禁 | 已覆盖 |
| 结构化跨会话状态 | Schema 约束的 `status.json` | 已覆盖 |
| 不保存主观状态 | 状态字段白名单和禁止额外字段 | 已覆盖 |
| PR 可稳定定位 | `pullRequest.number` | 已覆盖 |
| 避免 PR 状态过期 | GitHub 作为实时事实源 | 已覆盖 |
| PR 合并后才完成 | 派生完成条件 | 已覆盖 |
| 完成后归档会话 | 合并条件满足后归档 Codex 会话 | 已覆盖 |
