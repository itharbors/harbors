# 修正 Scheduler 发布风险契约

Task ID: `2026-08-07-permission-risk-contract`
Type: `refactor`

## 背景与问题

Scheduler 通过 `process.execPath` 启动用户选择的 Node.js 脚本，却把这类行为声明成 `native-code`，同时制品 target 是 `any/any`。该声明混淆了子进程控制与原生 ABI 载荷，也与 Framework 强化后的原生 target 契约冲突。

## 目标

用准确的 `process-control` 风险声明描述 Scheduler 行为，移除并不存在的原生模块声明，并形成一个可独立发布的新版 Preview。

## 范围

- 更新 Scheduler 的 `kit.json`、包版本、锁文件和权限契约测试。
- 更新 Scheduler 自有 README 中的风险说明。
- 维护本 Task 的三份正式档案。

## 非目标

不改变调度、脚本执行、进程终止和持久化行为；不修改 Framework 共享代码或其他 Kit。

## 验收标准

- `kit.json`、`package.json` 与 `package-lock.json` 使用 `0.1.0-preview.2`。
- 权限精确为 `application-startup`、`filesystem`、`process-control`。
- Scheduler build、test、boundary 与 `kit:check` 全部通过。

## 约束

改动必须限制在 `kits/scheduler` 和本 Task 三份正式档案内，并遵守市场 Kit 独立版本与发布边界。

## 需求变更

本 Task 未发生需求变更。
