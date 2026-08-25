# Harbors Harness Kit 装配与回归边界

Harbors Harness 的组合测试属于 `kits/harness/tests/`，不是 Framework 的业务测试。Framework 只拥有通用的
Plugin runtime harness、Kit assembly harness 和 Web Host 进程 runner；Chat、Conversation、Agent、Model Service
和页面的业务断言由 Harbors Harness Kit 自己拥有。

## 公开测试边界

Framework 通过 `@itharbors/server/testing` 提供测试用 export。Kit 测试只依赖这个公开边界和 Kit-local fixture，
不得 import `packages/server/src/**`、`packages/server/tests/**` 等私有源码，也不应直接操作 `createEditor`。

### Plugin runtime harness

`createPluginRuntimeHarness({ pluginPath, ... })` 真实 register/load 一个 Plugin，返回：

- `plugin.load()`、`plugin.unload()`、`plugin.call()`、`plugin.info()` 和 `plugin.isLoaded()`；
- `messages`，用于真实 request、requestFrom、broadcast、外部 request/broadcast route 注册、查询和注销；
- `observer`，以 `MessageTraceEvent.sequence` 记录 request/broadcast 的 caller、owner、name/topic 和 args；
- `dispose()`，负责 unload、消息模块销毁和 harness 自己创建的临时数据根清理。

`externalRequests`、`externalBroadcasts`、`applicationRequest` 和 `credentials` 是 Plugin 外部边界的 test
double。被测 Plugin、Plugin System、runtime message 和生命周期保持真实；该 harness 不加载完整 Kit。

### Kit assembly harness

`createKitAssemblyHarness({ kitDirectory, projectRoot?, kitName?, ... })` 真实创建 assembly 并加载 Kit descriptor、
布局和 Kit 声明的全部 Plugin，返回：

- `kit.load()`、`kit.current()` 和 `kit.plugins()`；
- `plugin.loaded()`、`plugin.info(name)` 和真实 `plugin.call(plugin, method, ...args)`；
- 与 Plugin harness 同契约的 `messages`、`observer` 和 `dispose()`。

Kit 可以通过 `externalRequests`、`externalBroadcasts`、`applicationRequest` 和 `credentials` 模拟 Kit 外部的
服务，但不能 mock Plugin、Plugin System、MessageModule 或跨 Plugin 路由。这样 assembly 测试验证的是真实组合，
而不是由 mock 重新实现的组合。

## Web Host runner 边界

Framework 的 `scripts/lib/web-host-runner.mjs` 导出 `startWebHost(options)`，当前实现负责：

1. 校验绝对 `repositoryRoot`、非空 `kitSources`、`defaultKit` 和超时参数；
2. 分配 Gateway、Server、Client、notification 四个隔离端口；
3. 默认创建临时数据根，也允许调用方显式传入外部持久根；runner 清除继承的数据库/Plugin 细分路径覆盖，只向三个进程传入统一 `HARBORS_DATA_ROOT`、Kit sources、default Kit 和端口；
4. 启动 Gateway、Server、Client，轮询 Gateway `/api/health`，保存有限 stdout/stderr 日志；
5. 返回 `baseUrl`、`ports`、实际 `dataRoot`、`tempRoot`、`logs`、`health()` 和幂等 `stop()`；
6. 停止时按逆序发送 SIGTERM，超时后对仍存活的子进程发送 SIGKILL，最后只删除 runner 自建临时根；外部 data root 必须位于临时根之外，正常停止和启动失败都不得删除它。

runner 只把 Gateway 绑定到 IPv4 wildcard `0.0.0.0`，使隔离 Web Host 可以通过主机 IPv4 地址验收远程授权流程；Server 与 Vite Client 仍绑定 `127.0.0.1`，内部 health polling 也继续使用 loopback `baseUrl`。因此 Gateway 是唯一对外端口，上游不能绕过其转发地址清洗与授权边界。

runner 只管理进程、端口、健康检查、日志和清理，不知道任何 Kit 的名称语义、Panel、对话、业务 request、broadcast
或页面内容。完整 Web Host smoke 的业务测试归目标 Kit；Harbors Harness 的 Kit-owned smoke wrapper 只调用这个通用
runner 并执行公开 HTTP 断言，不直接操作 `createEditor` 或 Server 私有源码。runner 的自动化测试仍只验证通用进程
契约和隔离清理，不要把它写成 Kit 业务 smoke。

