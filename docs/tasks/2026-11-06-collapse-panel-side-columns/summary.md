# 双击 Tab 收起侧栏总结

## 最终结论

双击侧栏 Tab 名称可收起整列，点击侧边入口展开。右侧上下两组会一起收起。390 px 竖屏下，两侧都收起时中央工作区可用宽度为 334 px。

## 需求完成情况

- 支持桌面双击和触屏双点。单点切换、Tab 跨组拖拽和剩余分隔条调整通过回归。
- 展开入口支持鼠标、触屏和键盘。展开复用原面板和 iframe，恢复保存前的列宽。
- 收起在当前页面生效。刷新后展开，用户调整过的宽度从布局缓存恢复。

## 主要改动

Panel Group 在同一 Tab 收到两次有效轻点后，发送冒泡事件 `ce-panel-column-collapse`。EditorApp 接收事件并收起最外层横向分割的边缘列，保留侧边展开按钮。调整其他列时，缓存保留隐藏列和临时填充列的原尺寸。

## 关键决定

用户选择先实现整列收起供审核，作为独立本地提交。保持至少一个列可见。仅保存用户拖出的尺寸，收起状态随页面生命周期管理。计划和实现通过独立评审。

## 验证结果

- `pnpm --filter @itharbors/client test` 退出 0，类型检查及 317 项测试通过。固定列临时填充和嵌套布局尺寸已覆盖。
- `node docs/tasks/2026-11-06-collapse-panel-side-columns/.work/browser-verification.mjs` 退出 0。隔离 Harness，Chrome 157.0.8103.38。鼠标和触屏覆盖整列收起、键盘或点按恢复、面板和 iframe 文档身份、Tab 拖动、旋转和刷新。右栏收起时将左栏从 305 调至 325 px，展开后右栏仍为 300 px。
- 390 × 844 窄屏截图位于 `.work/collapsed-portrait.png`。两侧入口各 28 px，中央 334 px，可在聊天输入框键入。隔离环境关闭凭据，页面显示模型 Provider 未配置，未发送模型消息。
- `git diff --check` 通过。

### 审核后修复与复验

竖屏触屏第二次点按触发收起后，浏览器补发的 `click` 会落到同一坐标的新展开条上。EditorApp 在成功收起后消费这一点击。下一次独立指针或触摸起手会解除保护，键盘展开仍可用。

- `pnpm --filter @itharbors/client test` 退出 0，类型检查及 319 项测试通过。
- `node docs/tasks/2026-11-06-collapse-panel-side-columns/.work/collapse-click-verification.mjs` 退出 0。Chromium 在 844 × 390 横屏和 390 × 844 竖屏从初始展开状态逐个验证，鼠标和触屏均可收起，再单点展开。同一手势不激活其他组。收起一侧后旋转，再收起另一侧并转回也通过。
- 320 px 视口中，可点到的 Tab 均通过收起和展开。设置与消息调试两个 Tab 仍超出视口。
- 原隔离测试地址已提供修复后的源码。对该地址刷新后重测 390 px 竖屏的设置 Tab，双点后保持收起，另点展开入口可恢复。

## 影响与风险

功能作用于最外层横向分割的左右边缘列。收起时侧边入口占用 28 px，中心列继续使用余下空间。

## 偏差与遗留

移动真机和 Safari 未覆盖。验收另记录一条 favicon 404。

## 后续关注

等待用户审核第一版交互与窄屏呈现。

## 相关正式文档

- [布局与窗口模型](../../architecture/layout-model.md#tab-拖放)
- [测试指南](../../guides/testing.md)

## Decision Delta 与 Findings

- `blocking` 无。
- `non_blocking` 真机和 Safari 未实测。截图为隔离环境，验收另有 favicon 404。
- `decision_candidates` 无。
- `follow_up` 用户审核后确认是否继续调整。

本版行为与取舍归类为 Task-only，可用 `collapse-panel-side-columns` 或 `ce-panel-column-collapse` 检索。
