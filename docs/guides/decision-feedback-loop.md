# 决策反馈闭环指南

## 目的与基本契约

本指南规定任务如何消费既有决策、收集角色反馈、验证执行一致性，并在收尾时把新的长期事实发布为下一项任务可检索的输入。闭环的核心契约是：

> 每个任务开始时消费已有决策，过程中验证决策，结束时生产或修正决策，并验证这些信息可以被下一个任务消费。

这套闭环是现有 Task 生命周期的协作约定，不是另一套生命周期或状态机。机器阶段仍由 `status.json` 和 Task CLI 管理；本指南只定义各阶段需要产生和交接的决策信息。

## 完整链路

```text
历史决策、架构事实与任务记录
          ↓
requirements：按任务意图和范围检索 Decision Context
          ↓
design：逐条记录适用、不适用、冲突或新增，并收集角色反馈
          ↓
implementation：将已批准决策映射到实现证据；范围变化时重检
          ↓
verification：检查决策遵循、冲突和证据完整性
          ↓
consolidation：形成 Decision Delta，分类并经人工闸门发布
          ↓
权威 Markdown、索引和关联关系
          ↓
Retrieval Verification：用下一任务的查询方式反向检索
          └──────────────────────────────→ 下一任务的 Decision Context
```

每次交接都要保留来源、适用范围、状态、负责人和关联任务。没有来源或适用条件的孤立结论不能作为后续任务的强约束。

## 权威层级与状态

### 信息权威层级

不同信息由不同来源负责，不能把决策约束、当前实现事实和文档投影混为一谈。发生冲突时记录冲突并回到人工决策闸门，不静默覆盖：

| 来源 | 权威对象 | 能否约束任务 | 处理规则 |
| --- | --- | --- | --- |
| 已接受 ADR | 为什么这样选择以及必须遵守的决策约束 | 能 | 这是决策约束的权威；冲突必须由 approver 裁定是修正实现还是提出新决策 |
| 源码与测试 | 当前系统实际如何工作以及可复现的验证事实 | 作为实现事实能 | 这是当前实现事实的权威；若与 ADR 不一致，记录偏离并回到 design/implementation，不把文档投影当实现事实 |
| architecture 与 guide | 与 ADR、源码和测试同步的正式可读投影 | 不能独立超越前两者 | 必须同步并链接来源；过时投影要修复，不能改变 ADR 约束或伪造实现事实 |
| Task 需求、评审和验证记录 | 当前 Task 范围内的上下文、处置和证据 | 仅在当前 Task 范围内 | 作为来源和证据；需长期复用时经人工闸门分类发布 |
| 外部 decision memory | 发现和定位仓库来源的辅助索引 | 不能独立约束 | 能回链仓库来源才可用于定位；无法回链时只能是 `candidate` 或待确认信息 |

外部索引状态为 `partial`、存在文件失败或没有命中时，不能据此证明不存在决策或跳过仓库扫描。无论查询先后，`requirements` 都必须完成针对相关 `docs/decisions`、`docs/architecture`、`docs/guides` 和 `docs/tasks` 内容的仓库 Markdown 定向检索；外部无命中只能说明辅助索引未提供线索。

### ADR 审核状态

ADR 的正式状态只有以下五种，由人工审查和文档关联维护：

| 状态 | 含义 | 可否作为约束 | 转换闸门 |
| --- | --- | --- | --- |
| `proposed` | 正在讨论，尚未成为决策约束 | 否 | reviewer 审查，approver 人工批准 |
| `accepted` | 人工批准并已发布的当前决策 | 是 | 记录批准者、日期、来源、适用和排除条件 |
| `rejected` | 人工明确不采用的方案 | 否 | 记录理由，避免重复提议 |
| `partially superseded` | 新 ADR 只取代明确列出的条目或场景 | 仅未被取代部分 | 新旧 ADR 双向链接并列出范围 |
| `superseded` | 被新 ADR 完整取代 | 否，按新 ADR 处理 | 新旧 ADR 双向链接 |

### 闭环处置标记

以下标记描述检索、反馈和执行中的处置结果，不是 ADR 正式状态，也不形成独立状态机：

