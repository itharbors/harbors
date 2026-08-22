# Agent Chat Kit 跨插件装配回归总结

## 最终结论

已在真实 Agent Chat Kit manifest 和 Server Editor 装配边界上新增跨插件回归测试，覆盖正常流式 turn、工具审批拒绝、Stop/cancel、模型错误、会话切换、Agent 插件重启和晚到事件；未修改 Agent、Chat、Model Service 或 Framework 生产行为。

## 需求完成情况

- 已加载并断言 `conversation`、`chat`、`model-service`、`agent`、`plugin`、`preview`、`debug`、`settings`、`mermaid` 九个目标插件。
- 已断言 request/broadcast 路由、Model Service delta、Agent message/status、trace append 和 turn 终态。
- 已覆盖审批 asked/resolved、拒绝后的错误工具结果、历史恢复与旧 generation 晚到 delta 忽略。
- 已覆盖 Stop→Agent→Model Service cancel、`turn/end=cancelled`，Provider 错误的 `MODEL_SERVICE_HTTP_ERROR`/`failed` 终态，以及 conversation.select 切换后的重复晚到事件隔离。
- Web 宿主已完成可见验收：Agent Chat 正常装载，插件面板 13/13；Agent 插件重启后仍为已加载，且为 1 panel、20 requests、1 broadcast。
- Browser iframe 中点击“新建对话”未在消息调试中产生 `conversation.select`，确认该控制动作未送达，属于当前 Browser iframe 交互限制；对应替代证据已补齐（Panel mounted click→select(null)、SSE/bridge draft 广播、Chat 集成测试验证缓存 draft 与旧 `getState` 后 textarea/composer 可见）。

## 主要改动

- `kits/agent-chat/tests/assembly.test.ts`：真实 manifest、PluginModule、MessageModule 的 6 个装配回归用例；Provider HTTP 仅替换为本地可控 `fetch` 流，不替代插件协议。
- `kits/agent-chat/package.json`：`test:kit` 在 validate 后运行 `test:assembly`。
- `docs/architecture/agent-chat-kit-assembly.md`：固化装配插件清单、request/broadcast 顺序、审批终态和测试边界。
- `docs/guides/testing.md`：同步 Agent Chat Kit 的 test:kit 已包含 assembly 流程。

## 关键决定

- 使用真实 Kit 目录和真实插件 dist；只隔离不可控 Provider HTTP 响应与测试凭据存储。
- 审批拒绝记录为 `approval/resolved` 与错误 `tool/result`，当前 Agent 仍可向模型请求恢复回答，因此 turn 可正常完成；测试按当前实现断言，不引入产品行为。
- 重启验证通过卸载/重新加载 Agent 插件，历史从 runtime data storage 恢复；晚到的旧 `requestId`/`generation` delta 不改变 trace。

## 验证结果

- `pnpm --dir kits/agent-chat run test:kit`：通过，Kit validate + assembly，6 tests passed。
- `packages/server/node_modules/.bin/vitest run kits/agent-chat/tests/assembly.test.ts --config packages/server/vitest.config.ts`：通过，6 tests passed。
- `pnpm --filter @itharbors/server run typecheck`：通过。
- `node packages/kit-cli/dist/cli.js build kits/agent-chat`：通过，9 plugins。
- `git diff --check`：通过。
- `pnpm run kits:check agent-chat`：受临时 Kit 安装目录缺少 `yazl` 阻塞（`ERR_MODULE_NOT_FOUND`，来自 kit-cli archive 依赖），不是装配测试失败；已保留真实命令和错误证据。
- Web 浏览器验收：通过 Web 宿主确认 Agent Chat 装载和 13/13 面板可见；Agent 重启后保持已加载并恢复 1 panel、20 requests、1 broadcast。新建对话 iframe 点击因交互限制未送达 `conversation.select`，未伪造成功结果，使用 mounted/SSE/bridge/Chat 集成测试作为替代证据。

## 影响与风险

测试增加了真实 Kit assembly 的运行时间和对已构建插件产物的依赖；Kit 测试流程会先执行插件构建，再执行装配回归。Provider 只使用本地 `fetch`，不访问真实凭据或外部模型服务。

## 偏差与遗留

Browser iframe 的“新建对话”点击动作仍未形成 `conversation.select` 消息，这是已确认的宿主交互限制，不是装配测试或插件协议静默通过；替代测试证据覆盖了 click→select(null)、draft 广播以及恢复后的可见 composer。`kits:check` 的 `yazl` 缺失仍记录为临时 Kit 安装目录的环境问题，独立 `test:kit`、Kit build、Server typecheck 和 diff check 均已通过。

## 后续关注

若产品要求“审批拒绝必然结束 turn”，应另建 Agent 行为 Task；本测试按照当前协议验证拒绝工具结果后允许模型恢复回答的行为。

## 相关正式文档

- [Agent Chat Kit 装配与回归边界](../../../architecture/agent-chat-kit-assembly.md)
- [Agent Turn 事件协议](../../../architecture/agent-turn-event-protocol.md)
- [测试指南](../../../guides/testing.md)
