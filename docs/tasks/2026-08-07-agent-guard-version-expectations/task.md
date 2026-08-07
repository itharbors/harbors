# 同步 Agent Guard 版本测试断言

Task ID: `2026-08-07-agent-guard-version-expectations`

Type: `bug`

## 背景与问题

Agent Guard 已升级到 `0.1.0-preview.7`，但两个仓库工作流测试仍断言 `0.1.0-preview.6`，导致任何无关变更的完整 `npm run check` 在 Kit workflow 阶段失败。

## 目标

让测试断言与 Agent Guard 的三个权威版本文件保持一致，恢复主线完整检查。

## 范围

- 更新 `kit-check` 的 artifact 名称断言。
- 更新 `kit-monorepo` 的 descriptor 版本断言。
- 运行相关 Kit 工作流测试与完整检查。

## 非目标

- 不修改 Agent Guard 产品代码或版本。
- 不改变 Kit 发布、版本选择或 artifact 命名逻辑。

## 验收标准

- 两处断言均为 `0.1.0-preview.7`。
- `npm run test:kit-check` 与 `npm run test:kit-monorepo` 通过。
- 完整 `npm run check` 不再因该版本漂移失败。

## 约束

- 版本必须从当前 `kit.json`、`package.json` 和 lockfile 的一致事实验证。
- 只修改陈旧测试与本 Task 文档。

## 需求变更

- 本问题在收口 Kit boundary 修复时由完整 repository gate 暴露。