## Harbors Harness 装配来源

Harbors Harness 的 Kit manifest 声明九个 Kit Plugin：`conversation`、`chat`、`model-service`、`agent`、`plugin`、
`preview`、`debug`、`settings` 和 `mermaid`。Server assembly 还会先加载通用 Framework 插件 `panel`、
`message`、`menu`、`config`。测试必须通过真实 Kit assembly 观察这条装配路径，不能用孤立 MessageModule 替代。

本文记录已经落地的装配契约和回归链路。Harbors Harness 已声明 `test:plugin`、`test:assembly`、`test:kit` 和
`smoke`：前两者分别验证单 Plugin runtime 与完整 Kit assembly，后者验证真实 Gateway/Server/Client 的公开
HTTP。浏览器验收是独立层级，已确认 13/13 声明 Plugin 加载且无 console error。

## request/broadcast 顺序

### 普通流式 turn

1. Chat/Conversation 面板通过真实 Panel/transport request `agent.createConversation` 或 `agent.sendMessage`。
2. Agent 定向 request `model-service.getCatalog` 或 `model-service.complete`；流式请求携带 request identity 和
   generation。
3. Model Service 收到外部 Provider 的确定性 test double 响应后 broadcast `model-service.complete.delta`。
   Agent 只接受匹配 request identity、generation 且 sequence 单调的 delta。
4. Agent 将模型增量 broadcast 为 `agent.message.delta`，供 Chat 更新可见消息。
5. Agent 每次持久化 trace 后 broadcast `agent.conversation.trace.append`；Chat 使用 conversation、turn、item
   和 sequence 重建 transcript，最终 snapshot 作为 item 完成状态。
6. Agent broadcast `agent.message.status`，并以 `turn/end` 记录 `completed`、`failed`、`cancelled`、
   `timed_out` 或 `rejected` 终态。

### 审批回环

1. Agent 先持久化审批请求，再 broadcast `approval/asked`。
2. Chat 以相同的 conversation、turn、item 和 request identity request `agent.resolvePermissionRequest`。
3. Agent 持久化并 broadcast `approval/resolved`；拒绝的工具调用形成带错误的真实 tool result，后续 turn 是否
   恢复由 Agent 实现决定，不能由测试 mock 直接伪造终态。

测试使用 harness observer 断言上述 request/broadcast 的顺序、owner/topic、关联键、payload 和终点；对错误、
拒绝、取消、重启和迟到 delta 也必须断言清理及当前会话隔离。

## 命令与证据

当前可直接验证通用实现和 Harbors Harness Kit 的命令是：

```bash
pnpm --filter @itharbors/server exec vitest run tests/framework/testing-harness.test.ts
node --test scripts/lib/web-host-runner.test.mjs
pnpm --dir kits/harness run test:plugin
pnpm --dir kits/harness run test:assembly
pnpm --dir kits/harness run test:kit
pnpm --dir kits/harness run smoke
pnpm run kits:test <slug>
pnpm run kits:check <slug>
```

`test:plugin` 只加载 Conversation Plugin 并模拟 Plugin 外 request/broadcast；`test:assembly` 通过公开 testing
harness 加载全部声明 Plugin 并验证真实组合消息链路；`test:kit` 依次执行 validate、前两者；`smoke` 启动真实
Gateway、Server、Client 并通过公开 HTTP 验证 health、Kit catalog、redirect 和页面 HTML。自动 smoke 不执行
浏览器点击或页面交互；浏览器验收单独确认 13/13 Plugin 加载和无 console error。`kits:test` 构建 toolchain 和
目标 Kit 后执行其声明的 `test` script；`kits:check` 在 build、test、validate 后只对声明了 `harbors.scripts.smoke`
的 Kit 执行 smoke，并在适用时执行制品检查。每次实际验证仍需在 Task summary 或 `.work/` 记录命令、退出结果、
边界和未覆盖风险。

## 测试发现与清理

Vitest 使用目标 package 作为 root 或显式目标文件；不得扫描仓库 `.worktrees/`，从仓库根启动的配置必须显式排除
`**/.worktrees/**`。Kit assembly 命令不能通过扩大 root 来发现同名 worktree 测试。

所有 harness 和 Web Host smoke 必须在 `afterEach`/`finally` 中 dispose/stop，释放 Plugin listener、子进程、端口、
临时数据和日志。测试不得读取用户家目录、共享进程或其他 worktree。
