# 2026-08-20-agent-chat-settings

Task ID: `2026-08-20-agent-chat-settings`
Type: `feature`

## 背景与问题

Agent Chat Kit 原有 Settings 插件直接维护通用配置字段和默认值，并把不同插件的配置混在同一套表单模型中。这样设置页面、配置持久化和业务插件的配置规则耦合在一起；新增 Agent 或模型服务配置时，也无法由配置所属 Plugin 自己定义校验和保存边界。

## 目标

- 将 Settings Plugin 定位为设置页面注册、排序、展示和受控转发的容器，不由它保存 Agent 或模型服务配置。
- 支持 Agent Plugin 注册独立设置页，读取、保存和重置 sandbox mode 与 approval policy。
- 支持 model-service Plugin 注册独立设置页，管理 Provider、模型目录、默认模型和凭据引用。
- 配置页面只能调用所属 Plugin 声明的请求；配置所属 Plugin 负责校验和持久化，敏感凭据不返回给页面。
- Provider 配置变化后，Chat 能收到模型目录变化通知并更新可选模型。

## 范围

- `kits/agent-chat/plugins/settings/**`：Settings 页面贡献协议、注册表、请求白名单、页面容器和设置页面 UI。
- `kits/agent-chat/plugins/agent/**`：Agent 设置页面及 Agent 设置读写/重置消息接口。
- `kits/agent-chat/plugins/model-service/**`：Provider 设置页面、配置读写、凭据 Vault 交互和目录变化广播。
- `kits/agent-chat/plugins/chat/**`：消费模型目录变化广播并更新模型选择状态。
- `kits/agent-chat/kit.json`、`kits/agent-chat/package.json`、`kits/agent-chat/pnpm-lock.yaml`：页面装配和依赖闭环。

## 非目标

- Settings Plugin 不接管其他 Plugin 的配置存储，也不定义 Agent 或 model-service 的业务配置字段。
- 不在本 Task 中重新设计 Framework 配置层、凭据加密存储或通用设置表单以外的业务页面。
- 不把真实 Token、credentialId 或其他凭据材料返回到 Web 设置页面。
- 不改变 Agent 的会话、工具循环、权限请求和模型调用职责。
- 不加入 Electron 或桌面宿主假设。

## 消息边界

- Agent/model-service 通过 `contribute.settings` 声明页面、所属 panel、排序和允许的请求。
- Settings Plugin 在页面 iframe 与所属 Plugin 之间转发 `requestPage` 定向请求，并校验 owner 与请求名是否已注册。
- Agent 页面通过 Settings 调用 `getSettings`、`saveSettings`、`resetSettings`；Agent 自己读写全局配置并返回安全设置快照。
- model-service 页面通过 Settings 调用 Provider 读写接口；保存/删除/重置凭据后由 model-service 广播 `model-service.catalog.changed`，Chat 订阅该广播。
- Settings 注册表变化使用 `settings.registry.changed` 广播，页面变化不通过共享配置副作用表达。

## 验收标准

- Settings 能校验 schema version、页面 panel 归属、请求列表和重复页面，并按 order/title/owner 稳定排序。
- Plugin attach/detach/replace 后，Settings 页面列表和对应 UI 能正确更新。
- 未注册页面、未声明请求和非法贡献会被拒绝或忽略，不会调用任意目标 Plugin 方法。
- Agent 设置页面能够读取当前值、保存合法的 sandbox mode/approval policy，并在重置后回到默认值；非法输入不会写入配置。
- model-service 设置页面能够安全展示 Provider 配置、保存/删除 Provider 和重置凭据；返回模型不包含真实 Token 或凭据内部标识。
- Provider 目录变化广播带有可用于丢弃过期更新的 revision，Chat 收到后更新模型列表和配置错误状态。
- 目标 Plugin 测试、Kit 构建/校验和必要的 Web 浏览器验收按仓库测试指南执行。

## 约束

- 用户要求直接在当前 `main` 整理现有工作区改动，不创建分支或 worktree，不 push。
- Kit 是装配包；本 Task 的实现应闭环在 `kits/agent-chat/**` 内，不修改 Framework 或其他 Kit。
- Plugin 之间只通过 request/broadcast 消息交互；Settings 代理请求必须遵守页面声明的最小权限。
- 只支持 Web 宿主，不加入 Electron、原生窗口生命周期、托盘、更新器或桌面 IPC。
- 设置 UI 不得依赖跨页面共享的秘密数据；凭据能力由 model-service Plugin 的 capability 和 Vault 负责。

## 需求变更

- 用户明确 Settings Plugin 的职责是接收其他 Plugin 注册的页面并作为容器，不负责保存其他 Plugin 配置；读写接口保留在配置所属 Plugin，由 Settings 仅做受控转发。
