# 布局宽度漂移修复总结

## 最终结论

修复了窄屏下无位移的分隔条手势误保存临时尺寸的路径。Chromium 的横竖屏往返及刷新验收均保留用户设置的宽度。

## 需求完成情况

分隔条轻触或沿分隔线移动不再重算布局比例。鼠标及触屏的有效拖动仍会保存，结束通知与遮罩清理正常。

## 主要改动

分隔条忽略调整轴上的零位移，在既有结束事件中标记是否移动。生产编辑器和 Layout Kit 示例只在发生轴向位移时归一化，编辑器仅在此时保存尺寸。

## 关键决定

沿用当前 `main`，作为第一项独立提交。修复限已复现的尺寸回写路径。计划及实现通过独立评审。

## 验证结果

- `pnpm --filter @itharbors/client test` 退出 0，类型检查和 311 项测试通过。
- `node docs/tasks/2026-11-06-viewport-layout-width-drift/.work/browser-verification.mjs` 退出 0。隔离 Harness Web 宿主，Chrome 157.0.8103.38，844 × 390 与 390 × 844 往返五轮。触屏轻触及垂直于调整轴移动 30 px 后，返回横屏并刷新仍恢复原宽度 310、222、300 px。实际触屏与鼠标拖动可以保存。面板 iframe 收到开始、结束通知，遮罩均解除。
- `git diff --check` 通过。

## 影响与风险

改动作用于 Framework Client 分隔条及布局保存。轴向移动达到最小尺寸限制时仍走现有有效拖拽路径。

## 偏差与遗留

纯旋转在现有 Chromium 模拟中本来就未写入缓存。已修复并验证的是窄屏无位移误回写。移动真机和 Safari 未覆盖。初始窄屏可能因默认侧栏宽度使中间面板宽度变为零，此项由后续收起侧栏的工作改善。验收另记录一条 favicon 404。

## 后续关注

结合真机和实际操作序列确认纯旋转是否还存在独立触发路径。

## 相关正式文档

- [布局与窗口模型](../../architecture/layout-model.md#resize)
- [测试指南](../../guides/testing.md)

## Decision Delta 与 Findings

- `blocking` 无。
- `non_blocking` 纯旋转未独立复现，真机和 Safari 未覆盖，初始窄屏空间限制见上节。验收另有 favicon 404。
- `decision_candidates` 无。
- `follow_up` 独立处理侧栏收起，后续按需补真机验收。

归类为 Task-only，可用 `viewport-layout-width-drift` 或 `ce-divider-drag-end` 检索。
