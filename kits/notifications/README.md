# Notifications Kit

提供通知后台与通知中心能力。

## Local lifecycle

```bash
npm ci --prefix kits/notifications
npm run build --prefix kits/notifications
npm run test --prefix kits/notifications
```

本 Kit 未声明独立 smoke 脚本，以仓库目标 Kit 的完整检查验收。

## Permissions

`network`、`filesystem`、`application-startup`、`notifications`。

## Platform

支持任意平台与架构。

## Ownership boundary

通知功能、资源、依赖与测试均由本目录拥有。
