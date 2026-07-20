# 数据库 Kit 历史视觉还原设计

## 背景与基线

SQLite 与 MySQL Kit 在拆分成多插件后保留了服务能力，但原本完整的 Workbench 视觉壳被替换成“左侧连接与对象混合栏 + 右侧原生 Panel 标签”。连接区被挤进窄栏，各工作区样式彼此分散，弹窗也受所在 iframe 尺寸限制。

本次还原使用两个可验证的历史基线：

- SQLite：`6524425` 中拆分前的 `@itharbors/sqlite-workbench`。
- MySQL：`7cdce70` 中拆分前的 `@itharbors/mysql-workbench`。

还原只针对视觉壳、布局与交互位置。现有 `core + explorer + data + schema + relationships + sql` 六插件结构、contracts、服务安全边界、SQLite 产品修复和两套新增关系图全部保留。

## 目标

1. 两个 Kit 都恢复“顶部连接区 + 左侧对象栏 + 右侧工作区”的桌面布局。
2. 颜色、字体、边框、密度、按钮、表格、卡片、状态和空态尽量直接复用各自历史 Workbench 的样式，而不是重新设计一套相似主题。
3. 数据、结构、关系图和 SQL 继续作为独立插件工作区，使用框架标签切换；新增关系图保持可访问。
4. SQLite 的打开/新建数据库、手动路径、最近路径、写入确认、文件筛选和全页面居中弹窗恢复到拆分前交互。
5. MySQL 的横向连接表单、连接摘要、对象搜索、对象分组和数据操作区恢复到拆分前位置。
6. 连接、选择、schema/data revision、写入保护、CRUD、SQL 与关系图的数据流不回退到旧单体状态。

## 方案比较

### 采用：重组 Panel 视觉壳

每个 Explorer 插件仍是一个插件，但贡献两个单实例 Panel：`connection` 负责顶部连接区，`explorer` 负责左侧对象栏。Kit layout 使用纵向分割承载连接区，下方再横向分割对象栏与右侧标签组。右侧四个工作区仍由现有四个插件提供。

这一方案能恢复历史布局，同时不复制 core/data/schema/sql/relationships 逻辑。

### 不采用：只替换 CSS

只替换 CSS 无法把连接表单从左栏移回顶部，也无法解决 SQLite 窄 iframe 内弹窗，因此不能满足布局和交互还原。

### 不采用：复活旧单体 Workbench

旧单体能获得最高像素一致性，但会重新集中连接、选择、数据、结构和 SQL 状态，破坏已经完成的插件拆分，并让新增关系图出现两套实现，因此不采用。

## 布局与 Panel 边界

两个 Kit 的 layout 都改成：

```text
┌──────────────────────── 顶部 connection Panel ────────────────────────┐
├────────── explorer Panel ──────────┬──── data / schema / relationships / sql ┤
│                                    │                                        │
│                                    │                                        │
└────────────────────────────────────┴────────────────────────────────────────┘
```

- 顶部连接区使用 `panelType: "simple"`，避免出现额外 Panel 标题栏。
- 左侧对象栏也使用 `panelType: "simple"`，恢复历史对象 rail 的连续外观。
- 右侧保留框架原生 tab group，以确保独立 Panel 的生命周期、拖放、焦点和恢复行为不被自制标签系统替代。
- SQLite 左栏宽度恢复为历史约 250px，MySQL 恢复为约 270px；连接区高度按历史内容设置，并允许分隔条调整。
- 窄窗口继续依靠框架分隔区的最小尺寸与滚动保证可操作；桌面布局是像素还原的主要验收基线。

## Explorer 状态与刷新

拆成两个 iframe 后，不在 Panel 之间复制可变状态：

- `connection` Panel 只持有连接表单、连接快照、连接相关弹窗和操作状态。
- `explorer` Panel 只持有 schema 对象列表、搜索、分组和当前选择。
- Explorer main 继续拥有权威选择，并新增 `refreshObjects()` 请求。它向 core 获取 schema、校验当前选择、选择首个合适对象，并广播带 revision 的对象快照。
- 连接成功、显式刷新和 schema changed 都通过 `refreshObjects()` 更新对象 Panel；迟到 revision 仍被拒绝。
- 连接变化仍由 core topic 驱动两个 Panel，各 Panel 独立 hydrate，不共享 DOM 或父页面对象。

