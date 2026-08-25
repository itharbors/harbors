# 2026-08-25-safari-chat-select-height

Task ID: `2026-08-25-safari-chat-select-height`
Type: `bug`

## 背景与问题

Harness Kit 的 Chat Panel composer 工具栏中，模型选择框在当前 Web 浏览器与 Safari 上呈现的高度不一致。用户已通过浏览器批注明确标记 `.option-picker.model-picker > select`；现有样式仅设置垂直 `padding`，未固定控件高度，Safari 的原生 `select` 外观和行盒计算会导致跨浏览器尺寸差异。

## 目标

- 让 Chat Panel 的模型选择框在 Safari 与当前 Chromium Web 宿主中保持一致的可见高度和垂直对齐。
- 保留现有文本截断、禁用态和工具栏布局行为。

## 范围

- `kits/harness/plugins/chat/panel.main` 内模型/选项选择控件的样式与必要的聚焦测试。
- 本 Task 的需求、状态和收口文档。

## 非目标

- 不调整 Chat composer 的整体视觉设计、模型数据来源或选择交互。
- 不修改 Harness Kit 目录之外的 Framework、其他 Kit 或 Plugin。
- 不加入 Electron、桌面宿主或原生窗口假设。

## 验收标准

- 模型选择框在 Safari 与 Chromium 中具有一致的明确高度，文字垂直居中且不被裁切。
- 工具栏内模型、权限范围、审批策略等同类选择控件保持对齐，窄宽布局和文本省略行为不回归。
- Harness Chat Plugin 的相关测试、Harness Kit 构建/校验、`git diff --check` 通过。
- 使用唯一 Web 宿主完成浏览器验收，并记录 Safari 实机复核是否需要用户协助。

## 约束

- 严格限制业务代码修改在 `kits/harness/plugins/chat/**`；若必须越界，先停止并取得用户同意。
- 优先使用标准 Web CSS 消除浏览器默认控件尺寸差异，不做浏览器 UA 判断。
- 保留当前工作区已有改动，不执行 stash、reset、push、PR 或本地整合，除非后续获得对应授权。

## 需求变更

- 本 Task 未发生需求变更。

## 决策上下文与处置

- 检索意图与范围：确认 Safari 差异是否已有宿主级或 Kit 级约束，并定位模型选择框实现。已扫描 `docs/decisions`、`docs/architecture`、`docs/guides`、相关 Task，以及 `kits/harness/plugins/chat/panel.main` 的实现路径；外部 decision memory 未用于本次局部样式缺陷。
- 已批准来源与适用性：`docs/architecture/core-principles.md` 的 Kit 能力边界适用；`docs/guides/developing-plugins-and-kits.md` 与 `docs/guides/testing.md` 的 Kit 内闭环、Web 宿主浏览器验收规则适用；`docs/tasks/2026-08-16-agent-chat` 仅提供 Safari Web 兼容性先例，不直接规定本控件实现。未发现与本次局部 CSS 修复冲突的 accepted ADR。
- 逐条处置：业务修改限定在 Harness Chat Plugin；跨浏览器一致性使用标准 CSS 约束，不引入 UA 分支；最终验证同时覆盖聚焦自动化与 Web 浏览器可见行为。Safari 实机结果若无法由当前环境直接取得，将作为明确验证缺口交由用户复核，不以 Chromium 结果替代。
- 分工：owner 为当前主 Agent，负责范围控制、实现与状态推进；reviewer 为执行计划中的代码审查工作单元，负责 CSS 兼容性和回归面；approver 为用户，负责工作环境选择、任何越界授权及最终交付选择。角色来源为 Harbors change workflow 与本次用户反馈。
- 角色反馈与人工确认：用户反馈确认“Safari 上高度和当前所见不一致”，属于需求证据而非新的长期架构决策；当前唯一待人工确认项是执行环境选择。
- 过程关联：Kit 边界约束映射到仅修改 `kits/harness/plugins/chat/**`；Web 验收规则映射到 Harness Kit 针对性测试、构建/校验和浏览器检查；若范围或根因发生变化，将重新检索并更新本节后再继续。
