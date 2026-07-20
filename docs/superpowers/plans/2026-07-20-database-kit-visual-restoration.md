# 数据库 Kit 历史视觉还原实施计划

> 设计依据：`docs/superpowers/specs/2026-07-20-database-kit-visual-restoration-design.md`

## 目标

在保留 SQLite、MySQL 六插件拆分结构与现有功能的前提下，尽可能恢复拆分前工作台的布局、主题、组件层级与交互。SQLite 以提交 `6524425` 为视觉基线，MySQL 以提交 `7cdce70` 为视觉基线。

## 实施原则

- 先写会失败的行为测试，再写最小实现，再运行聚焦测试。
- 每个阶段保持可构建，并以一个聚焦提交收口。
- 不把六个插件重新合并；连接区、对象栏、数据、结构、关系图、SQL 仍由独立 Panel 提供。
- 历史 CSS 从基线提交提取，按现有 Panel 边界迁移，避免凭印象重画。
- 桌面端优先恢复；窄窗口保证控件可滚动、弹窗可用且不丢功能。

## 任务一：为 Panel 增加可信的全工作区模态能力

**涉及文件**

- `packages/server/src/routes/panel-asset.ts`
- `packages/server/tests/routes/panel-asset.test.ts`
- `packages/client/src/components/editor-app.ts`
- `packages/client/tests/components/editor-app.test.ts`
- `packages/client/src/layout/panel.ts`
- `packages/client/tests/layout/panel.test.ts`

**测试先行**

1. 在 Panel 资产注入测试中断言 `context.panel.setModalOpen(open)` 存在，并发送 `ce-panel-modal-state` 消息。
2. 在编辑器测试中构造两个 Panel iframe，断言消息只影响 `event.source` 对应的 Panel；未知来源不改变任何 Panel。
3. 在 Panel 测试中断言 `modal-open` 状态拥有固定定位、覆盖工作区、隐藏标题栏的样式契约。

**实现**

1. 在注入的 Panel context 中加入布尔值校验后的 `setModalOpen`。
2. 编辑器监听消息，逐个比对已渲染 Panel shadow root 内 iframe 的 `contentWindow`，仅为可信来源切换 `modal-open` 属性。
3. Panel host 在 `modal-open` 时使用 `position: fixed; inset: 0; z-index: 10000`，取消尺寸限制并隐藏宿主标题栏。
4. Panel 卸载、关闭或切换时清理属性，避免悬挂遮罩。

**验证**

```bash
npm exec -w packages/server -- vitest run tests/routes/panel-asset.test.ts
npm exec -w packages/client -- vitest run tests/components/editor-app.test.ts tests/layout/panel.test.ts
```

**提交**

```text
[Bug] 支持 Panel 全局模态布局
```

## 任务二：恢复 SQLite 顶部连接条与左侧对象栏

**涉及文件**

- `packages/sqlite-contracts/src/contracts.ts`
- `kits/sqlite/layout.json`
- `kits/sqlite/plugins/sqlite-explorer/package.json`
- `kits/sqlite/plugins/sqlite-explorer/src/main/index.ts`
- 新建 `kits/sqlite/plugins/sqlite-explorer/panel.connection/src/*`
- 调整 `kits/sqlite/plugins/sqlite-explorer/panel.explorer/src/*`
- 对应 explorer main、两个 Panel、Kit manifest 测试

**测试先行**

1. 为 `@itharbors/sqlite.objects.changed` 契约补测试。
2. 为 explorer main 的 `refreshObjects()` 补测试：读取结构、修正失效选择、广播对象快照。
3. 为 connection Panel 补测试：打开、新建、刷新、关闭、写入开关、最近路径、手动路径、目录导航与默认文件名保持可用。
4. 为 object Panel 补测试：消费对象快照、过滤、分组、选择表/视图并调用 explorer command。
5. 为 layout 补断言：根为 `vsplit`，顶部是 simple connection Panel；下方为 `hsplit`，左侧 simple explorer Panel，右侧仍是四个插件的原生标签组。

**实现**

1. explorer main 成为对象快照唯一来源；连接变化后调用 `refreshObjects()` 并广播。
2. 将连接与文件对话框逻辑移动到 `panel.connection`，对象树逻辑留在 `panel.explorer`。
3. 文件/写入对话框打开时调用 `context.panel.setModalOpen(true)`；取消、成功、重置和卸载时明确关闭；失败时保留对话框及错误。
4. layout 使用顶部约 78px、左侧约 250px 的历史比例，右侧保留 data/schema/relationships/sql 插件。
5. 从 `6524425` 精确迁移历史 token 与连接条、品牌块、对象栏、搜索、对象列表、文件对话框样式；补窄宽度横向滚动。

**验证**

```bash
npm run build -w @itharbors/sqlite-contracts
npm exec -w @itharbors/kit-sqlite -- vitest run --config vitest.config.ts
npm run build -w @itharbors/sqlite-explorer
```

**提交**

```text
[Bug] 还原 SQLite 工作台导航布局
```

## 任务三：恢复 SQLite 四个工作区的历史外观

**涉及文件**

- `kits/sqlite/plugins/sqlite-data/panel.data/src/*`
- `kits/sqlite/plugins/sqlite-schema/panel.schema/src/*`
- `kits/sqlite/plugins/sqlite-relationships/panel.relationships/src/*`
- `kits/sqlite/plugins/sqlite-sql/panel.sql/src/*`
- 四个 Panel 的测试

