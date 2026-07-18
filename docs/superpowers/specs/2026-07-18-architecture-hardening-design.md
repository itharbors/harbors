# itharbors 架构治理设计

日期：2026-07-18

## 1. 背景

当前项目已经从旧目录迁移到 `packages/`、`plugins/`、`kits/` 和 `scripts/`，并形成以 Kit 组装插件、服务端维护 Editor、客户端渲染工作台的架构。现有实现证明了插件化方向可行，但仍有几类基础问题：

- 插件加载通过 `globalThis.editor` 注入运行时，并发加载可能发生会话串线。
- Kit 切换和插件卸载不是完整事务，失败后可能留下部分状态。
- Session 数据、Editor 实例及其资源没有统一销毁生命周期。
- 客户端、服务端和 `plugin-types` 重复定义跨端协议，已经出现漂移。
- HTTP 路由各自读取和解析请求体，缺少大小限制及统一错误语义。
- browser-targeted request 只有部分构件，没有完整请求、响应、超时和断连链路。
- Panel iframe 未声明 sandbox；SSE 缺少心跳和完整断连清理。
- 迁移后仍有测试引用已删除的 `scene-editor` Kit，根 `check` 脚本还会启动长期运行的开发服务。

本设计在保留现有插件 API 和目录迁移结果的前提下，修复上述问题并建立可持续的架构边界。

## 2. 目标

本轮治理必须达到以下结果：

1. 不同 Session 或 Editor 并发加载插件时，运行时上下文不会串线。
2. Kit 切换具有明确的提交和回滚语义，失败后恢复切换前的可用状态。
3. Session 删除和服务器停止会释放对应的 Editor 及其模块资源。
4. 跨端协议只有一个权威定义，并具有显式协议版本。
5. 所有 JSON API 具有一致的请求限制、校验方式和错误响应。
6. browser-targeted request 可以完成请求、派发、响应、超时与断连清理。
7. Panel iframe 使用最小可用 sandbox 权限，SSE 连接能够保活并可靠清理。
8. 当前仓库的检查命令有限时长、可重复运行，且不再引用已删除的 Kit。

## 3. 非目标

以下内容不在本轮范围内：

- 把服务端插件视为不可信代码并提供操作系统级安全边界。
- 为插件实现完整权限授权 UI、签名、商店审核或供应链验证。
- 使用持久化消息队列保证 SSE 消息离线投递。
- 恢复已经从当前迁移结果中删除的 `scene-editor` Kit。
- 借架构治理之机重写现有 UI、菜单、布局或插件业务功能。

服务端插件在本轮仍是项目内可信代码。设计会保留未来接入 Worker 或子进程运行器的边界，但不会提供“看起来隔离、实际仍共享 Node 权限”的伪沙箱。

## 4. 方案选择

### 4.1 完全信任并只修补故障

该方案只增加加载锁和销毁方法，改动最小，但 iframe、协议和 HTTP 边界仍然薄弱，不能解决已经识别的完整问题集。

### 4.2 渐进隔离

该方案保留可信服务端插件和现有入口格式，修复运行时串线与事务问题；同时收紧浏览器 iframe、HTTP 和跨端协议边界。未来如果需要第三方插件，只替换插件执行适配层，而不改变 Editor 的领域接口。

这是本设计采用的方案。它能覆盖当前真实风险，又不会把治理扩大为插件平台重写。

### 4.3 立即实施零信任插件沙箱

该方案需要子进程或 Worker、RPC 序列化、权限 manifest、资源配额、崩溃恢复及独立资源 origin。安全上限最高，但会改变插件 API、调试方式和部署模型，不适合与当前迁移收尾同时进行。

## 5. 总体架构

治理后，服务端的关键关系如下：

```text
HTTP Router
  -> Request utilities / typed errors
  -> SessionRuntimeRegistry
       -> SessionManager (persistent metadata)
       -> Editor (runtime state)
            -> PluginModule
            -> Kit transaction coordinator
            -> Menu / Message / Panel / Window / Config / I18n
  -> SSEChannel
       -> BrowserRequestBroker
```

