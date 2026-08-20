# 2026-08-20-message-route-descriptor

Task ID: `2026-08-20-message-route-descriptor`
Type: `feature`

## 背景与问题

Message Plugin 过去只接受 request/broadcast 路由到方法数组或字符串的简化写法。随着设置页面等受控调用场景需要携带调用方声明，manifest 中出现了包含 `methods` 和 `callers` 的对象描述符；如果仍按数组解析，会跳过合法路由或无法保持旧 Plugin 兼容。

## 目标

- 让 Message Plugin 能从 request 和 broadcast 路由描述符中提取并注册 `methods`。
- 保留旧的字符串/字符串数组写法，避免现有 Plugin manifest 需要一次性迁移。
- 对空数组、缺少 methods、非字符串方法名和其他非法描述符安全跳过，不注册不可调用路由。
- 保留 `callers` 等描述符元数据供消息注册/分发层的访问控制使用，不把它误当成方法名。

## 范围

- `plugins/message/main/src/index.ts`：request/broadcast 路由描述符兼容解析和注册。
- `plugins/message/main/src/index.test.ts`：对象描述符、旧写法、非法输入和 request/broadcast dispatch 测试。
- 与该解析契约直接相关的消息类型或 manifest 说明（如确有需要）。

## 非目标

- 不改变 request/broadcast 的业务语义、生命周期 attach/detach 或 Plugin 间消息 API。
- 不在 Message Plugin 内复制 Framework 的权限策略或自行推断调用方身份。
- 不移除旧 manifest 写法，也不要求一次性改造所有现有 Plugin。
- 不把 `callers` 暴露为业务参数或绕过已有消息访问控制。

## 消息边界

- Plugin attach 时分别读取 `message.request` 与 `message.broadcast` 的每个路由。
- 字符串/数组直接作为方法列表；对象描述符只使用非空且全为字符串的 `methods` 进行注册，`callers` 作为描述元数据留给消息层。
- 注册成功后 request 通过 `runtime.message.registerRequest` 定向调用目标 Plugin 方法，broadcast 通过 `runtime.message.registerBroadcast` 分发到目标方法；detach 撤销对应注册。

## 验收标准

- request 和 broadcast 均支持 `{ methods: [...] , callers: [...] }` 对象描述符，并按 methods 完成注册和调用。
- 旧的字符串及字符串数组路由继续完成注册和分发。
- 缺失/空 methods、空方法名、非字符串方法名等非法对象路由不会注册；同一贡献中的合法旧路由不受影响。
- 路由 detach 后不再调用已卸载 Plugin；测试覆盖对象、兼容和非法输入场景。
- Message Plugin 的聚焦测试通过，并完成与相关消息协议的针对性验证。

## 约束

- 插件交互统一使用 request/broadcast 消息，不引入跨 Plugin 直接 import 或宿主特有 API。
- `callers` 的真正授权边界必须由消息注册/分发层既有机制决定；本 Task 只负责描述符兼容解析，不能以解析成功替代权限校验。
- 用户要求直接在当前 `main` 整理现有工作区改动，不创建分支或 worktree，不 push。

## 需求变更

- 用户在讨论 Settings 页面请求边界时确认，`callers` 是调用方白名单元数据；本 Task 保留该字段的描述能力，但不把 Message Plugin 的方法提取逻辑扩展成独立授权系统。
