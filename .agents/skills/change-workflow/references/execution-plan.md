# 执行计划

“执行计划”是一个外部编排阶段，内部顺序固定为：`plan → review → implementation → code-review → verification → repair（必要时）→ verification（重验）`。这些是 work unit，不是新的 Task stages。

| work unit | 现有 stage | 责任与产出 |
| --- | --- | --- |
| `plan` | `design` | 读取 Task 和决策上下文，形成范围、方案、风险、验收和允许路径；产出 `.work/plan.md` 或等价记录 |
| `review` | `design` | 由独立 sub-agent 二次审查计划的边界、依赖、测试和授权缺口；返回 StageResult，不直接改状态 |
| `implementation` | `implementation` | 只在计划审查通过后修改允许路径，补充必要测试，并返回 diff 与验证证据 |
| `code-review` | `implementation` | 对实现 diff 做独立审查，重点检查行为、边界、回归、范围和安全；发现问题时返回 `needs_repair`，由主 Agent 重新调度 `implementation` work unit 在 `implementation` stage 修复 |
| `verification` | `verification` | 按仓库测试指南运行功能单元验证，保留真实命令、输出摘要和失败定位 |
| `repair` | `verification` | 仅处理 verification 失败且已定位、允许自动修复的问题；修复后必须回到 `verification` 重验。它不用于 code-review 失败 |

主 Agent 在每个 work unit 之间收集 StageResult，并按现有 Task CLI 推进 `design`、`implementation`、`verification`。计划审查未通过时回到 `plan`；code-review 失败时重新调度 `implementation` work unit，仍处于 `implementation` stage，随后必须再次 code-review。verification 失败时才可调度 `repair`；若证据表明是实现缺陷，主 Agent 应 rewind `implementation`，重新调度 implementation → code-review → verification。建议最多自动修复两轮，仍失败则返回 `blocked`，由用户决定，不得无限重试或扩大范围。

进入下一 work unit 的最低条件：前一结果为 `completed`，所有 required evidence 为 `passed`，没有未处理 `blocking` issue，且下一 work unit 的 StagePacket 已重新裁剪。`non_blocking` issue 可带入总结但不阻断执行。`not_applicable` 不是“未运行”或“无法完成”：只有 Task 范围和验收证据明确证明该 work unit 不适用时，主 Agent 才能记录 skip；sub-agent 不得自行以此推进状态。需要长期架构、安全、迁移或维护规则时，先作为 `decision_candidate`，不要在实现阶段擅自接受。

实现和验证必须遵守仓库边界：Plugin、Kit、Framework 按目标单元做局部验证；没有 UI 变更时不引入无关浏览器验收；不向 Framework/Kit 添加 Electron 或桌面宿主假设。
