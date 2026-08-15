# Default Kit

内置的通用默认 Kit。其 descriptor 通过 `harbors.distribution=builtin` 与 `harbors.default=true` 声明角色。

## Local lifecycle

```bash
pnpm --dir kits/default install --frozen-lockfile
pnpm --dir kits/default run build
pnpm --dir kits/default run test:kit
```

本 Kit 未声明独立 smoke 脚本，以仓库目标 Kit 的完整检查验收。

## Permissions

不申请权限。

## Platform

支持任意平台与架构。

## Ownership boundary

默认布局、窗口、插件、依赖与测试均由本目录拥有。
