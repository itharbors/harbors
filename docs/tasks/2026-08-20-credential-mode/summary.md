# 2026-08-20-credential-mode 实现总结

## 最终结论

已将凭据模式从 `off | local | multi-user` 收敛为 `off | on`，并把默认值改为 `on`，同步 Gateway、Server、Plugin、Vault 和 Keyring。Gateway 与 Server 相关测试大部分通过，但 host-security 因包内缺少 node_modules 无法执行；此外默认开启和取消 loopback 限制扩大了凭据能力的部署风险，需要后续单独完成安全策略评审。

## 需求完成情况

- CredentialMode 类型和解析器已改为 `off`/`on`，未指定时默认 `on`。
- Gateway 不再根据 host mode 或 bind host 限制模式，非法模式仍报错。
- Server 在 `on` 模式创建并恢复 Credential Vault，`off` 模式保持禁用。
- Vault、Native Keyring 和 Plugin capability 已同步使用 `on` 语义。
- `createLocalCredentialVault` 已更名为 `createEnabledCredentialVault`。
- `multi-user` 未实现，未作为有效模式保留。

## 主要改动

- 更新 `packages/host-security` 的类型、默认策略和非法值校验。
- 更新 Gateway 环境解析、Server 启动装配、Credential Vault/Keyring 工厂和 Plugin credential facade。
- 同步 Gateway、Vault、Keyring、Server 生命周期和 capability 测试的模式断言。

## 关键决定

- “on”只表达凭据能力启用，不代表 HTTP 身份认证或多用户授权已经完成。
- 监听地址不再参与模式解析；网络隔离、认证和部署边界因此必须由其他安全层承担。
- 不把 `multi-user` 静默映射为 `on`，避免调用方误以为获得了尚未实现的租户隔离能力。

## 验证结果

- Gateway 全量测试 18/18 通过，security 测试 10/10 通过。
- Server 聚焦测试 118/119；唯一失败为本次未修改断言 `broadcasts enriched config change payloads...`。
- Server 全量测试 737/741；另外三个 integration session/kit 失败，均不在本次 diff。
- Client 聚焦测试 75/76、全量 285/286；唯一失败为本次未修改的 legacy Electron bridge bootstrap 测试。
- host-security 未能执行：包内 node_modules 缺失，vitest command not found。
- 未将上述失败和未执行项目写作通过；也未完成额外安全渗透或远程暴露验证。

## 影响与风险

- 默认 `on` 会使 Web 服务在未显式配置时尝试启用凭据能力，部署行为和数据保护面发生变化。
- 取消 loopback 限制后，绑定非 loopback 地址的服务也可能暴露凭据接口；若认证、反向代理或网络隔离不足，风险显著增加。
- 旧环境变量、类型引用或仓库外调用方若仍传入 `local`/`multi-user`，会收到错误而不是兼容降级。

## 偏差与遗留

- host-security 测试因依赖缺失未运行。
- Server/Client 的既有失败尚未修复，Kit test 因隔离环境缺少 `yazl` 未完成。
- 默认开启和取消 loopback 限制尚未经过独立安全评审；这不是本次验证通过的结论。

## 后续关注

- 明确 Web 远程部署时凭据接口的认证、授权、代理和网络隔离边界，并补充安全回归测试。
- 在完整依赖环境运行 host-security 测试和全量门禁，检查旧调用方迁移情况。
- 评估是否需要保留显式部署开关或改回更保守的 Web 默认策略。

## 相关正式文档

- [Task 需求快照](./task.md)
