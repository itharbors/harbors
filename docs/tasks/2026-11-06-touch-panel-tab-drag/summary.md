# Panel Tab 触屏拖拽修复总结

## 最终结论

Harbors Harness 的 Panel Tab 在 Chromium 触屏模拟中可以横向拖过阈值并持续到抬手，支持跨组移动和组内重排。

## 需求完成情况

- 从 Tab 按钮起手的横滑优先用于拖拽。抬手后布局顺序保存，同一标签页刷新后恢复。
- 轻点仍可切换 Tab。取消拖拽会清理遮罩与预览。桌面鼠标拖拽结果与触屏一致。

## 主要改动

给 `ce-panel-group` 的 `.tab-item` 声明 `touch-action: none`，并在现有样式测试中检查该声明的作用域。标签栏容器保留 `touch-action: pan-x` 和横向溢出设置。

## 关键决定

用户选择在当前 `main` 分支单独提交。Tab 按钮起手的横滑由拖拽接管，标签溢出时也适用。计划和实现均通过独立评审。

## 验证结果

- `pnpm --filter @itharbors/client test` 退出 0，类型检查通过，34 个测试文件共 310 项通过。
- `node docs/tasks/2026-11-06-touch-panel-tab-drag/.work/browser-verification.mjs` 退出 0。通过 `startWebHost` 启动隔离 Harbors Harness，打开 `/?kit=harness` 的临时会话，由 Vite 加载修改后的 Client 源码。Chrome 157.0.8103.38 在 1280 × 1400 视口使用真实浏览器输入，触屏和鼠标均通过横移 286 px 跨组插入，再反向横移 70 px 组内重排。遮罩从 12 px 阈值持续到抬手。主动取消时清理遮罩和预览，保留布局和本地缓存。轻点切换一次，刷新恢复顺序和选中项。交互验收记录另有一条 favicon 404。
- 在 390 × 844 视口使用仓库 Layout Kit demo，从修复后的源码加载样式，Chromium 触屏输入横移 310 px 后完成跨组移动，抬起前未收到 `pointercancel`。
- 同一 Harness 脚本带 `--overflow` 退出 0。测试页只临时缩窄标签栏，使 116 px 的标签内容溢出 106 px 的容器。从可见 Tab 起手横移 69 px 后完成组内重排，拖动时标签栏滚动位置保持为 0。
- `git diff --check` 通过。

## 影响与风险

标签过多时，从 Tab 按钮起手的横滑会用于拖拽。标签栏容器、面板内容区及拖拽控制器沿用原逻辑。

## 偏差与遗留

Harness 验收覆盖 Chromium 模拟触屏和鼠标。溢出场景通过测试页缩窄标签栏复验，移动真机和 Safari 未实测。

## 后续关注

按需补齐移动真机验收。

## 相关正式文档

- [布局与窗口模型](../../architecture/layout-model.md#tab-拖放)
- [测试指南](../../guides/testing.md)

## Decision Delta 与 Findings

- `blocking` 无。
- `non_blocking` 真机和 Safari 未实测。浏览器另有一条 favicon 404。
- `decision_candidates` 无。
- `follow_up` 移动真机纳入后续验收覆盖。

手势优先级取舍归类为 Task-only。可用 `touch-panel-tab-drag` 或 `.tab-item` 与 `touch-action` 反查本任务与实现。
