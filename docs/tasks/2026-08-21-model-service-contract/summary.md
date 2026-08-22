# Model Service 调用契约实现总结

## 最终结论

Model Service 与 Agent 之间的高成本调用已形成可执行、可验证的消息契约：`complete`、`cancel` 和
`webSearch` 只接受 Framework 识别出的 `agent` caller；进入 Model Service 后的失败统一保留稳定
`ErrorEnvelope`；模型能力、请求超时、取消终态和 requestId 关联在目录、Agent Adapter 与 Provider
请求之间保持一致。专项测试、Plugin 构建检查、Kit 装配验证、预检和 Web 浏览器验收均已完成。

## 需求完成情况

- `complete`、`cancel`、`webSearch` 在 Model Service manifest 中声明 `callers: ["agent"]`，不依赖
  用户可控的普通请求字段表达 caller；无 caller 的直接 `complete` 请求由 Framework 在 handler 前拒绝。
- Model Service handler 产生的错误使用 `code`、安全 `message`、`retryable` 和 `requestId` 组成的
  `ErrorEnvelope`；Agent Adapter 保留已知错误及 request 关联，未知异常才降级为 `UNKNOWN`。
- reasoning effort、service tier 与 web search 能力按“配置声明与 Provider Adapter 实际支持的交集”
  生成目录并校验；不支持的值在 Provider 请求前以 `UNSUPPORTED_CAPABILITY` 拒绝。
- `complete` 与 `webSearch` 共用 active/terminal request registry，timeout 和 cancel 均产生稳定、可查询的
  请求终态，requestId 不可在活动或已记录终态中复用。
- Agent 的正常 Turn、compaction、Web Search 和中止路径已适配结构化请求；用户可见错误与 `turn/end`
  事件不再无条件丢失 Model Service 错误码。

## 实现范围与完整消息链路

### Model Service 请求链路

1. Agent 先通过 `request model-service.getCatalog()` 读取安全模型目录和配置状态。
2. Agent 为每次 Turn 或 compaction 生成不透明 `requestId`，通过定向
   `request model-service.complete(input)` 发送 Provider-neutral messages、tools、模型选择及可选能力参数。
3. Framework 从受信消息上下文取得 caller，根据 Model Service manifest 校验 `agent` allowlist；通过后才
   调用 Model Service handler。caller 不是请求体字段，也不能由调用方自行声明。
4. Model Service 校验 requestId、输入、模型能力与 timeout，登记 active request，再读取自身配置和凭据、
   构造 OpenAI-compatible 或 Anthropic 请求并执行单次非流式 HTTP 调用。
5. Model Service 通过 request response 返回规范化 assistant message/tool calls/usage，或通过 request reject
   返回 `ErrorEnvelope`；Agent 继续执行工具循环，并向 Chat 广播既有 message、trace 和 status 主题。
6. 下一步工具循环由 Agent 使用新的 requestId 再次发起 `complete`，Model Service 不持有 Agent 会话语义。

### Web Search、取消与超时链路

- Agent 的 Web Search 只发送结构化 `{ requestId, query, timeoutMs? }`；Framework 完成同样的 caller ACL
  后，Model Service 仅在当前 Anthropic model 明确声明 `webSearch: true` 时调用 Provider web-search tool，
  并返回 `{ requestId, result }`。字符串或缺少关联字段的旧输入以 `INVALID_INPUT` 拒绝。
- Agent signal 中止时，另发定向 `request model-service.cancel({ requestId })`；Model Service 查询
  `complete`/`webSearch` 共享 registry，中止 fetch 或 retry 退避，并返回与原请求关联的取消状态。
- 请求预算以毫秒计，实际 timeout 取 Provider 配置、系统/注入上限与 caller 请求值的最小值；caller 只能
  缩短预算，不能延长上限。超时会中止底层工作、reject `MODEL_SERVICE_TIMEOUT` 并记录 `timed_out` 终态，
  不允许迟到结果继续写入。

### 配置与广播链路

1. Model Service Settings Panel 以绑定的 `model-service` caller 定向请求
   `saveProvider`、`deleteProvider` 或 `resetProviderCredential`。
2. Model Service 在自己的 Plugin Config/Credential Vault 边界内完成写入；只有写入成功才重新生成目录并
   增加 revision。
3. Model Service 广播 `model-service.catalog.changed`，payload 仅含安全 catalog、revision 和变化原因；
   Chat 订阅后刷新模型目录/配置状态。广播不携带真实凭据、credential ID 或内部配置引用。

## 关键决定

- **Trusted caller ACL**：`complete`、`cancel`、`webSearch` 的 `agent` caller allowlist 由 Framework 现有
  消息上下文与 manifest 路由校验执行。无 caller 的直接请求在进入 Model Service 前被拒绝，因此不会触发
  Provider、网络搜索或凭据读取，也不包装成 Model Service `ErrorEnvelope`。
- **ErrorEnvelope**：进入 handler 后的输入、能力、未配置、Provider HTTP、上下文超限、无效响应、网络、
  timeout、cancel 和停止错误统一提供稳定 `code`、安全 `message`、`retryable`、`requestId`。Agent 同时
  兼容 Error 实例和消息桥反序列化后的普通对象，并把 envelope 写入 `turn/end`。
