# 2026-08-20-credential-mode

Task ID: `2026-08-20-credential-mode`
Type: `feature`

## 背景与问题

凭据能力当前以 `off | local | multi-user` 表达，并把 host 类型和监听地址带入模式解析。`multi-user` 尚未实现，`local` 也使 Web 默认关闭并要求 loopback 绑定，导致服务启动策略、Plugin capability 和 Vault 工厂 API 彼此携带已废弃的模式语义。

## 目标

- 将凭据模式收敛为 `off | on`，其中未显式指定时默认 `on`。
- 让 Gateway、Server、Plugin capability、Credential Vault 和 Native Keyring 使用一致的模式名称和状态。
- 删除凭据模式对 host 类型和监听地址的推断/loopback 限制；未知模式仍必须显式报错。
- 将本地 Vault 工厂改名为表达启用状态的 `createEnabledCredentialVault`，保持启用 Vault 的创建行为一致。

## 范围

- `packages/host-security/**`：CredentialMode 类型和默认/非法值解析。
- `packages/gateway/**`：Gateway 环境输入和模式解析。
- `packages/plugin/**`：Plugin credential capability 类型及不可用 fallback。
- `packages/server/src/credentials/**`、`packages/server/src/server.ts`：Vault、Keyring 工厂和服务启动装配。
- 对应 package 测试及调用方 API 名称迁移。

## 非目标

- 不实现 `multi-user` 或共享凭据租户隔离。
- 不重新设计 HTTP 身份认证、授权、会话安全或反向代理信任边界。
- 不将凭据秘密暴露给 Web 客户端，不改变 Vault 的加密、恢复、锁定和 profile 数据模型。
- 不加入 Electron 或桌面宿主特有的安全假设。

## 验收标准

- 所有公开 CredentialMode 类型、解析器、Gateway、Server、Vault、Keyring 和 Plugin capability 只接受 `off`/`on`。
- 未提供模式时解析为 `on`；显式 `off` 禁用 Vault；显式 `on` 尝试创建并恢复 Vault。
- 旧的 hostMode、bindHost、`local` 和 `multi-user` 输入不会被静默转换为新的有效模式；未知值会抛出明确错误。
- Vault 和 Plugin capability 在可用、不可用、锁定和禁用状态下返回与 `on`/`off` 一致的模式值和原因。
- `createEnabledCredentialVault` 能替代旧本地工厂完成启用 Vault 创建，调用方和针对性测试完成迁移。
- Gateway/host-security/server credentials 的聚焦测试通过，并按测试指南完成必要的服务端验证。

## 约束

- 这是 Framework/Server 边界变更，必须同步检查所有内部调用方和测试，不能遗留旧模式字符串或旧工厂导入。
- 用户要求直接在当前 `main` 整理现有工作区改动，不创建分支或 worktree，不 push。
- 默认开启凭据不等于放宽 HTTP 身份认证；监听地址不再作为模式判定条件后，部署侧必须继续由认证和网络隔离承担访问控制。
- 只支持 Web 宿主，不添加桌面打包、原生窗口生命周期或桌面 IPC 假设。

## 需求变更

- 用户确认先按当前未提交实现建档并提交，默认开启与取消 loopback 限制的安全影响留到后续优化讨论；本 Task 当前只记录该模式契约变化，不扩展认证设计。
