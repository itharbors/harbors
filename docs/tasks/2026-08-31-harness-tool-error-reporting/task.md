# 2026-08-31-harness-tool-error-reporting

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../2026-10-22-agent-turn-durability/summary.md)。

Task ID: `2026-08-31-harness-tool-error-reporting`
Type: `bug`

- 当前复核状态（2026-10-22）：implementation completed，verification blocked，consolidation pending；机器状态由主 Agent 通过 Task CLI 管理

## 背景与问题

本 Task 修复前，Harness 对话在工具失败保护或普通非模型异常结束时，会将终态错误统一显示为“模型服务请求失败”。已记录的对话 trace 表明，Turn 2 实际写入了 `tool-loop-guard` 停止事件，随后才被降级为 `UNKNOWN` 错误，导致用户无法判断真实原因。

## 目标

保留并展示工具失败保护、取消和模型服务错误各自的真实终态原因，使“模型服务请求失败”仅用于无法识别的模型服务异常。

## 范围

- 修改 `kits/harness/plugins/agent` 的错误封装与相关单元测试。
- 验证 Harness Chat 面板能显示工具失败保护的实际说明。

## 非目标

- 不调整工具失败保护的阈值或工具调度策略。
- 不修复 `rg` 的运行环境、全盘搜索策略或既有会话数据。
- 不改动 Framework、其他 Kit 或远端模型配置。

## 验收标准

- 工具失败保护结束的 Turn 具有可识别的错误 code 和原始停止原因。
- 普通取消与模型服务 HTTP 错误不再被错误显示为同一文案。
- 相关 Agent 单元测试通过，Harness 在浏览器中显示正确的终态错误说明。

### 2026-10-22 复核：实际证据边界

错误分类实现与对应局部测试已完成，但整个 Task 尚未完成。原档案曾将全部阶段记为 completed，该声明仅作为历史记录保留；2026-10-22 复核确认，Agent 单测和 assembly 覆盖错误 envelope 与终态消息，浏览器历史操作却只证明构建产物重载后的 Kit 可用，未触发工具失败保护并观察真实终态文案。原浏览器验收要求仍未完成，不能由局部测试替代。主 Agent 据此将 verification 改为 blocked、consolidation 回到 pending，implementation 保持 completed；证据见 [总结](summary.md)。

取消 envelope 使用既有 MODEL_SERVICE_CANCELLED 只说明错误分类，不证明 Stop 返回时 cancelled terminal 已持久化。流式先排队后广播和 Stop 超时仍 true 是 [Context Store Task](../2026-08-26-conversation-knowledge-base/task.md) 的另外两项可靠性缺口，不归入本次局部修复，也不由其局部测试替代验收。此次仅核对档案，不修改源码、重跑模型或扩展修复范围。

## 约束

- 仅在 Harness Kit 范围内修改，保持现有消息协议兼容。
- 当前工作区有用户未提交改动；目标文件 `harbors.ts` 已有不重叠的 Context Store 改动，实施前必须由用户选择执行环境。
- 不修改或清理既有工作区改动。

## 需求变更

原验收要求不变；没有已批准的缩范围或浏览器验收豁免。2026-10-22 是对原“全部 completed”声明及证据范围的复核纠偏，不将“只完成 Kit 重载验证”改写成满足原浏览器错误场景要求。

## 决策上下文与处置

### Decision Context

- 检索意图：定位 Harness 工具失败保护与对话终态错误归因的既有约束。
- 已检索范围：`docs/decisions`、`docs/architecture`、`docs/guides`、`docs/tasks` 及 `kits/harness/plugins/agent`，关键词为 `tool-loop-guard`、`ToolLoopGuardError`、`模型服务请求失败`。
- 检索结果：未发现针对该错误分类的已批准 ADR 或设计约束；命中的历史 Task 仅记录模型服务与 Agent 组装背景，不规定此处错误文案。
- 外部 memory：仅提供 Harbors 本地服务与 Context Store 的一般运行背景，未发现可直接约束本变更的已批准决策。

### 逐条处置与分工

- 错误类型保真：分类实现与局部测试已完成；原浏览器终态错误场景仍待验收，owner 为 Codex，不能据实现完成宣告整个 Task 完成。
- Kit 边界：适用，仅改 `kits/harness/plugins/agent` 及本 Task 档案；不触及 Framework。
- 角色：用户为 approver；Codex 负责实现与自检；代码审查由 Codex 在验证前独立执行，用户可追加人工审查意见。
- 角色反馈：用户已批准“修复试试吧”，未提出额外架构取舍。

### 过程关联

现有实现证据对应 Agent 错误封装、Turn 终态 trace 与针对性单测。仍须补齐本地 Web 浏览器中的工具失败保护场景，记录实际终态错误说明后，再由主 Agent 复核 verification 与 consolidation；本轮文档修订不执行该场景。
