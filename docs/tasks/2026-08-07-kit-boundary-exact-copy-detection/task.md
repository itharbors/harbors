# 修复 Kit boundary 的模板文件复制误判

Task ID: `2026-08-07-kit-boundary-exact-copy-detection`

Type: `bug`

## 背景与问题

Kit boundary 使用 Git copy detection 检查跨 Kit/Task 的复制。新 Task 的 `status.json` 由统一模板生成，与历史 Task 状态文件结构相似；Git 默认 50% 阈值会将独立生成且内容不同的文件报告为低分 copy，导致合法 Kit Task 无法通过 finish gate。

## 目标

保留跨边界真实复制检测，同时不再把仅结构相似的新治理文件误判为复制。

## 范围

- 调整 `readChangedPathRecords` 的 Git copy detection 阈值。
- 增加真实 Git 仓库回归测试，覆盖低相似度模板文件与完全复制文件。
- 验证原有 Kit boundary 和 Kit workflow 测试。

## 非目标

- 不放宽 Kit、Task 路径边界。
- 不改变 rename 检测、文件模式检查或 Task ready gate。
- 不修改任何 Kit 产品代码。

## 验收标准

- 独立生成但结构相似的当前 Task `status.json` 以新增文件处理并通过 boundary。
- 字节级完全复制仍被识别为 copy，并在跨边界时拒绝。
- 原有 boundary 安全测试全部通过。
- Scheduler 权限契约补丁可通过此前失败的 boundary gate。

## 约束

- 修复必须 fail closed，不能忽略真实的完全复制。
- 测试必须调用真实 Git，而不只模拟 name-status 记录。
- 变更使用独立 Framework bug Task，不混入 Scheduler Kit Task。

## 需求变更

- 本 Task 来源于插件制品架构收敛验证：新原生 target 契约暴露 Scheduler 权限错误，Scheduler 独立修复又被 boundary 的 copy heuristic 误判阻塞。
