# 分隔条触屏拖拽修复总结

## 最终结论

Harbors 分隔条在 Chromium 触屏模拟中可以连续拖动到手指抬起。Harbors Harness Web 页面上的两轴拖拽、比例恢复和面板滚动均通过验收。

## 需求完成情况

- 横向和纵向拖拽均随输入完整移动 72 px，触屏模拟和鼠标结果一致。
- 指针移入相邻面板区域后继续跟随。松开后遮罩移除，比例写入本地缓存，同一标签页刷新后恢复。
- 从 Plugin 列表内容区起手仍可原生滚动。

## 主要改动

在分隔条 `.bar` 的 CSS 中声明 `touch-action: none`，并在现有样式测试中检查声明位于实际命中区的规则内。触屏拖拽沿用现有尺寸计算、遮罩、取消清理及布局保存。

## 关键决定

- 用户选择在当前 `main` 分支修复并提交一个本地 commit。
- 浏览器在拖拽起点读取触摸策略，因此将样式限定在分隔条命中区并提前声明。计划和实现均通过独立评审。

## 验证结果

- `pnpm --filter @itharbors/client test` 退出 0，类型检查通过，34 个测试文件共 310 项通过。
- `node docs/tasks/2026-11-06-touch-divider-resize/.work/browser-verification.mjs` 退出 0。使用仓库的 `startWebHost` 启动隔离 Harbors Harness，访问 `/?kit=harness` 的临时会话，Vite 加载修改后的 Client 源码。Chrome 157.0.8103.38 在 1280 × 1400 视口分别输入鼠标和触屏事件，两轴均跟随 18、36、54、72 px，抬起前持续保持遮罩，`pointerup` 后清理并保存。面板 iframe 先后收到 `layout-resize-start` 和 `layout-resize-end`。同一标签页重载后位置保持，纵向取整差异小于 0.02 px。Plugin 列表的触屏滚动距离为 85 px。浏览器另有一条 `/favicon.ico` 404，交互断言均通过。
- Chromium 隔离组件测试中，主动取消触屏手势后遮罩和拖拽态均清除。随后从面板内起手可滚动 145 px。
- `git diff --check` 通过。

## 影响与风险

触摸策略只作用于共享分隔条的命中区。面板内容从自己的区域起手，继续由浏览器处理原生滚动。

## 偏差与遗留

覆盖 Client 和 Harness 的定向验证。触屏输入来自 Chromium 模拟，移动设备真机和 Safari 未实测。

## 后续关注

真机验收缺口见上节。

## 相关正式文档

- [布局与窗口模型](../../architecture/layout-model.md#resize)
- [测试指南](../../guides/testing.md)

## Decision Delta 与 Findings

- `blocking` 无。
- `non_blocking` 真机和 Safari 未实测。浏览器验收记录另有一条 favicon 404。
- `decision_candidates` 无。
- `follow_up` 无单独任务。

本次取舍归类为 Task-only。通过 `touch-divider-resize` 或 `touch-action` 可反查本任务、修复位置与对应断言。
