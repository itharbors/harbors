# Agent Guard 版本测试断言修复总结

## 最终结论

Agent Guard 的仓库测试断言已从过期的 `0.1.0-preview.6` 同步到当前权威版本 `0.1.0-preview.7`，相关 Kit 检查恢复通过。

## 需求完成情况

- 已核对 `kit.json`、`package.json` 和 lockfile 均为 `0.1.0-preview.7`。
- 已更新 artifact 文件名断言。
- 已更新 monorepo descriptor 版本断言。

## 主要改动

- `scripts/lib/kit-check.test.mjs` 期望 `kit-agent-guard-0.1.0-preview.7-darwin-arm64.hkit`。
- `scripts/lib/kit-monorepo.test.mjs` 期望 Agent Guard `0.1.0-preview.7`。

## 关键决定

只同步测试事实，不修改产品版本或发布逻辑。

## 验证结果

- `npm run build -w @itharbors/kit-core -w @itharbors/kit-cli` 通过。
- `npm run test:kit-check`：28 项通过。
- `npm run test:kit-monorepo`：17 项通过。
- `npm ci` 完成，审计报告 0 vulnerabilities。

## 影响与风险

仅修改测试断言，无运行时影响。

## 偏差与遗留

无。

## 后续关注

Agent Guard 后续升版时应在同一 Kit 变更中同步 descriptor-derived 测试断言。

## 相关正式文档

- `docs/tasks/2026-08-07-agent-guard-version-expectations/task.md`
- `kits/agent-guard/kit.json`
