# Harbors Harness UI 规范

## 目标与范围

Harness 是需要长时间阅读和操作的 Agent 工作台。界面保持安静、清晰和一致，让对话、执行过程与预览内容成为重点。本规范属于 Harness Kit；使用现有工作台布局，不增加全局页头或页脚。

## 视觉基础

- 深色主题：以石墨灰构建画布、表面和浮层，用细边框表达边界。蓝色用于主要操作、选中和键盘焦点；成功、警告和错误色只表达对应状态。
- 颜色通过 Kit `package.json` 的 `ce-editor.kit.theme` 覆盖 `--ce-*` 语义变量；Panel 由宿主同步同一主题。优先使用 `--ce-surface`、`--ce-surface-raised`、`--ce-border`、`--ce-text-primary`、`--ce-text-secondary`、`--ce-text-muted`、`--ce-accent` 和状态变量，不在每个面板重复定义基础颜色。
- 字体使用系统无衬线字体；正文 14px、说明 12px，标题依据层级适当放大；代码使用系统等宽字体。颜色与字号须保证可辨识。
- 间距沿 4、8、12、16、24、32px 的节奏；控件以 8px 圆角为主，浮层或输入区域可使用 12px。紧凑界面允许按内容调整。

## 组件与状态

优先使用原生按钮和表单元素，保留其键盘、表单和无障碍语义。输入控件应有可见标签或无障碍名称；复选框和单选框使用原生 `input` 与关联的 `label`，同组单选框使用相同的 `name`。开关也使用复选框，确保名称与状态可被读取。

首批共享样式包括：

- 按钮：原生 `button.h-button`，配合 `h-button--primary`、`h-button--secondary`、`h-button--ghost` 或 `h-button--danger`。单个区域只突出一个主要操作；非提交操作明确使用 `type="button"`。
- 表单：`input.h-input`、`textarea.h-textarea`、`select.h-select`、复选框 `input.h-check` 和单选框 `input.h-radio`。开关使用 `label.h-switch` 包含原生复选框、`span.h-switch__track`（`aria-hidden="true"`）和可见标签。
- 内容与反馈：`h-card`、`h-table`、`h-badge` 和 `h-alert`；徽标和提示可使用对应的 `--success`、`--warning`、`--danger` 完整前缀修饰类，例如 `h-alert--warning`。
- 列表项：使用 `.h-list-item`，设置导航与会话列表共享同一规格。最小高度 36px，允许内容增高；内边距上右下左为 6/12/6/8px，项间距 2px，圆角 7px，文字 13px、字重 650、行高 1.35。默认背景透明，悬停使用 `--ce-surface-hover`，选中使用 `--ce-selection-bg`，选中后悬停保持选中背景；键盘焦点使用 2px `--ce-focus-ring` 内描边，禁用项透明度 0.5 且不可交互。按钮用 `aria-pressed` 表示选中；带内部操作的复合项保留自己的键盘与无障碍语义，并同步选中和禁用状态。长设置名称可换行，会话标题可截断；不要固定高度。

原有 `<harness-button>` 仍可作为主要按钮使用，内部为 `type="button"` 的原生按钮；支持 `disabled` 和 `aria-label`，点击事件正常冒泡。它不是表单提交按钮；需要提交表单时使用原生 `button type="submit"`。

悬停轻微提亮，键盘焦点必须清晰可见，禁用和错误状态应可辨识。状态不能只依赖颜色；动画需尊重减少动态效果的系统设置。针对不同面板的业务内容可有自身布局，不应重新定义通用控件的视觉语言。

## 插件接入

Kit 声明一个 `panelUi` JS 入口，由 Framework 在直接承载的 Panel iframe 启动插件前加载；插件不需要引入 Kit UI 包。入口会自动为该 iframe 的 `Document` 安装共享样式，插件无需手动调用；使用原生 Shadow DOM 的区域则需要对其 `ShadowRoot` 显式调用 `window.HarnessUI.install(shadowRoot)`。也可调用 `window.HarnessUI.install(document)`；同一根节点可重复调用，样式只安装一次。样式使用主题变量，业务布局和特殊状态仍由插件负责。

每个 iframe 有独立的 Custom Elements 注册表，`harness-button` 使用原生 Shadow DOM 隔离样式。入口是单文件 JS bundle，不支持运行时从此入口导入其他文件。Framework 不向设置页中的嵌套 iframe 注入入口；Settings 面板会在同源子页面加载后为其文档补装共享样式，但不会向子窗口注册 `HarnessUI` 或自定义元素。跨源、入口不可用或安装失败时继续使用子页面本地样式；插件应保留独立运行的回退样式和原生控件行为。嵌套页面不能假定共享 API 在启动时存在，也不能假定继承父页面主题变量。

当前已接入的业务控件包括对话中的目录选择和权限操作、会话列表的新建及重命名、归档对话操作、Agent 和模型服务设置表单、插件重启、消息调试清除，以及网页预览的视口输入和交互模式按钮。编辑器、图标按钮、会话或预览标签、消息内容和预览文档等保留适合业务的专用样式；局部 CSS、嵌套环境和未接入的控件仍需按面板检查，不表示所有界面自动统一。

通过工作台菜单“视图 → 面板 → 界面规范”查看实际共享控件和交互示例。Kit 外插件是否采用本规范由其自身决定。
