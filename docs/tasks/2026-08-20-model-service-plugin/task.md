# 2026-08-20-model-service-plugin

Task ID: `2026-08-20-model-service-plugin`
Type: `feature`

## 背景与问题

Agent Chat Kit 当前由 `agent` Plugin 直接读取环境变量和 DSH 配置、解析模型目录、持有
模型服务凭据并向 OpenAI/Anthropic 兼容接口发起 HTTP 请求。这些职责属于通用模型访问
能力，不应与对话、上下文、工具循环和权限编排耦合。

需要在 Agent Chat Kit 内新增独立的 `model-service` Plugin，先迁移现有模型连接和请求
能力，保持当前行为可用，为后续基于 `ctx.config`/`ctx.credentials` 的通用模型服务配置
奠定边界。

## 目标

- 新增 `kits/agent-chat/plugins/model-service` Plugin 并装配到 Agent Chat Kit。
- `model-service` 负责现有模型配置解析、模型目录、协议选择、凭据使用、HTTP 请求与重试。
- `agent` 通过定向 request 消息消费 `model-service`，不再直接持有主模型请求凭据。
- `agent` 继续负责会话、上下文、工具执行、工具循环、trace 与权限。
- 保持现有 OpenAI Chat Completions 与 Anthropic Messages 行为及错误语义。

## 范围

- `kits/agent-chat/plugins/model-service/**`：新 Plugin、消息契约、实现和聚焦测试。
- `kits/agent-chat/plugins/agent/**`：改为通过消息调用 `model-service`，删除已迁移的主模型请求职责。
- `kits/agent-chat/package.json`、`kits/agent-chat/pnpm-lock.yaml`：Kit 装配和依赖闭环。
- 当前 Task 文档与必要的长期架构说明。

## 非目标

- 不实现模型服务 Profile 配置界面。
- 不把模型服务数据迁移到 `ctx.config`，不把真实 Token 迁移到 `ctx.credentials`。
- 不删除环境变量或 DSH 兼容入口；本阶段只把主模型访问的兼容读取迁到正确 Plugin。
- 不改变 Agent 的工具定义、工具执行和会话存储模型。
- 不修改 Framework、Kit Core 或 Server。
- 不改动当前工作区已有的 Preview Plugin 修改。

## 消息边界

- `agent -> model-service` 使用定向 request 获取模型目录和发起单次模型请求。
- `model-service` 不执行本地工具；模型返回 tool calls 后仍由 `agent` 执行并决定下一轮请求。
- `model-service` 不向 `agent` 返回真实 Token、凭据文件路径或环境变量名称。
- 本阶段没有配置写入，因此不新增配置变化广播；后续 Profile 管理阶段再设计
  `model-service.catalog.changed` 等广播。

## 验收标准

- Agent Chat Kit 能发现并加载名为 `model-service` 的 Plugin。
- Agent 获取模型列表和主模型推理时通过 `model-service` 的定向消息完成。
- OpenAI/Anthropic 请求的 URL、认证 Header、payload、重试和错误处理保持兼容。
- Agent 主模型调用路径不再直接解析对应 DSH/Relay 凭据，也不直接发起模型 HTTP 请求。
- 聚焦 Plugin 测试、Agent 测试、Kit build/validate 通过，并完成必要的 Web 浏览器验收。

## 约束

- 用户明确要求直接在当前 `main` 修改，不创建分支或 worktree。
- 当前工作区已有 Preview Plugin 修改属于用户改动，必须原样保留且不纳入本 Task。
- Plugin 之间只通过 request/broadcast 消息交互。
- 只支持 Web 宿主，不增加 Electron 或桌面宿主假设。

## 需求变更

- 用户先确认 Plugin 名称从 `agent-service` 调整为 `model-service`。
- 用户随后明确要求直接在当前 `main` 修改，不创建分支或 worktree。
- 本阶段先创建 `model-service` Plugin，并迁移现有主模型访问功能；Profile 配置与后续配置迁移另行设计。