- **能力交集**：OpenAI-compatible Adapter 可暴露并映射已配置的 `reasoningEfforts`/`serviceTiers` 到
  `reasoning_effort`/`service_tier`；Anthropic 不宣称或发送这两项。Web Search 只对显式配置该能力的
  Anthropic model 可用，避免目录宣称 Provider 实际不支持的能力。
- **超时语义**：`timeoutMs` 必须是正安全整数且不超过 600000ms；请求值只用于缩短 Provider 与系统预算。
- **取消语义**：`cancel` 返回 `cancelled`、`already_cancelled`、`completed`、`timed_out`、`failed` 或
  `not_found`，重复取消、完成后取消、超时后取消和未知 requestId 均可区分。Plugin unload 会中止活动请求，
  对应 request reject 为 `MODEL_SERVICE_STOPPED`，registry 终态对 cancel 表示为 `failed`。
- **Plugin 边界**：Model Service 负责配置、凭据、能力、Provider HTTP、重试、超时、取消与响应归一化；
  Agent 负责会话、Turn/compaction、工具循环、用户可见事件与广播。两者只通过 request/broadcast 通信，
  没有直接 import 对方实现。

## 主要改动

- Model Service manifest 为三个高成本 request 增加 `agent` caller ACL。
- Model Service 增加稳定错误类型、结构化 Web Search 输入输出、完整取消状态、共享请求 registry、能力校验
  和分层 timeout 预算；配置归一化与 Settings Panel 保留模型能力字段。
- Provider 协议按实际 Adapter 能力生成有效 catalog，并只向 OpenAI-compatible payload 映射受支持的
  reasoning effort 与 service tier。
- Agent Adapter 透传会话选择的能力和 timeout，使用结构化 cancel/Web Search 请求，取消时复用同一
  requestId，忽略取消后的迟到搜索结果，并在事件和抛出错误中保留 Model Service envelope。
- 更新 `docs/architecture/model-service-plugin.md`，记录 ACL、错误、能力、timeout、cancel、Web Search、
  配置广播以及完整 request/broadcast 顺序。

## 验证结果

- `pnpm exec tsx --test $(rg --files kits/agent-chat/plugins/model-service/main/src kits/agent-chat/plugins/model-service/panel.settings/src | rg '\.test\.ts$')`：通过，40/40。
- `pnpm exec tsx --test $(rg --files kits/agent-chat/plugins/agent/main/src kits/agent-chat/plugins/agent/panel.settings/src | rg '\.test\.ts$')`：通过，26/26。
- `node scripts/ce-plugin.mjs build kits/agent-chat/plugins/model-service` 与对应 `check`：通过。
- `node scripts/ce-plugin.mjs build kits/agent-chat/plugins/agent` 与对应 `check`：通过。
- `pnpm --dir kits/agent-chat run build`：通过；随后
  `node packages/kit-cli/dist/cli.js validate kits/agent-chat`：通过（9 plugins，8795 files）。
- `pnpm run check:preflight`：通过。
- Web 浏览器验收：Agent Chat Kit 13/13 Plugin loaded；Agent 合法调用进入 Model Service 后返回
  `MODEL_SERVICE_NOT_CONFIGURED`，Chat UI 保留中文错误“模型服务未完成配置”，未被改写为 `UNKNOWN`。
- ACL smoke：不带 caller 直接请求 `model-service.complete` 被 Framework 拒绝，未进入 Model Service handler。
- `git diff --check`：通过。

## 影响与风险

- `pnpm run kits:check agent-chat` 未进入目标 Kit 测试：isolated runner 创建的临时仓库中，kit-cli 因缺少
  `yazl` 报 `ERR_MODULE_NOT_FOUND`。这是已有基础设施问题，不是本次 Plugin 测试失败；已用工作区内
  Agent Chat build、kit-cli validate（9 plugins，8795 files）、两个目标 Plugin 的完整测试与 build/check、
  预检和真实 Web 验收替代覆盖。

## 偏差与遗留

- 本 Task 未修改 Framework、Gateway 或 Server；caller 能力足以复用既有可信上下文与 manifest ACL，
  因此没有扩大到消息运行时实现。
- 当前契约只覆盖非流式 `complete`。没有实现 Provider → Agent → Chat 的 token streaming，也没有重做
  Agent event protocol；后续流式 Task 可复用本次 requestId、ErrorEnvelope 和终态语义。
- terminal registry 使用有界内存记录近期终态；跨 Plugin 重启不承诺保留历史取消状态。

## 后续关注

- 在 `2026-08-21-agent-streaming-cancellation` 中复用 requestId 和错误/终态契约，单独设计增量广播与
  流式取消，不改变本次非流式 `complete` 的兼容语义。
- isolated Kit runner 补齐 `yazl` 依赖后，应重新运行 `pnpm run kits:check agent-chat`，恢复标准隔离验证。

## 相关正式文档

- [Task 需求快照](./task.md)
- [Model Service Plugin 架构](../../architecture/model-service-plugin.md)