`SessionRuntimeRegistry` 是 Session 持久数据和 Editor 运行时实例之间的唯一协调点。路由不再直接分别修改 `SessionManager` 和 `editorMap`。Editor 对外提供幂等 `dispose()`，内部模块的清理顺序由 Editor 负责。

跨端数据结构由 `@ce/plugin-types` 提供。服务端生成 bootstrap、SSE 和 HTTP 响应，客户端只消费同一份协议类型。

## 6. 插件运行时与 Kit 事务

### 6.1 插件加载上下文

现有插件在模块顶层调用 `editor.plugin.define()`，因此本轮不改变插件入口格式。`PluginModule` 增加进程内共享的异步加载互斥器，将以下步骤放在同一个临界区：

1. 保存原有 `globalThis.editor`。
2. 注入当前插件专属的受限 runtime facade。
3. 动态导入插件入口并收集 definition。
4. 在 `finally` 中恢复或删除全局对象。

互斥器必须在异常时释放，并覆盖所有 `PluginModule` 实例，而不是只保护单个 Editor。插件生命周期 `load` 和 `attach` 在 definition 已经捕获且全局对象已恢复后执行，避免把长时间业务初始化放进全局临界区。

加载并发会被串行化，但插件运行和消息处理不会被串行化。由于模块顶层定义本来就是短操作，这是兼容性和正确性之间可接受的取舍。

### 6.2 插件状态

插件状态变化固定为：

```text
registered -> loading -> running -> unloading -> registered
                   \-> failed -----------/
```

只有 definition 捕获、`lifecycle.load` 和既有插件 attach 全部成功后，插件才进入 `running`。失败清理必须撤销 Panel、Message 和 Menu 所有 owner 资源，并让插件回到可再次加载的状态。

### 6.3 Kit 切换事务

Kit 切换分为准备、替换、提交三个阶段：

1. **准备**：解析并校验 Kit descriptor、布局和全部插件路径，不改变当前 Kit。
2. **替换**：保存旧 Kit 描述和外部插件列表，卸载旧插件，按顺序加载新插件。
3. **提交**：全部插件成功后注册并切换 Kit，创建新的 WindowManager，最后发布布局变化。

任一步骤失败时：

- 清理已经加载的新插件及其 owner 资源。
- 重新加载切换前的插件。
- 保持旧 Kit 和旧 WindowManager 为当前状态。
- 如果恢复旧插件也失败，返回包含原始错误与恢复错误的聚合错误，并将 Editor 标记为不可继续服务；调用方应销毁该 Session，而不是暴露半可用状态。

`activeExternalPlugins` 只在提交或成功恢复后整体替换，不在卸载开始前清空。

## 7. Session 与 Editor 生命周期

### 7.1 SessionRuntimeRegistry

新增注册表封装当前 `editorMap`，职责包括：

- 按 Session ID 创建或返回 Editor。
- 防止同一 Session 的并发重复创建。
- 删除 Session 时先销毁 Editor，再删除持久数据。
- 服务器停止时并行或按受控顺序销毁全部 Editor。
- 保留只读查询能力供现有路由逐步迁移。

创建失败时，注册表不得留下 Map 项或仅创建一半的 Session 运行时。

### 7.2 Editor.dispose()

`dispose()` 必须幂等。第一次调用按以下顺序执行：

1. 阻止新的 Kit 切换和插件加载。
2. 反序卸载外部插件。
3. 反序卸载内置插件。
4. 清空消息处理器、Panel 注册、菜单订阅和 i18n 订阅。
5. 释放窗口状态并清除引用。

清理应尽量继续执行；多个失败通过 `AggregateError` 汇总。注册表无论清理是否完全成功都必须移除不可再使用的 Editor，避免后续请求复用已销毁实例。

### 7.3 HTTP 生命周期

新增 `DELETE /api/session/:id`：