## SQLite 历史交互恢复

SQLite `connection` Panel 复用历史 connection bar：品牌、打开、新建、刷新、关闭、只读/可写状态和当前路径保持在同一横栏。

文件选择器恢复历史行为：

- 初始目录优先最近数据库目录。
- 显示最近路径、“显示全部文件”、目录导航和文件选中态。
- 新建模式提供默认文件名；打开和新建都保留“手动输入路径”。
- 手动路径优先于列表选择，打开已有库仍默认只读。

写入确认和文件选择仍在 Explorer Panel 内实现，但 Panel runtime 新增 `panel.setModalOpen(open)`。宿主只接受当前已挂载 iframe 发出的结构化消息，并临时把对应 `ce-panel` 提升为覆盖整个编辑器的模态承载区。取消、成功、状态重置和 unmount 都恢复布局；连接失败保留输入与弹窗供修正。

## 历史样式映射

### SQLite

直接从 `6524425` 迁移 Workbench 的颜色变量、等宽路径与 SQL 字体、方角网格、青绿色强调、对象图标、数据工具栏、schema 卡片、SQL 编辑器、关系画布、状态与弹窗样式。各独立 Panel 只接收与自身 DOM 对应的历史选择器，避免把旧单体 CSS 整包复制到每个插件。

### MySQL

直接从 `7cdce70` 迁移 `--ink`、`--deck`、`--panel`、`--line`、蓝/青/琥珀状态色、品牌标识、横向连接表单、对象 rail、workspace heading、数据表格、schema 卡片、SQL 编辑器和对话框样式。关系图采用同一变量重着色，保留现有缩放、搜索、适应窗口和节点跳转。

右侧每个 Panel 的标题与操作区使用旧 `workspace-heading` 结构。框架 tab bar 保持原生，但通过 Kit Panel 内容的边界、背景和间距与历史 Workbench 连成一体；不修改全局主题影响其他 Kit。

## 错误、无障碍与生命周期

- 所有按钮、输入、表格行和关系节点保留可见焦点。
- 连接密码仍只保留在 MySQL connection Panel 内，连接请求后立即清空。
- 弹窗使用 `aria-modal`、明确标题、Escape/取消行为和焦点恢复；宿主模态消息不携带 HTML。
- Panel unmount 会清除模态态、递增请求序列并忽略迟到响应。
- 各插件错误继续在本 Panel 就近展示，不建立跨插件全局错误仓库。

## 测试与验收

### 自动化

- Kit manifest 测试固定新的 `vsplit + hsplit + tab` 布局、两个 Explorer Panel 和六插件清单。
- SQLite/MySQL Explorer main 测试覆盖 `refreshObjects()`、revision、选择保留和广播。
- connection Panel 测试覆盖连接操作、密码清空、SQLite 文件浏览/手动路径/写入确认和模态生命周期。
- explorer Panel 测试覆盖对象分组、搜索、选择与刷新快照。
- data/schema/relationships/sql Panel 测试继续覆盖原功能，并增加历史结构 class 与关键可访问名称断言。
- Client/Server 测试覆盖可信 `panel.setModalOpen` 桥、未受信消息拒绝和全工作区 Panel 样式。

### 真实页面

在相同桌面视口分别启动 SQLite 与 MySQL Kit，并与历史结构逐项核对：

1. 顶部连接区横跨工作区。
2. 对象栏只包含对象导航，不再混入连接表单。
3. 数据、结构、关系图、SQL 均可切换且保持新增功能。
4. SQLite 文件弹窗相对整个编辑器居中，并包含历史路径交互。
5. 连接、选择对象、数据读取、结构读取、关系图和 SQL 的端到端流转正常。
6. 窄视口无不可达操作，焦点和滚动可用。

最终运行两个 Kit 聚焦测试、Client/Server 测试、插件构建检查与仓库 `npm run check`。
