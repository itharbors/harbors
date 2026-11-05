# 2026-08-31-harness-tool-error-reporting 实现总结

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../2026-10-22-agent-turn-durability/summary.md)。

## 最终结论

Harness Agent 的错误分类实现及局部测试已完成：工具失败保护保留真实原因；取消在缺少上游 envelope 时保留既有 `MODEL_SERVICE_CANCELLED` 兼容 code 与“模型请求已取消”文案。整个 Task 尚未完成，原要求中的浏览器终态错误场景验收仍缺失。

原档案将全部阶段记为 completed 的声明仅保留为历史记录。2026-10-22 复核纠偏后，主 Agent 通过 Task CLI 将 verification 改为 blocked、consolidation 回到 pending，implementation 保持 completed；作者不改机器状态。下述为原任务的历史验证记录，不是本轮重验。没有已批准的缩范围或验收豁免，局部分类实现完成不能替代整个 Task 验收。

## 需求完成情况

- 工具失败保护终态：已完成。`turn/end` 与对外错误均使用 `AGENT_TOOL_LOOP_GUARD` 和原始保护消息。
- 取消终态：已完成。未知取消不再退化为 `UNKNOWN`/“模型服务请求失败”；既有模型取消 code 保持兼容。
- 未知模型异常：已完成。仍使用安全的 `UNKNOWN` envelope 与原有通用文案。
- Web 终态错误场景：未完成。历史操作只完成构建产物重载与浏览器加载，Chat 代码继续读取 turn/end.reason.error.message；未触发工具失败保护并观察实际文案，Kit 可用性不能替代原浏览器要求。

## 主要改动

- `ToolLoopGuardError` 增加稳定的 `AGENT_TOOL_LOOP_GUARD` error envelope 字段。
- `sendMessage` 在取消信号遇到未知错误时补齐 `MODEL_SERVICE_CANCELLED`，并保留 requestId。
- 增加工具失败保护和取消终态的 Agent 单元测试。

## 关键决定

- 保留已有 `MODEL_SERVICE_CANCELLED`，不引入新的取消协议 code；Kit assembly 测试证明该 code 已被真实消息链路依赖。
- 不调整工具失败保护阈值、工具执行策略或 `rg` 环境问题，避免扩大本次错误归因修复范围。

## 验证结果

- `pnpm --dir /Users/bytedance/Project/harbors exec tsx --test kits/harness/plugins/agent/main/src/adapter/model-service.test.ts`：10/10 通过。
- `pnpm --dir /Users/bytedance/Project/harbors run --dir kits/harness test:unit:run`：326/326 通过。
- `pnpm --dir /Users/bytedance/Project/harbors run --dir kits/harness test:plugin`：3/3 通过。
- `pnpm --dir /Users/bytedance/Project/harbors run --dir kits/harness test:assembly`：10/10 通过。
- `pnpm --dir /Users/bytedance/Project/harbors run --dir kits/harness build`：成功构建 10 个 Harness Plugin。
- 本地 48381 服务重启后健康检查返回 `status: ok`；浏览器重新加载 Harness 并显示 14/14 Plugin 已加载。

## 影响与风险

- 仅影响 Harness Agent 的错误 envelope；Chat 既有终态渲染不需要协议或 UI 结构改动。
- 当前工作区原有未提交的 Context Store 等改动被保留，未被本 Task 修改或清理。

## 偏差与遗留

存在未完成的原验收项：浏览器只验证 Kit 重载后的可用性，未覆盖工具失败保护的实际终态错误说明。Agent 单元测试与 Kit assembly 只证明各自覆盖范围，不能豁免浏览器场景；没有已批准的缩范围或验收豁免，verification 因此 blocked。

取消错误 code/message 保真不代表 stopConversation 返回 true 时已完成 durable cancelled terminal。流式写入排队后立即广播与 Stop 超时仍 true 的 P1 缺口由 [Context Store Task](../2026-08-26-conversation-knowledge-base/task.md) 单独记录；本任务不声称修复或验收这两项，原全部 completed 的历史声明也不覆盖它们。

## 后续关注

- 补齐浏览器工具失败保护场景验收，记录实际 turn/end 错误与 Chat 显示“工具 … 连续或重复失败 …”的证据，再复核 verification 与 consolidation；不能只以继续观察代替验收。
- `rg` 不在 Agent 工具进程 PATH 与搜索命令的非零退出语义仍是独立问题，应另建 Task 处理。

## 相关正式文档

无。

## 决策记录与未完成验收

### Decision Delta

- 已批准决策：无新增 ADR；保留既有 `MODEL_SERVICE_CANCELLED` 兼容 code。
- 当前架构事实：Agent 将 `turn/end.reason.error.message` 写入 trace，Chat 使用该 message 呈现终态；本次将工具保护错误保真为结构化 envelope。
- 操作方法：错误保护类必须携带 `code`、`message`、`retryable`、`requestId`，使既有错误封装函数可以无损传递。
- 待讨论方案：工具失败保护阈值及 `rg` 运行环境未纳入本次变更。
- 一次性任务证据：定向、Kit unit、plugin runtime、assembly、build 与浏览器重载可用性验证通过；浏览器未覆盖真实工具失败文案场景。
- 冲突或例外：原全部 completed 声明与浏览器证据范围不一致，已在 2026-10-22 复核纠偏；无已批准的缩范围或验收豁免。

### 正式落点

本次是局部缺陷修复，没有形成需要发布到 ADR、架构文档或指南的长期新规则；上述事实保留在本 Task。

### 反向检索验证

以 `tool-loop-guard`、`ToolLoopGuardError`、`模型服务请求失败` 检索 `docs/decisions`、`docs/architecture`、`docs/guides`、`docs/tasks` 与 Agent 实现路径。没有命中需更新的正式决策；`AGENT_TOOL_LOOP_GUARD` 与对应回归测试可由后续针对 Agent 错误归因的检索直接定位。

## Findings

- blocking：原浏览器终态错误场景未验收，verification blocked、consolidation pending；分类实现完成不等于整个 Task 完成。
- non_blocking：未消除 `rg ENOENT` 和搜索命令非零退出，它们仍可能触发工具失败保护；分类实现保留真实原因，实际浏览器错误场景仍待验证。
- decision_candidates：是否调整工具失败保护阈值或将“无匹配”改为非错误，需在独立 Task 中由 approver 决定。
- follow_up：先补齐原浏览器错误场景及验收证据；`rg` 路径和“无匹配”命令语义另建 Task 处理。
