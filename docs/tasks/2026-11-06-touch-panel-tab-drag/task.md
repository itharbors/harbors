# Panel Tab 触屏拖拽中断

Task ID: `2026-11-06-touch-panel-tab-drag`
Type: `bug`

## 背景与问题

桌面鼠标可以拖拽 Panel Tab。Chromium 触屏模拟中，手指横移 12 px 时开始拖拽，继续到约 16 px 后浏览器发出 `pointercancel`。Panel 标签栏的 `touch-action: pan-x` 允许浏览器接管横向手势，导致未抬手便清理拖拽状态。

## 目标

从 Panel Tab 按钮起手时，横向移动优先触发拖拽，达到现有阈值后持续到抬手。轻点仍切换 Tab，桌面鼠标仍能拖拽。

## 范围

Framework Client 的 `ce-panel-group` 拖拽起点样式和回归验证。保留现有拖拽阈值、目标解析、取消清理、布局保存与标签栏容器的滚动设置。

## 非目标

新增标签栏滚动控件、长按手势、移动端跨窗口拖放，或调整 Kit 布局与 Plugin。

## 验收标准

- 使用 Chromium 触屏输入从 Tab 起手水平拖过阈值，可继续拖到目标位置，抬手后完成跨组移动和组内重排。
- 轻点可切换 Tab。桌面鼠标拖拽通过回归，取消拖拽后遮罩清理。
- 通过 Client 局部测试及真实 Harbors Harness Web 页面交互验证，记录输入和覆盖边界。

## 约束

沿用 [布局与窗口模型](../../architecture/layout-model.md#tab-拖放) 和 [测试指南](../../guides/testing.md)。适用 [ADR 0002](../../decisions/0002-web-only-host.md) 与 [ADR 0004](../../decisions/0004-automated-development-workflow.md)。本次处理现有 CSS 和手势的冲突，取舍留在 Task 内。

## 需求变更

用户确认从 Tab 按钮起手的横滑优先用于拖拽，选择在当前 `main` 分支修复并单独提交。标签栏溢出时，从 Tab 按钮起手的横滑也用于拖拽。
