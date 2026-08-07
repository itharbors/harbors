# Kit boundary 模板文件复制误判修复总结

## 最终结论

Kit boundary 的 Git copy detection 已改为只识别 100% 相同的复制。独立生成但结构相似的 Task 状态文件不再触发跨边界误报，真实完整复制仍按原规则拒绝。

## 需求完成情况

- 已复现模板化 `status.json` 被低分 copy 误判的问题。
- 已将 copy similarity 阈值显式设为 100%。
- 已增加真实 Git 仓库回归测试。
- 已验证完整 Kit workflow finish/release 安全矩阵。

## 主要改动

- `readChangedPathRecords` 使用 `--find-copies=100%` 与 `--find-copies-harder`。
- 新增低相似度 Task status 应作为 `A` 的真实仓库测试。
- 保留 Kit 到 Task、Task 到 Kit 的完全复制拒绝测试。

## 关键决定

Copy detection 只把完全复制作为安全信号，不再把 Git 的启发式低相似度配对当作跨边界事实。Rename detection、路径白名单、文件模式和 HEAD/index 一致性不变。

## 验证结果

- `npm run test:kit-boundary`：27 项通过。
- `npm run test:kit-workflow`：31 项通过。
- `npm ci` 完成，审计报告 0 vulnerabilities。

## 影响与风险

内容被修改的文件不会再由 copy heuristic 标记，但仍必须落在严格的 Kit 或当前 Task 路径白名单内，并接受 Task schema、文件模式和 finish gates。完全相同复制继续被拦截。

## 偏差与遗留

无。

## 后续关注

本变更进入 main 后，从新 main 重建 Scheduler 权限契约 Task。

## 相关正式文档

- `docs/tasks/2026-08-07-kit-boundary-exact-copy-detection/task.md`
- `scripts/lib/kit-boundary.mjs`
- `scripts/lib/kit-boundary.test.mjs`
