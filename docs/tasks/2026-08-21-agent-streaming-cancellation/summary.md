# Agent 流式输出与取消链路收口

## 最终结论

Agent Chat Kit 已完成 Provider→Model Service→Agent→Chat 的真实流式、严格排序和可取消链路；代码与聚焦验证已完成，环境阻塞项已记录。

## 需求完成情况

- 支持 OpenAI-compatible 与 Anthropic Messages SSE，按 Provider 能力选择真实流式或一次非流式兼容路径；SSE 按 event framing 解析，忽略 `event`/`id`/`retry` 控制字段并支持一个事件多行 `data`。
- delta 携带 `requestId`、`generation`、连续 `sequence`；终态区分完成、取消、超时和失败。
- 流式响应设有集中且可测试的帧缓存、累计字节、delta 数量、文本字符和工具参数上限；超限返回稳定 `MODEL_SERVICE_INVALID_RESPONSE` 并取消 reader。
- Stop/AbortSignal 贯通 Provider reader、Model Service、Agent turn、web search、工具执行和审批等待。
- Agent/Chat 拒绝重复、乱序、晚到和旧 generation；完成快照仍是 Transcript 权威来源。

## 主要改动

- Model Service：符合 SSE event framing 的 parser、多行 data 合并、usage 增量合并、delta/terminal broadcast、streaming capability fallback、reader cancellation 与有限响应预算。
- Agent：model-service delta 订阅、requestId/generation/sequence 校验、Item delta 生命周期和 Agent message metadata 转发；按请求串行化 delta 持久化并在完成、取消或 step 终态前 drain。
- Chat：delta metadata 处理和 scheduler 的 generation/sequence gate。
- 文档：补充 Model Service streaming 与取消协议。

## 关键决定

- 跨 Plugin 仍使用既有 request/broadcast 消息路由；没有引入 Framework 全局事件、轮询或旁路。
- Provider 明确不支持 streaming 时只返回非流式最终快照，不伪造 token 增量。

## 验证结果

- Model Service、Agent adapter、Chat scheduler 与工具聚焦测试通过 58 项，覆盖真实 OpenAI/Anthropic SSE fixture、标准 SSE 控制字段、多行 data、非流式 fallback、超限取消 reader、取消 reader、Agent/Chat 顺序保护、工具/审批 AbortSignal。
- 目标源码严格类型检查通过：model-service、agent adapter/index、chat scheduler。
- `git diff --check` 通过。
- 目标 Plugin 其余测试中，依赖 `dompurify` 的 Chat markdown/transcript 测试因隔离 worktree 未安装包而无法启动。
- `node scripts/run-kit-matrix.mjs check agent-chat` 因隔离 Kit 安装环境缺少 `yazl` 阻塞。

## 影响与风险

- 浏览器验收依赖完整 Kit 构建产物和 Chat 运行依赖；当前阻塞项是环境依赖缺失，不是 Framework 或 Kit 边界缺口。
- 审批回归已由 `停止 turn 会把 AbortSignal 传到权限审批等待并记录 cancelled 终态` 覆盖；web search 的结构化 requestId 取消由 Model Service 原有 `Anthropic webSearch 使用结构化 requestId 并共享取消终态` 覆盖，bash/tool 取消由 `bash 取消后不会返回成功结果` 覆盖。
- 流式 delta 仅在 Provider 能力允许且 `stream: true` 时产生；未声明 streaming 的 Provider 仍保持兼容。

## 偏差与遗留

- 当前 worktree 无法完成依赖 `yazl`/`dompurify` 的完整 Kit check 与浏览器验收，已保留真实错误证据。

## 后续关注

- 在依赖齐全环境重跑 Kit build/validate、完整 Chat 测试和 Web 浏览器 Stop/切换会话验收。
- 继续观察真实 Provider 对 tool-call streaming SSE 字段差异的兼容性。

## 相关正式文档

- `docs/architecture/model-service-plugin.md`
- `docs/architecture/agent-turn-event-protocol.md`
