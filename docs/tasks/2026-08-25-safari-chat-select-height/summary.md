# 2026-08-25-safari-chat-select-height 实现总结

## 最终结论

Task 已实现并验证：Harness Chat Panel 的原生选择框使用明确的 `28px` 外框高度和零垂直 padding，不再由 Safari 与 Chromium 的默认行盒计算决定控件高度。Chromium 计算样式测量和 Safari 实机视觉复核均确认模型、权限范围、审批策略三个选择框对齐，文字与原生下拉箭头可见且无上下裁切。

## 需求完成情况

- 模型选择框在 Safari 与 Chromium 中保持一致的明确高度。
- 模型、权限范围和审批策略选择框处于相同 top/bottom 基线，文字垂直显示正常。
- 原生 `appearance`、下拉箭头、宽度、文本省略与禁用态未改变。
- 聚焦 CSS 契约测试、Harness Kit 构建/校验、完整局部测试和 Web 浏览器验收均通过。

## 主要改动

- `panel.main/src/styles.css`：为 `.option-picker select` 增加 `height: 28px`，将 padding 改为 `0 22px 0 8px`。
- `panel.main/src/index.css`：通过 Chat Plugin PostCSS build 同步生成相同运行时规则。
- `panel.main/src/transcript.test.ts`：新增跨浏览器高度契约测试，同时断言源 CSS 与生成 CSS，避免漏生成或重新依赖浏览器默认高度。

## 关键决定

### Decision Delta

| 分类 | 变化或决定 | 证据来源 | 影响范围 | 状态与落点 | 反向检索 |
| --- | --- | --- | --- | --- | --- |
| Task-only | 原生 Chat 选择框以 `28px` 外框和零垂直 padding 固定跨浏览器高度，同时保留 `appearance: auto` | 用户 Safari 反馈、Chromium 计算样式、Safari 实机截图、独立计划与代码审查 | `kits/harness/plugins/chat/panel.main` | 已验证；保留在本 Task 与样式契约测试 | 查询 `safari-chat-select-height`、`.option-picker select`、`cross-browser height` 可命中 Task 或实现；无需新增 ADR/architecture/guide |

- 已批准决策：继续遵守 Kit 内闭环与唯一 Web 宿主验收规则，没有新增或修订长期架构决策。
- 当前架构事实：Chat Plugin 的 `styles.css` 经 PostCSS 生成 `src/index.css`，运行页面使用生成 CSS。
- 操作方法：对保留原生外观的 `select` 使用明确 border-box 外框高度，并避免依赖浏览器默认垂直 padding；本结论仅作为本组件的已验证实现，不泛化为仓库级设计规范。
- 待讨论方案：无。
- 一次性任务证据：Chromium 三个控件计算高度均为 `28px`、上下 padding 均为 `0px`、top/bottom 均一致；Safari 实机截图显示文本、箭头和基线正常。
- 冲突或例外：无。

## 验证结果

- `pnpm --dir kits/harness/plugins/chat build`：通过，PostCSS 正确更新运行时 `src/index.css`。
- `pnpm --dir . exec tsx --test kits/harness/plugins/chat/panel.main/src/transcript.test.ts`：25/25 通过。
- `pnpm --dir kits/harness run build`：通过，Harness Kit 识别 9 个 Plugin。
- `pnpm --dir kits/harness run test:kit`：通过；Kit validate 成功，单元测试 257/257、Plugin smoke 1/1、assembly 6/6。
- `git diff --check`：通过。
- 独立计划复审与独立代码审查：最终 blocking 均为 0。
- Chromium Web 宿主：模型、权限范围、审批策略选择框实测均为 `height: 28px`、`padding-top/bottom: 0px`，三者 top/bottom 坐标一致；视觉截图确认工具栏未错位。
- Safari 实机：同一本地 Harness 页面加载成功，三个选择框位于同一基线，已选文本与原生箭头清晰、无上下裁切。

## 影响与风险

### blocking

- 无。

### non_blocking

- 无已知非阻塞风险；选择框继续保留浏览器原生 `appearance`，本次只固定外框尺寸和内容 padding。

### decision_candidates

- 无。

## 偏差与遗留

- 没有已知偏差与遗留；实现未越过 Harness Chat Plugin 边界。

## 后续关注

### follow_up

- 无；若未来调整 composer 字号或控件密度，应同步更新源/生成 CSS 契约测试，并在 Safari 与 Chromium 复验文字裁切和工具栏对齐。

## 相关正式文档

- `docs/tasks/2026-08-25-safari-chat-select-height/task.md`
- `docs/guides/testing.md`
- `docs/guides/developing-plugins-and-kits.md`
