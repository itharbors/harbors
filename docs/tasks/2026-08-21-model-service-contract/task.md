# 2026-08-21-model-service-contract

Task ID: `2026-08-21-model-service-contract`
Type: `bug`

## 背景与问题

Agent Kit 通过消息调用 Model Service 的 `complete`、`cancel` 和 `webSearch` 路由。当前路由声明了能力映射，但调用方边界没有形成可验证的协议约束，高成本的模型补全、取消和联网搜索可能被不应具备权限的插件或面板调用。与此同时，Model Service 内部已经区分了未配置、网络、超时、取消、上下文超限和响应无效等错误，但跨插件返回到 Agent 后仍可能被归并为 `UNKNOWN`，调用方无法据此决定是否重试、展示错误或结束 Turn。

模型目录暴露了 reasoning effort 和 service tier 等选项，Provider 协议也有超时与联网搜索能力，但目录声明、请求参数和实际 Provider 支持之间缺少一致性校验。这样会导致用户选择了 Provider 不支持的能力、无效参数被发送到 Provider，或超时和取消的语义不一致。

## 目标

建立可执行的 Model Service 调用契约，使高成本路由只接受受声明的 Agent 调用方，并让错误、取消、超时和模型能力在 Model Service、Agent Adapter 与 Provider 之间保持稳定、一致且可观察。

交付后应满足：

- `complete`、`cancel` 和 `webSearch` 的调用方身份可验证，未授权调用在发起 Provider 请求前被拒绝。
- Model Service 对外返回统一的 `ErrorEnvelope`，至少保留稳定的 `code`、面向调用方的 `message`、`retryable` 和关联的 `requestId`；Agent 不再把已知错误统一改写为 `UNKNOWN`。
- reasoning effort、service tier、timeout 和 web search capability 只接受当前 Provider 实际支持的值，并以一致的方式传递、拒绝或降级。
- 既有 Agent 调用、取消和错误处理仍能在该契约下运行，后续流式 Task 可以复用同一套 request 关联和错误语义。

## 范围

- `kits/agent-chat/plugins/model-service` 的消息路由、Provider 请求适配、模型目录能力声明、错误归一化、超时和取消语义。
- `kits/agent-chat/plugins/agent` 中为兼容新契约所必需的调用参数、错误传播和能力消费适配。
- 上述 Plugin 内对应的单元测试、协议测试、manifest/构建检查和必要的中文协议说明。
- 对 `complete`、`cancel`、`webSearch` 明确 caller allowlist/capability 的消息协议；读配置等低成本设置操作若不属于高成本路由，可继续按现有权限模型处理，但不得借此绕过高成本路由校验。

## 非目标

- 不在本 Task 实现 Provider 到 Agent 到 Chat 的完整 token 流式输出；该能力由 `2026-08-21-agent-streaming-cancellation` Task 负责。
- 不重做 Session/Turn/Item 事件协议、事件排序、Event Store 或 Chat Transcript 重建；这些属于 Agent event protocol Task。
- 不修改 Framework、Gateway、Server 或消息运行时的 caller 身份机制。若现有 Framework 无法提供可靠的调用方身份，必须在设计/验证记录中明确阻塞，停止越界修改，不以不安全的自定义旁路替代。
- 不新增桌面宿主、Electron、原生 IPC 或其他非 Web 宿主假设。
- 不在本 Task 扩展新的 Provider 类型、模型供应商或业务级联网搜索产品能力；只校准已有 Provider 支持的协议。
- 不迁移 Agent 会话存储、改变工具沙箱、处理 SSRF 或文件路径越界问题。

## 验收标准

