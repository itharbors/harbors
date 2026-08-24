# 总结沉淀

总结沉淀在验证完成后默认自动执行，不等待用户再次触发。主 Agent 汇总以下事实来源：原始 Task 与需求变更、用户明确决定、计划和评审结果、实现 diff、测试/验证证据、StageResult 的 issues 和 decision candidates。无法证明的内容标为未知或阻塞，不得凭空补全。

总结沉淀可按三个独立 work unit 委派：`summary` 组织事实和 `summary.md` 草稿，`knowledge-extraction` 提取并分类 Decision Delta，`retrieval-review` 检查正式落点、索引和反向检索。三个 work unit 都返回完整 StageResult；`retrieval-review` 未通过时不得宣称沉淀完成。

## Decision Delta

先生成 Decision Delta，再决定正式落点。每条增量至少包含：变化/决定、证据来源、影响范围、当前状态、建议落点、反向检索结果。分类规则：

| 分类 | 适用内容 | 落点和门禁 |
| --- | --- | --- |
| `ADR` | 已形成长期架构、安全、迁移或治理决策 | 可生成草案；`accepted` 必须由 approver 明确批准 |
| `architecture` | 已验证且长期有效的结构事实 | 更新 architecture 文档并做反向检索 |
| `guide` | 可复用的开发、测试或运维规则 | 更新 guide/reference 并做反向检索 |
| `Task-only` | 只对本 Task 有效的取舍、偏差或临时事实 | 写入 Task 的 `summary.md` 或 `.work/` |
| `candidate` | 证据不足、需要决策或尚未批准的长期变化 | 保持 candidate，不得伪装为正式已接受规则 |

## 固定输出契约

`summary.md` 继续满足现有 Task summary contract（包括“最终结论”“需求完成情况”“主要改动”“关键决定”“验证结果”“影响与风险”“偏差与遗留”“后续关注”“相关正式文档”），并额外明确以下四组列表：

- `blocking`：阻止 ready 或收口的问题；每项写证据、责任人和解除条件。
- `non_blocking`：不阻止自动收口但需用户知悉的问题、风险或遗留；不得隐藏在“无”或泛化结论中。
- `decision_candidates`：待 approver 决定的选项、推荐和影响；生成不等于批准。
- `follow_up`：后续建议、观察项或另一个 Task；不把未授权动作自动执行。

有 `blocking` 时保持当前 stage 为 `in_progress` 或 `blocked`，不能通过 ready gate。只有在 blocking 清零且总结、验证、反向检索证据齐全时，主 Agent 才能完成 `consolidation`。`non_blocking`、`decision_candidates` 和 `follow_up` 不阻断自动收口，但必须同时写入 summary 并在最终用户报告中逐项展示。

若正式文档写入、索引更新或反向检索失败，保留 Decision Delta，标记对应 blocking，并回到 consolidation；不能宣称沉淀完成。自动总结不自动批准 ADR，也不自动 push、创建 PR、整合 main 或归档会话。
