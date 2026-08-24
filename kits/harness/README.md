# Harbors Harness Kit

内置的 Harbors Harness AI Agent 工作台 Kit，装配 Conversation、Chat、Agent、Model Service、Preview、Settings、Debug 和 Mermaid 等插件。

## Local lifecycle

先由 Harbors runner 准备当前版本的公开 Framework testing/Web Host toolchain 与 Client 构建产物，再从仓库根目录执行：

```bash
pnpm --dir kits/harness install --frozen-lockfile
pnpm --dir kits/harness run build
pnpm --dir kits/harness run test:kit
pnpm --dir kits/harness run smoke
```

`test:kit` 依次执行 descriptor 校验、Conversation Plugin runtime smoke 和真实 Kit assembly 测试；`smoke`
启动真实 Gateway、Server 与 Client，并通过公开 HTTP 验证 Gateway health、Kit Catalog 和
`/kits/harness` 页面。可见交互仍由 Web 浏览器验收。

## Permissions

申请 `credentials` 权限，并只授予 `model-service` 插件保存和读取模型 Provider 凭据。测试与 smoke
不连接真实模型服务，也不读取用户凭据。

## Platform

`kit.json` 的 target 为 `platform=any`、`arch=any`。Harbors 仅支持 Web 宿主，本 Kit 不包含桌面宿主假设。

## Ownership boundary

Plugin 单元测试和 runtime smoke 归各自 Plugin 目录；跨 Plugin 装配与完整 Web Host smoke 归本 Kit。
Framework 只提供公开测试 harness 与通用 Web Host 启停工具。本目录不导入 Framework 私有源码，Kit
之外的 Provider、凭据和不稳定网络能力才允许使用确定性的测试 double。
