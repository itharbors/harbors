# Scheduler 权限契约实现总结

## 最终结论

Scheduler `0.1.0-preview.2` 已改用 `process-control` 表达 Node.js 子进程执行风险，并移除不准确的 `native-code` 声明。

## 需求完成情况

清单、包版本、锁文件、测试和 README 已同步；Scheduler 仍是跨平台 `any/any` 制品，且不携带 `.node` 原生模块。

## 主要改动

- 将三个版本记录提升到 `0.1.0-preview.2`。
- 权限集合改为 `application-startup`、`filesystem`、`process-control`。
- 更新 manifest 契约测试与风险说明。

## 关键决定

`native-code` 专指需要具体 platform、arch 和 Node ABI 的原生模块载荷；通过 `process.execPath` 启动用户脚本归入 `process-control`。

## 验证结果

- `npm run build --prefix kits/scheduler`：通过。
- `npm run test --prefix kits/scheduler`：9 files、56 tests 通过。
- `npm run kits:boundary -- scheduler`：通过。
- `npm run kit:check -- scheduler --output-directory <temp>`：生成并检查 `kit-scheduler-0.1.0-preview.2-any-any.hkit`。

## 影响与风险

改动只影响 Scheduler 自有发布声明，不改变脚本运行、进程终止或状态持久化行为。

## 偏差与遗留

首次直接运行 Scheduler build 时，共享 `@itharbors/kit-cli` 尚未编译；按仓库 `kit:check` 的工具链前置构建命令补齐后，全部目标门禁通过。无产品行为偏差或已知遗留。

## 后续关注

合并后由现有 Preview 自动发布流程验证 Registry 上的风险投影。

## 相关正式文档

- [Task 需求快照](./task.md)（Task `2026-08-07-permission-risk-contract`）
- [Scheduler README](../../../kits/scheduler/README.md)
