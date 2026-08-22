# Agent Turn 事件协议收敛

## 需求完成情况

- 在 Agent Adapter 建立 `conversationId`、`turnId`、`itemId`、`requestId` 的事件关联类型和旧 trace 归一化逻辑；新写入事件同时在顶层与 `data` 携带关联键，旧 JSONL 缺省字段按兼容规则读取。
- 为用户消息、模型消息、推理、工具调用、工具结果和审批写入 `item.started`、`item.delta`、`item.completed` 生命周期，并以 completed snapshot 作为最终权威状态。
- 为审批写入 `approval/asked` 与 `approval/resolved`，校验会话/turn/item/request 关联；批准、拒绝、取消、不可用和超时均为显式终态。Turn 结束区分 completed、failed、cancelled、rejected、timed_out。
- Chat 增加按会话及单调 seq 应用事件的 reducer：重复、冲突、旧事件、未知 discriminator、缺失 started 或错误关联不会覆盖已应用状态；待审批只保留 waiting 项。
- Chat 保留既有 trace/parser 和旧 surface 行为，新增 cancelled/rejected/timed_out 的终态展示；补充中文架构说明与协议聚焦测试。

## 主要改动

- `agent/main/src/adapter/base.ts` 与 `protocol.ts` 定义关联键、Item discriminator/phase、终态和旧事件归一化。
- `agent/main/src/adapter/harbors.ts` 为 JSONL 事件、消息、模型请求、工具、审批和 Turn 写入协议字段与生命周期。
- `chat/panel.main/src/event-protocol.ts` 提供按 seq、会话、关联键收敛 Item/审批状态的 reducer；面板传递审批关联键。
- `trace-events.ts` 与 `transcript.tsx` 兼容旧 trace，并展示取消、拒绝、超时终态；补充架构文档和聚焦测试。

## 关键决定

- Agent 负责分配并持久化 seq，Chat 只按会话和 seq 应用事件，不在 renderer 侧生成顺序。
- Item 的 completed snapshot 是唯一最终权威；delta 只用于实时预览，非法生命周期和未知 tag 显式拒绝。
- 审批响应必须携带并匹配同一组 request/turn/item/conversation 关联；超时、取消、拒绝均广播 resolved/terminal 事件。

## 验证结果

- `pnpm exec tsx --test kits/agent-chat/plugins/agent/main/src/adapter/trace-storage.test.ts kits/agent-chat/plugins/agent/main/src/adapter/model-service.test.ts kits/agent-chat/plugins/agent/main/src/index.test.ts`：22/22 通过。
- `pnpm exec tsx --test kits/agent-chat/plugins/chat/panel.main/src/*.test.ts`：87/87 通过。
- Agent 与 Chat 相关源文件 TypeScript `tsc --noEmit`：通过。
- `pnpm --filter @itharbors/magnet --filter @itharbors/kit-core --filter @itharbors/kit-cli run build`：通过（其中 magnet 实际 package 位于 `packages/plugin`）。
- `pnpm --dir kits/agent-chat run build`：通过。
- `pnpm --dir kits/agent-chat run test:kit`：通过，输出 `KIT_ID=agent-chat`、`KIT_VERSION=0.0.1`、`FILES=8795`。
- `git diff --check`：通过。
- 本地 Web 启动尝试未完成：gateway/server/client 依赖的 `@itharbors/host-security/dist/index.js` 尚未构建，dev stack 在启动阶段退出，因此未进行浏览器验收；该阻塞不由本 Task 文件引入。

## 范围与风险

变更仅涉及 `kits/agent-chat/plugins/agent`、`kits/agent-chat/plugins/chat`、本 Task 文件和直接相关的中文架构文档；未修改 Framework/Gateway/Server 或 Provider streaming。当前真实 Provider streaming 仍由后续 Task 负责；旧 trace 的 `turnId` 使用 `legacy-turn-<n>` 兼容标识，不回写历史语义。

## 影响与风险

- 旧 JSONL 继续可读；首次读取时内存中补齐兼容字段，只有原有 seq 修复逻辑触发时才重写日志。
- Item 协议不会替代后续 Provider streaming；当前非流式响应以单次 delta 形成生命周期。
- 本地 Web 验收被共享开发栈缺失 `@itharbors/host-security/dist/index.js` 阻塞，未将该环境问题扩大为本 Task 代码变更。

## 偏差与遗留

- 未修改 Framework、Gateway、Server 或 Provider streaming，符合 Task 非目标和文件边界。
- 旧 trace 没有原始 turnId 时使用 `legacy-turn-<n>`，无法声称与未来真实 UUID 相同，但不影响历史 Transcript 内容。

## 后续关注

- `2026-08-21-agent-streaming-cancellation` 继续复用本 Task 的 Item、requestId 和显式终态协议，接入真正增量 Provider 流。
- 共享开发栈补齐 host-security 构建产物后，重新运行 Web 浏览器验收。

## 相关正式文档

- [Task 需求快照](./task.md)
- [Agent Turn 事件协议](../../architecture/agent-turn-event-protocol.md)

## 最终结论

协议实现、聚焦测试、Kit 构建与验证已完成。浏览器验收受共享开发栈缺失 `@itharbors/host-security/dist/index.js` 阻塞，已如实记录；其余 ready gate 前置条件均已满足。