1. 对 `complete`、`cancel` 和 `webSearch` 分别建立未授权、已授权和边界调用测试：未授权调用返回稳定的权限错误，且 Provider、网络搜索和凭据访问均未被触发；Agent 的合法调用可以完成原有流程。
2. caller 身份校验使用现有可靠的插件消息上下文或已批准的 capability 机制，并校验路由、调用方和请求关联；不能仅依赖用户可控的普通请求字段。若该身份信息只能由 Framework 提供，验收结果必须明确记录为阻塞，且本 Task 不修改 Framework。
3. 所有跨 Model Service/Agent 的失败响应都符合 `ErrorEnvelope`：`code` 为稳定机器码，`message` 不泄露凭据或内部敏感信息，`retryable` 与错误类别一致，`requestId` 与原请求一致；至少能区分未授权、未配置、无效输入/能力、网络、Provider HTTP、超时、取消、上下文超限和无效响应。
4. Agent 在 Turn 结束事件、用户可见错误和重试判断中保留上述错误码与 `retryable`，已知 Model Service 错误不得被无条件转换成 `UNKNOWN`；未知异常仍有明确的兜底错误并保留原始 request 关联。
5. 对 reasoning effort、service tier 和 timeout 的输入进行边界校验：支持值来自实际 Provider/model 能力目录；不支持或格式非法的值在 Provider 请求前被拒绝并返回可识别错误；未配置的可选值不会被伪造或发送为不支持的默认值；timeout 有明确单位、上限和超时终态。
6. web search capability 与 Provider/配置实际能力一致：不支持时在调用前返回稳定的“不支持”错误，支持时使用既有凭据和超时/取消语义，不把搜索能力静默宣称给不支持的模型；搜索错误同样符合 `ErrorEnvelope`。
7. 取消请求具备幂等结果：活动请求可被取消并让底层 Provider/搜索请求停止；已完成、未知或重复取消分别返回可区分的稳定状态，并与原 `requestId` 关联；超时不会留下可继续写入结果的活动请求。
8. 为 Model Service 和 Agent 运行聚焦单元/协议测试，覆盖上述正反例、错误字段保留、能力校验、超时与取消；目标 Plugin 的构建或 manifest 检查通过，且不引入 Framework 变更。
9. 在依赖的 Agent event protocol 与流式 Task 接入前，提供可复用的 request 关联和错误协议测试样例；若发现既有消息协议不足以承载 caller 或 `ErrorEnvelope`，在 Task 设计记录中列出具体缺口与阻塞，而不是扩大本 Task 范围。

## 约束

- 仅修改 Agent Kit 的 Model Service/Agent 相关边界及其测试、协议文档；不得修改 Framework。跨 Plugin 的适配必须保持 request/broadcast 消息约定，并写清发送方、接收方和终态。
- 不破坏已有会话和配置的读取；新增字段应向后兼容，旧请求要么按明确兼容规则处理，要么返回可诊断错误，不能静默改变 Provider 语义。
- caller 校验、错误映射和能力校验必须在服务端/宿主侧执行，不能只依赖 Chat UI 隐藏按钮。
- 不在错误、日志或测试 fixture 中写入真实 token、cookie、连接串或 Provider 密钥；对外错误消息采用安全的摘要。
- 需求验证按受影响 Plugin 取并集；若变更影响 Kit 可见行为，补充 Web 浏览器验收，但不以桌面宿主为测试目标。
- 本 Task 是流式与取消 Task 的前置契约；后续 Task 不得绕过这里定义的 caller、requestId 和错误终态。

## 需求变更

相较于最初对 Agent Kit 的问题清单，本 Task 将 Model Service 的高成本调用授权、稳定错误协议和 Provider 能力一致性合并为一个可独立验收的 bug Task；完整流式输出、晚到 delta 丢弃和跨工具 AbortSignal 贯通另立 `2026-08-21-agent-streaming-cancellation` feature Task。实施边界明确收窄为 Agent Kit 内的 Model Service 与 Agent 适配，不包含 Framework；若 caller 身份机制必须由 Framework 提供，则按本 Task 的约束记录为阻塞并等待单独授权。
