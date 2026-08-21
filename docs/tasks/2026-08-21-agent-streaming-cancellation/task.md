# 2026-08-21-agent-streaming-cancellation

Task ID: `2026-08-21-agent-streaming-cancellation`
Type: `feature`

## 背景与问题

Agent Adapter 对外暴露了 `onDelta` 和 AbortSignal 形状，但当前 Model Service 的 Provider 请求仍以非流式完整响应为主，Agent 侧没有把 Provider 增量稳定地转发给 Chat。用户因此只能在模型完成后看到聚合结果，无法及时判断模型是否仍在工作或在生成过程中停止。现有停止链路虽然可以取消部分 Model Service 请求，但 web search、工具执行和 UI 的晚到消息缺少统一的 generation/sequence 保护，取消后抵达的增量可能污染当前消息或恢复出的 Transcript。

本能力还依赖 `2026-08-21-model-service-contract` 的 caller、requestId 和错误终态，以及后续 Agent event protocol 对 Item 生命周期和事件排序的约定。流式实现必须在 Agent Kit 内完成，不以修改 Framework 的消息运行时来弥补协议缺口。

## 目标

实现从 Provider → Model Service → Agent Adapter → Chat 的真实、可取消、可排序流式输出：Provider 产生的增量在请求上下文内带有 `requestId`、单调 `sequence` 和 `generation`，Agent 与 Chat 能按序消费并在最终完成时得到与持久化结果一致的消息；用户点击 Stop 或上游 AbortSignal 后，Provider、web search 和正在执行的工具都及时停止，取消后的晚到 delta 不再影响当前或后续消息。

## 范围

- `kits/agent-chat/plugins/model-service` 的 Provider streaming 请求、chunk 解析/归一化、delta/complete 协议、请求取消和不支持流式 Provider 的兼容行为。
- `kits/agent-chat/plugins/agent` 的流式请求关联、`onDelta` 转发、generation/sequence 校验、Turn 终态、AbortSignal 贯通到 Model Service、web search 和工具执行。
- `kits/agent-chat/plugins/chat` 的 delta 接收、按序合并、generation 切换、取消/错误/完成终态展示和 Transcript 一致性。
- 上述 Plugin 内对应的单元、协议、装配测试和必要的 Web 浏览器验收；测试应覆盖正常完成、乱序/重复/晚到 delta、取消、超时、错误和不支持流式 Provider。

## 非目标

- 不修改 Framework、Gateway、Server、通用消息运行时或增加 Electron、桌面窗口、原生 IPC 等宿主假设。若现有 Framework 无法传递流式事件、AbortSignal 或可靠 caller/request 上下文，必须记录具体阻塞并停止越界修改。
- 不在本 Task 重新设计完整 Session/Turn/Item/Event Store 协议；只实现依赖既定 event protocol 所需的流式字段和适配，协议大改另立 Task。
- 不重新设计 Model Service 的 caller ACL、ErrorEnvelope、Provider capability 目录；这些由 `2026-08-21-model-service-contract` 提供，本 Task 只消费其稳定契约并补充流式所必需的适配。
- 不迁移会话存储、改变工具权限策略、修复文件路径越界或 SSRF。
- 不要求所有 Provider 都具备原生 streaming；对不支持者定义明确的兼容结果，不伪造不可用的逐 token 增量。

## 验收标准

