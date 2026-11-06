# 工作台初始化恢复与窄屏布局总结

## 最终结论

工作台初始化失败时会显示错误和重试入口。Harness 在 320 和 390 px 下可见中央区与左右 Tab。纯视口往返和窄屏纵向调整均保留横向首选宽度。

## 需求完成情况

- Default Kit 缺少产物时展示失败提示。隔离构建产物后可在原 Session 内重试成功。
- 320 和 390 px 初始布局的中央宽度分别为 96 和 117 px。右侧四个 Tab 均可点，收起侧栏后中央进一步扩展。
- 横屏使用原宽度。鼠标和触屏的拖拽、收起、恢复和旋转通过回归。

## 主要改动

EditorApp 用可重试状态替代无限加载。横向布局允许非 simple 像素列收缩，并为混合布局中的单个弹性 Panel 保留空间。分隔条调整沿同轴路径保存，保留未调整列的像素偏好，受最小宽度约束且没有实际位移时跳过保存。

## 关键决定

继续本地 `main`，在一笔提交内修复两项问题。计划与代码通过独立评审。按用户要求在提交后自测，成功后推送该提交与三笔布局祖先提交。

## 验证结果

- `pnpm --filter @itharbors/client test` 退出 0，类型检查和 321 项测试通过。
- `node docs/tasks/2026-11-06-recover-workbench-and-fit-narrow-layout/.work/browser-verification.mjs --diagnostics` 退出 0。隔离 Web Host，Chrome 157。Default Kit 真实缺产物时显示错误，隔离构建后同页重试恢复六个面板。Harness 的 320 与 390 px 初始 Tab 点击、折叠和恢复，以及 844 px 宽度恢复均通过。窄屏纵向拖动不改写横向宽度，横向受限手势不保存，实际横拖 20 px 持续跟随并保留未拖动右栏的首选 300 px。
- `git diff --check` 通过。

## 影响与风险

收缩仅用于横向可调整像素列，纵向固定尺寸保持原语义。窄屏主动横向调整后，当前页面保留实时比例，刷新时按保存的尺寸语义重排。未调整的列保留首选像素宽度。

## 偏差与遗留

浏览器覆盖 Chromium 模拟触屏及鼠标。移动真机和 Safari 尚未实测。Kit 内容内部的响应式布局不在本次范围内。

## 后续关注

真实移动端验收时分别验证初始展开和收起后的工作区。

## 相关正式文档

- [测试指南](../../guides/testing.md)
- [布局与窗口模型](../../architecture/layout-model.md#resize)

## Decision Delta 与 Findings

- `blocking` 无。
- `non_blocking` 移动真机和 Safari 未覆盖。主动调整后的实时比例与重载使用的缓存尺寸语义见上节。
- `decision_candidates` 无。
- `follow_up` 移动端实机验收。

本次取舍归类为 Task-only，可用 `recover-workbench-and-fit-narrow-layout` 或 `data-retry-initialization` 检索。