| 标记 | 含义 | 可否作为约束 | 处理闸门 |
| --- | --- | --- | --- |
| `candidate` | 从检索、反馈或执行中发现的待确认信息 | 否 | 补充来源、角色、范围和适用条件 |
| `conflict` | 与 accepted ADR、源码或测试事实存在未裁定的不一致 | 否 | 保留双方证据，提交 approver 裁定 |
| `exception` | 已批准的范围内偏离或例外 | 仅限批准条件 | 关联原 ADR、Task、范围、期限和批准者 |

`accepted` 是 ADR 的审核状态，不是过程产物的状态机，也不是模型、脚本或角色反馈自动推导的状态。处置标记不能冒充 ADR 状态；无法回链的外部结果和未形成完整 ADR 的申请只能是 `candidate` 或待确认，只有完整 ADR 草案才可使用 `proposed`。没有人工 approver 的明确批准，不能标记 `accepted`；没有成功发布和反向检索验证，也不能宣称完成沉淀。

## 阶段、产物与闸门

下面的阶段与 Task 的五个内部 stages 一一对应，不新增状态机。阶段状态仍为 `pending`、`in_progress`、`blocked`、`completed` 或 `skipped`，由 Task CLI 维护。

| Task stage | 决策动作 | 必要产物 | 主要角色 | 进入下一阶段的闸门 |
| --- | --- | --- | --- | --- |
| `requirements` | 以任务意图、路径、关键词和历史关联检索 | Decision Context：命中、来源、适用范围、索引质量、待确认项、候选角色及其来源/负责范围 | owner | 已记录仓库 Markdown 检索；外部 memory 的 partial/失败已显式标注 |
| `design` | 逐条处置历史决策，收集并合并角色反馈 | Decision Disposition：适用/不适用/冲突/需新增及理由；角色反馈记录 | owner、reviewer | 每条相关决策有处置；冲突和新增提案有责任人及人工闸门 |
| `implementation` | 将 accepted 决策落实到实现，并跟踪范围变化 | Decision Compliance：决策到代码、配置、文档或测试证据的映射 | owner、实现者 | 每项适用约束有证据或明确偏差；范围变化已触发重检 |
| `verification` | 检查实现是否遵循决策，验证反馈是否闭合 | Compliance Review：证据、偏差、冲突和未决风险 | reviewer、验证者 | 证据可追溯；偏差已批准或回到 design；未决冲突不被隐藏 |
| `consolidation` | 分类新增信息，发布并反向检索 | Decision Delta、Published Context、Retrieval Verification | owner、approver | accepted 信息人工批准、权威 Markdown 已更新且反向检索成功；失败时保持 `in_progress` 或 `blocked` |

`skipped` 不能用来绕过闭环。只有在确认没有适用决策或没有 Decision Delta 时，记录明确的“无适用项”或“无新增项”结论、完成的检索或分类证据，并由 reviewer 确认后，相关 stage 才可标记 `skipped`；有未决冲突、未完成检索或失败的反向检索时不得 skip。

### 重入条件

以下事件必须回到相应阶段，不能只在最终总结中补一句：

- 检索发现新的适用 ADR、架构事实或与当前方案冲突的信息：回到 `design`，重新生成 Decision Disposition。
- 需求、范围、关键依赖、数据边界或宿主假设发生变化：回到 `requirements` 重新检索，并按需要重做 `design`。
- 实现无法满足 accepted 决策、验证发现偏离，或提出例外申请：回到 `implementation` 或 `design`；未批准申请标记为 `candidate`，与 accepted 决策冲突的申请标记为 `conflict`，只有 approver 批准后才能标记为 `exception`。
- 角色反馈改变方案、发现信息来源不可靠或人工否决提案：回到 `design`，更新处置结果。
- 发布后反向检索找不到新信息、索引关联错误或权威文档内容不完整：回到 `consolidation` 修复；若修复需要重新决策，则回到 `design`。

重入使用现有 Task CLI 的 `rewind` 规则，不另行创建闭环状态。重入后，原有 Decision Context、Compliance 或 Delta 不再代表当前结论，应以普通文字标明“被某次 rewind 取代”，并链接到当前记录；不得为过程产物另设未定义的 `invalid` 或 `superseded` 状态。决策文档的 `superseded` 等审核状态只适用于决策文档本身，不等于过程产物状态机。