1. 对具备 streaming 能力的 Provider，Model Service 发出真实流式请求并逐段解析文本、工具调用和终止信息；Provider 不支持或返回不兼容流式格式时，返回符合 Model Service contract 的稳定错误或按明确的非流式 fallback 完成，不能让请求无限等待。
2. 每个 delta 都携带原始 `requestId`、`generation` 和严格递增的 `sequence`；同一请求/代次不会重复使用序号，最终 complete/terminal 事件明确标记正常完成、取消或失败，并与最后一个有效 delta 关联。
3. Agent Adapter 实际调用 `onDelta` 并将增量广播给正确的 `conversationId`/message；Chat 在收到增量时即时显示内容，按 sequence 合并而不是简单覆盖，最终消息与 Model Service 的 complete 结果及持久化 Transcript 一致。
4. Chat、Agent 和 Model Service 均拒绝重复、乱序、未知 requestId 或旧 generation 的 delta；旧请求的晚到输出不能追加、覆盖或重新打开当前消息，也不能写入新的会话事件。
5. 用户 Stop 和任一上游 AbortSignal 能沿 Provider → Model Service → Agent → 工具链传播：底层模型请求、web search、正在执行的工具和等待中的权限请求都收到取消信号；取消结果在 UI 中显示为取消终态，而不是成功或未分类错误。
6. 取消具有幂等性：取消前已到达的有效 delta 可以保留在取消后的消息快照中，取消之后到达的 delta 全部丢弃；不会因竞态产生重复 complete、错误覆盖取消、悬挂 promise、继续写入或资源泄漏。
7. web search 和工具执行的 AbortSignal 覆盖网络请求、命令/搜索超时及等待过程；工具返回取消或失败时，Agent 不再向已取消的模型请求提交后续结果，并为 Turn 产生唯一、可诊断的终态。
8. 流式网络错误、Provider 错误、超时、用户取消和正常完成在 Agent/Chat 中可区分，并保留 model-service contract 定义的 `code`、`message`、`retryable`、`requestId`；不能把流式错误统一显示为成功或 `UNKNOWN`。
9. 覆盖至少一个真实 streaming Provider fixture、一个不支持 streaming 的 fallback/error fixture，以及正常完成、工具调用、web search、Stop、AbortSignal、重复/乱序/晚到 delta 和重连/切换会话场景；Model Service、Agent、Chat 聚焦测试与目标 Plugin 构建/manifest 检查通过。
10. 使用 Web 浏览器验收：可观察到文本逐步出现；点击 Stop 后生成及时停止且不会被晚到文本恢复；切换会话或重新打开会话不会显示旧 generation 的内容；正常完成、取消和错误状态均能正确展示。
11. 若实现过程中发现 Framework 才能提供必需的流式消息或取消能力，设计/验证记录必须列出调用方、缺失接口和影响，Task 标记为阻塞，不修改 Framework，也不通过未授权的全局事件或轮询旁路实现。

## 约束

- 仅修改 Agent Kit 内 Model Service、Agent、Chat 及其测试/协议说明；跨 Plugin 交互必须遵循 request/broadcast 消息约定，明确发送方、接收方、requestId、sequence、generation 和终态顺序。
- 依赖并遵守 `2026-08-21-model-service-contract` 的 caller 校验、ErrorEnvelope、timeout/cancel 和 Provider capability；不得为流式路径绕过这些校验。
- generation 在新 Turn、重试、取消后重启或消息替换时必须变化；sequence 只在单一 request/generation 内递增，不能使用客户端到达顺序代替协议序号。
- 流式输出需要背压、有限缓存和明确的最大响应/超时边界；不得无限累积 delta 或在取消后保留可继续写入的 reader/listener。
- 既有非流式 Provider 和历史会话保持可读；兼容 fallback 必须在 UI 和事件终态上可诊断，不得伪造逐 token 体验。
- 不在日志、错误、测试 fixture 或流事件中写入真实凭据、cookie、连接串或 Provider secret。按受影响 Plugin/Kit 取并集进行验证，并使用 Web 宿主完成可见行为验收。

## 需求变更

本 Task 将初始审计中“真正流式输出”和“完整取消链路”合并为一个独立 feature，并明确其前置依赖：先由 `2026-08-21-model-service-contract` 固化 caller、ErrorEnvelope、timeout/cancel 与 Provider capability，再由 Agent event protocol 提供稳定的 Item/事件关联。本 Task 的实现边界收窄为 Agent Kit 内 Provider→Agent→Chat 链路，不包含 Framework；若 Framework 能力不足，按验收标准记录阻塞并另行授权，不在本 Task 越界修改。