- Session 不存在返回 404。
- 存在时销毁运行时并删除持久数据，成功返回 204。
- 销毁过程中出现错误返回 500，但仍移除不可用运行时；响应记录稳定错误码。

服务器 `stop()` 的顺序为：停止接受新连接、销毁所有 Editor、销毁 BrowserRequestBroker/EventBus、关闭 SSE、关闭数据库，最后等待 HTTP Server 完成关闭。

## 8. 跨端协议

`@ce/plugin-types` 成为以下结构的唯一权威来源：

- bootstrap snapshot；
- Kit、布局、Window 和 Panel instance descriptor；
- Message request、result、broadcast 和 SSE envelope；
- API error body；
- Panel iframe bridge 消息。

领域模块可以保留内部类型，但在 HTTP/SSE 边界必须显式映射到协议类型。客户端和服务端不得复制同名接口。

所有顶层 bootstrap 和 SSE envelope 包含 `protocolVersion`。本轮版本从 `1` 开始。收到不支持的版本时，客户端停止应用该消息并展示可诊断错误，而不是尝试猜测字段含义。

为减少迁移风险，协议集中化分两步完成：先移动纯数据接口并保持字段不变，再删除重复定义和收紧 `unknown`/`any`。运行时对象、函数和服务端专属路径不进入共享协议。

## 9. HTTP 边界与错误模型

### 9.1 请求工具

新增共享 HTTP 工具：

- `readBody(req, { maxBytes })`：默认 JSON 上限 1 MiB，超限立即停止读取并返回 413。
- `readJson<T>(req, validator)`：区分空 Body、非法 JSON 和字段校验失败。
- `sendJson(res, status, value)`：统一 Content-Type 和序列化。

读取器必须处理 `aborted`、`error` 和过早关闭，不允许 Promise 永久挂起。

### 9.2 结构化错误