## 各阶段操作约定

### 1. 启动检索：生成 Decision Context

owner 在 `requirements` 阶段至少使用以下检索维度：任务目标和同义词、受影响的目录/模块、宿主或运行时边界、数据与安全关键词、关联 Task/ADR。结果按“命中内容—来源—适用条件—当前状态—索引质量”记录。

仓库 Markdown 与已批准外部 memory 的查询没有强制先后顺序。外部 memory 的结果必须回链到仓库来源或标记为待确认；无论是否有外部命中，都必须完成仓库 Markdown 定向扫描，不能因外部检索无命中就跳过。

Decision Context 还要记录候选角色信息，而不是到 design 才临时寻找责任人：候选 `owner`、`reviewer`、`approver`，每个角色的来源（Task 指定、评审反馈、既有文档或用户确认）以及负责范围。进入 `design` 后由 owner 确认最终分工、替代人和批准范围；角色来源不清或范围重叠时记录为待确认，不能默认视为批准。

### 2. 规划处置：收集角色反馈

design 中逐条处理 Decision Context：

- `适用`：说明该决策如何约束当前设计，并保留证据来源。
- `不适用`：说明排除条件，不得仅写“与本任务无关”。
- `冲突`：指出冲突字段和影响范围，暂停擅自取舍，交给 approver。
- `需新增`：先标记为 `candidate`，说明背景、选项、影响、适用条件和候选批准人；只有形成完整 ADR 草案时，才可将该 ADR 标记为 `proposed`。与现有决策未裁定的一致性问题标记为 `conflict`。

角色不是状态机角色，而是责任和审查关系：

| 角色 | 职责 | 最低记录 |
| --- | --- | --- |
| `owner` | 负责检索、处置、证据映射、收尾和问题升级 | 姓名/标识、负责范围、提交日期 |
| `reviewer` | 检查适用性、冲突、证据和反向检索结果 | 审查意见、结论、日期 |
| `approver` | 对新增决策、例外、冲突裁定和 accepted 状态作人工批准 | 明确批准/拒绝、范围、日期 |

同一人可以承担多个角色，但必须分别记录职责和批准动作。角色反馈只有在被 owner 处置并由 approver 批准后，才会改变权威决策。

### 3. 执行映射：Decision Compliance

implementation 中建立“决策 → 设计选择/代码或配置变更/测试或验证证据”的映射。每一项至少说明：决策 ID 或来源、适用条件、落实位置、证据链接、结果（遵循/偏离/未验证）和偏离理由。

执行期间若任务范围、关键路径或依赖变化，必须重新检索；新增命中按 design 处置，不得只在实现备注中临时覆盖原决策。

### 4. 验证：检查遵循与反馈闭合

verification 要同时检查功能结果和决策遵循：accepted 决策是否都有证据、例外是否有批准、提案是否未被误写成约束、冲突是否仍显式存在。验证失败时记录证据和重入阶段；没有证据不能以“看起来符合”替代。

### 5. 收尾：形成 Decision Delta 并发布

consolidation 对本 Task 相对启动 Context 的新增、修正、废弃和例外形成 Decision Delta。按以下分类发布：

| 分类 | 内容 | 默认发布位置 | 状态规则 |
| --- | --- | --- | --- |
| 已批准决策 | 会持续约束未来任务的选择 | `docs/decisions/` ADR | approver 批准后为 `accepted` |
| 当前架构事实 | 系统当前如何工作，不是取舍原因 | `docs/architecture/` | 由 owner/reviewer 校验，必要时关联 ADR |
| 操作方法 | 可重复的开发、验证或维护步骤 | `docs/guides/` | reviewer 校验后发布 |
| 待讨论方案 | 尚未批准的选项、假设或建议 | Task/过程记录或完整的 `proposed` ADR 草案 | 不得作为约束 |
| 一次性任务证据 | 只为本次任务成立的日志、截图、验证结果 | Task 或 `.work/` | 不升级为长期事实 |
| 冲突或例外 | 与现有决策冲突或受限范围的偏离 | 关联原 ADR、Task 和批准记录 | 未裁定标记为 `conflict`；批准后标 `exception` |