**测试先行**

1. 断言四个工作区都恢复 `.workspace`、`.workspace-heading`、`.status-bar` 等公共层级。
2. 分别断言历史关键结构存在：数据工具栏/表格/分页/详情，结构卡片，关系画布/详情，SQL 编辑器/结果区。
3. 保留当前新增功能的既有测试并确保新 DOM 不改变事件语义。

**实现**

1. 只调整视图结构与样式，不改命令、数据状态、分页、编辑、关系加载和 SQL 执行流程。
2. 从 `6524425` 迁移每个工作区对应的历史 selector 与主题变量。
3. 用统一 workspace heading 消除原生 Panel 标签下方的第二套现代卡片式标题视觉。
4. 对长表格、SQL 结果、关系画布保持内部滚动。

**验证**

```bash
npm exec -w @itharbors/kit-sqlite -- vitest run --config vitest.config.ts
npm run build -w @itharbors/sqlite-data
npm run build -w @itharbors/sqlite-schema
npm run build -w @itharbors/sqlite-relationships
npm run build -w @itharbors/sqlite-sql
```

**提交**

```text
[Bug] 还原 SQLite 工作区视觉
```

## 任务四：恢复 MySQL 顶部连接条与左侧对象栏

**涉及文件**

- `packages/mysql-contracts/src/contracts.ts`
- `kits/mysql/layout.json`
- `kits/mysql/plugins/mysql-explorer/package.json`
- `kits/mysql/plugins/mysql-explorer/src/main/index.ts`
- 新建 `kits/mysql/plugins/mysql-explorer/panel.connection/src/*`
- 调整 `kits/mysql/plugins/mysql-explorer/panel.explorer/src/*`
- 对应 explorer main、两个 Panel、Kit manifest 测试

**测试先行**

1. 为 `@itharbors/mysql.objects.changed` 与 main 的对象快照广播补测试。
2. connection Panel 覆盖主机、端口、用户名、密码、数据库、TLS、连接与断开；连接成功后密码不保留。
3. object Panel 覆盖表/视图分组、过滤和选择。
4. layout 断言与 SQLite 同构，左栏约 270px，右侧四插件标签组不变。

**实现**

1. 拆分现有 explorer Panel 的连接表单和对象树，main 统一刷新并广播对象快照。
2. 迁移 `7cdce70` 的深蓝主题 token、连接条、品牌标识、状态摘要与对象栏结构。
3. 保持当前连接能力、TLS 参数、自动刷新、断线清理和选择广播不变。

**验证**

```bash
npm run build -w @itharbors/mysql-contracts
npm exec -w @itharbors/kit-mysql -- vitest run --config vitest.config.ts
npm run build -w @itharbors/mysql-explorer
```

**提交**

```text
[Bug] 还原 MySQL 工作台导航布局
```

## 任务五：恢复 MySQL 四个工作区的历史外观

**涉及文件**

- `kits/mysql/plugins/mysql-data/panel.data/src/*`
- `kits/mysql/plugins/mysql-schema/panel.schema/src/*`
- `kits/mysql/plugins/mysql-relationships/panel.relationships/src/*`
- `kits/mysql/plugins/mysql-sql/panel.sql/src/*`
- 四个 Panel 的测试

**测试先行**

1. 断言历史 workspace heading/status 层级与各视图关键类名。
2. 保留当前新增的数据编辑、分页、结构、关系图和 SQL 行为测试。

**实现**

1. 从 `7cdce70` 迁移 MySQL 历史主题与组件样式。
2. 数据区恢复对象身份、动作栏、能力提示、表格、分页、记录表单。
3. 结构区恢复 schema card/item；关系区在不删当前能力的情况下恢复历史画布视觉；SQL 区恢复编辑器与结果区。
4. 各 iframe 使用一致的历史 token，确保插件边界不可见。

**验证**

```bash
npm exec -w @itharbors/kit-mysql -- vitest run --config vitest.config.ts
npm run build -w @itharbors/mysql-data
npm run build -w @itharbors/mysql-schema
npm run build -w @itharbors/mysql-relationships
npm run build -w @itharbors/mysql-sql
```

**提交**

```text
[Bug] 还原 MySQL 工作区视觉
```

## 任务六：双 Kit 浏览器验收与全量检查

**自动验证**

```bash
npm run plugins:build
npm run plugins:check
npm run check
```

**浏览器验收**

1. 启动 SQLite Kit，桌面宽度检查顶部连接条、左侧对象栏、右侧标签与四个工作区。
2. 打开 SQLite 文件选择和写入模式弹窗，确认覆盖整个工作区且可直接输入地址；验证取消、失败、成功后的模态状态。
3. 用约 820px 宽度检查连接条可滚动、对象栏可用、弹窗不被裁切。
4. 启动 MySQL Kit，检查连接表单、TLS、对象选择、四个工作区及断开状态。
5. 对照两个历史基线截图检查颜色、间距、层级和主要交互；记录因六插件原生标签结构而保留的已知差异。

**完成标准**

- 两个 Kit 保持六插件结构和现有功能。
- 顶部连接条、左侧对象栏与历史工作区视觉恢复。
- SQLite 弹窗居中覆盖整个工作区，并保留手动地址入口。
- 聚焦测试、插件构建检查和仓库全量检查通过。
- `git status --short` 仅包含本任务预期变更。