HTTP 边界使用稳定错误结构：

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session not found",
    "details": null
  }
}
```

错误映射：

- 400：JSON 或字段无效；
- 404：Session、插件、消息或资源不存在；
- 409：Session/Kit 状态冲突；
- 413：请求体过大；
- 500：未预期内部错误。

路由内部异常不再统一伪装成 404。日志保留原始错误和请求上下文，响应只暴露稳定 code 与安全信息。

## 10. Browser request 与 SSE

### 10.1 BrowserRequestBroker

BrowserRequestBroker 管理服务端到浏览器的一次性请求：

1. MessageModule 发现目标 location 为 browser。
2. Broker 生成 request ID，登记 resolve、reject、Session、目标 Panel 和截止时间。
3. 通过 SSE 发送带协议版本的 request envelope。
4. 客户端 bridge 调用 Panel method，并通过 result API 返回成功值或序列化错误。
5. Broker 校验 Session 和 request ID，完成 Promise 并删除 pending 项。

默认超时为 10 秒。超时、Session 删除、SSE 断连和服务器停止都会 reject 并清理 pending request。重复或迟到响应返回 404/409，不得重新完成旧 Promise。

EventBus 可以被重构为 Broker 的内部 pending primitive，但 MessageModule 不直接依赖 HTTP 路由。Server 通过构造参数把 browser dispatcher 注入 Editor，从而保持消息模块可单元测试。

### 10.2 SSE 生命周期

SSEChannel 增加：

- 15 秒心跳注释；
- request/response close、aborted 和写入异常清理；
- 按 Session 跟踪连接；
- `closeSession(sessionId)` 与 `closeAll()`；
- 连接写入失败时通知 Broker，使相关请求尽快失败。
- `write()` 返回 `false` 后等待 `drain`，每个连接最多缓存 64 条业务事件；心跳不进入缓存，队列溢出时关闭连接并通知 Broker。

本轮不提供离线重放。断线期间的广播允许丢失；需要响应的 request 必须明确失败。

## 11. Panel iframe 安全

Panel iframe 增加显式 `sandbox`。本轮允许：

- `allow-scripts`：Panel 必须运行脚本；
- `allow-same-origin`：当前静态资源及 bridge 依赖同源行为。

不允许表单提交、弹窗、顶层导航、下载或 Pointer Lock，除非未来由具体 Panel 能力需求加入。iframe 仍通过受控 bridge 调用宿主功能，不直接获得 Electron preload 或 Node API。

由于 `allow-scripts` 与 `allow-same-origin` 组合不是针对恶意同源内容的完整安全边界，本设计明确只把它视为浏览器能力收敛；真正的不可信 Panel 需要独立 origin，这属于后续零信任插件阶段。

## 12. 迁移基线与工程检查

当前工作区只保留 `kits/default`。因此：

- 删除或改写只验证 `kits/scene-editor` 的测试。
- 将仍应适用于所有 Kit 的断言迁移到 `default` Kit 或使用测试临时夹具。
- 默认配置和脚本不得再引用 `@itharbors/kit-scene-editor`。
- 不恢复已经删除的业务插件或旧目录。

根 `check` 改为有限命令组合：类型检查、客户端测试、服务端测试和插件检查。开发服务器保留在独立 `dev` 命令中，不能作为 CI 检查的最后一步。

清理基线不应通过删除仍有架构价值的测试来获得绿色结果。并发隔离、Kit 回滚、Session 销毁和 browser request 必须拥有新的或迁移后的测试覆盖。

## 13. 测试与验收

实现采用测试先行。最低验收矩阵如下：

| 领域 | 必须证明的行为 |
| --- | --- |
| 插件加载 | 两个 Editor 并发加载不同插件，不会捕获对方 runtime；异常后全局对象恢复 |
| Kit 事务 | 新插件解析、加载或 attach 失败时恢复旧 Kit；恢复失败时 Editor 进入不可用状态 |
| 生命周期 | DELETE Session 释放插件和模块资源并删除 Map/数据库项；重复 dispose 安全 |
| HTTP | 空 Body、非法 JSON、超限 Body、缺字段和内部异常返回正确状态与错误码 |
| 协议 | 客户端和服务端使用共享类型；不支持的 protocolVersion 被明确拒绝 |
| Browser request | 成功响应、Panel 错误、超时、迟到响应和断连都能结束 pending Promise |
| SSE | 心跳存在；连接关闭后无残留；Session 销毁关闭对应连接 |
| iframe | sandbox 权限精确匹配允许列表，未添加高风险能力 |
| 工程检查 | 根 `check` 会自行结束；所有现存测试和类型检查通过；无 scene-editor 残留引用 |

最终验证至少运行：

```bash
npm run check
```

如果根命令拆分执行，还需要分别保留客户端、服务端和插件检查的完整成功输出。不得用只运行受影响测试替代全量验收。

## 14. 实施分解

治理按以下顺序实施，每一阶段完成后运行对应测试：

1. **迁移基线**：移除 scene-editor 残留，修正根 `check`，恢复现有套件绿色。
2. **插件与 Kit**：全局加载互斥、插件失败清理、Kit 事务和回滚。
3. **生命周期与 HTTP**：Editor dispose、SessionRuntimeRegistry、DELETE API、请求工具和错误模型。
4. **共享协议**：集中纯数据类型，加入协议版本并迁移两端使用点。
5. **Browser request 与 SSE**：完成 Broker、客户端响应链路、超时和连接清理。
6. **iframe 安全**：加入最小 sandbox 并补充安全回归测试。
7. **全量验收**：运行根检查并按本设计的验收矩阵逐项审计。

阶段之间存在依赖，不能并行修改共享边界。每一阶段都应保持仓库处于可验证状态，避免把全部风险集中到最后一次集成。

## 15. 后续演进

需要支持不可信第三方插件时，下一阶段可以在当前边界上增加：

- `PluginExecutor` 接口及子进程实现；
- 可序列化的 runtime RPC；
- 插件权限 manifest 和资源配额；
- 独立 Panel origin 与更严格 CSP；
- 插件签名和来源验证。

这些能力必须以真实隔离为目标，不能仅通过隐藏全局变量或 TypeScript 类型声明声称获得安全边界。