发布时更新正文、索引、来源 Task、适用/排除条件和关联关系。若只更新外部 memory 而没有更新仓库 Markdown，不算发布完成。

## 反向检索验证

发布后 reviewer 使用“下一项任务的启动查询方式”做 Retrieval Verification：至少使用任务意图同义词、受影响路径、关键技术/边界词和 ADR/guide 标题关键词各检索一次，并确认：

1. 能命中正确权威文档，而非只命中过程草稿或未批准提案。
2. 命中结果包含适用条件、状态、来源和关联关系。
3. 冲突/例外不会被错误展示为无条件约束。
4. 外部索引若为 partial，仓库检索仍能独立给出权威结果。

反向检索失败时，先修复标题、索引、关键词、链接或文档位置；若内容尚未形成完整 ADR，保持 `candidate`；若已形成完整 ADR 草案，可保持 `proposed`，但不得标记 `accepted`。修复完成前，`consolidation` 必须保持 `in_progress` 或 `blocked`，不得进入 ready gate 或宣称闭环完成。

## 失败处理与升级

| 失败 | 处理 | 升级/重入 |
| --- | --- | --- |
| 仓库检索工具或索引不可用 | 使用 `rg` 等本地扫描；记录范围和未覆盖路径 | 无法证明覆盖完整时标记 blocked，回到 `requirements` |
| 外部 memory 为 `partial`、文件失败或无命中 | 降级为辅助线索，继续以 Markdown 为准 | 不得推断“没有决策” |
| 找到多个互相冲突的 accepted 决策 | 保留两方来源和影响，不擅自选边 | approver 裁定；回到 `design` |
| 角色反馈不完整或 reviewer 未审查 | 标记未决，不把反馈写为 accepted | owner 补齐或 Task blocked |
| 实现偏离 accepted 决策 | 停止静默修正，记录证据和偏离理由 | 回到 `design` 申请新决策或例外 |
| 发布写入失败、索引未更新或链接断裂 | 保留 Decision Delta，修复权威文档和索引 | 回到 `consolidation` |
| 反向检索找不到已发布信息 | 修复可检索性并重复验证 | 保持 `consolidation` 为 `in_progress` 或 `blocked`；验证成功前不得进入 ready gate、关闭闭环或宣称完成 |

失败处理记录事实、影响、owner、下一步和重入阶段；不要把推测写入 `status.json`。需要长期保留的结论升级到正式文档，需要跨环境交接的事实写入 Task 正式文件。

## 需求覆盖矩阵

| 本 Task 要求 | 文档覆盖位置 | 验收证据 |
| --- | --- | --- |
| 启动即检索并生成 Context | 完整链路、权威层级、启动检索 | Decision Context 字段与检索顺序 |
| 规划逐条处置与角色反馈 | 规划处置、角色表、阶段表 | Disposition 四类结论和 owner/reviewer/approver |
| 执行中决策到证据映射 | 执行映射、重入条件 | Compliance 字段和范围变化重检 |
| 收尾分类沉淀 | 收尾分类表 | 六类发布去向和状态规则 |
| 人工闸门与 accepted | 状态表、角色表、权威层级 | approver 明确批准才可 accepted |
| 失败处理 | 失败处理与升级 | 七类失败路径和重入/阻塞 |
| 反向检索供下一任务消费 | 反向检索验证 | 四项可检验条件 |
| 嵌入现有生命周期 | 阶段、产物与闸门 | 五个既有 stages 一一对应 |
| 不新增第二状态机 | 目的与基本契约、ADR 0003 | 明确沿用 Task CLI/status.json |

## 非目标

- 本指南不替代 Task CLI、`status.json` 或现有六阶段开发工作流。
- 本指南不定义自动决策、自动批准、自动合并、自动发布或外部 memory 的实现。
- 本指南不要求所有一次性任务证据都升级为 ADR，也不要求为角色反馈建立独立数据库。
- 本指南不改变 Plugin、Kit、Framework 的代码边界和 Web-only host 约束。

## 相关文档

- [Task 档案](../tasks/README.md)
- [开发工作流](./development-workflow.md)
- [文档维护指南](./maintaining-docs.md)
- [架构决策记录](../decisions/README.md)
- [ADR 0003：决策反馈闭环](../decisions/0003-decision-feedback-loop.md)
