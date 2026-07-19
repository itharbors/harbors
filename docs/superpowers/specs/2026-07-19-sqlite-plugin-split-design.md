# SQLite Kit 多插件拆分设计

## 背景

当前 SQLite Kit 只装载 `@itharbors/sqlite-workbench`。该插件的 main 同时持有数据库连接、文件策略、schema 读取、数据查询与写入、导出、SQL worker 和撤销状态；它的单个 Panel 又同时承担连接、对象导航、数据编辑、结构查看、关系图和 SQL 工作区。结果是服务状态只有一个权威来源，但插件边界、UI 状态和测试边界全部耦合在一个目录中。

本次改造把 Kit 拆成多个真正独立装载、独立贡献 Panel、通过消息协议协作的插件。它不是简单移动文件，也不改变 SQLite 产品能力。

## 目标

- 用一个无界面的核心插件统一持有 SQLite 连接和所有数据库访问，避免多连接带来的事务与模式不一致。
- 将对象浏览、数据编辑、结构查看、关系图和 SQL 工作区拆为可独立构建、校验和测试的 Panel 插件。
- 使用 Kit 原生 `LayoutNode` 组织多个 Panel，不在某个 Panel 内重新实现整套工作台标签布局。
- 保留当前的中文体验、只读默认值、显式写入确认、对象写入限制、十秒单次撤销、分页与导出上限、SQL 风险确认、取消行为和无障碍要求。
- 保持数据库连接、当前对象和数据/schema 变化的单一权威状态，并让晚挂载或丢失广播的 Panel 能通过快照恢复。
- 删除旧 `@itharbors/sqlite-workbench`，使最终 Kit manifest 只声明拆分后的插件。

## 非目标

- 不新增 SQLite 产品功能，不改变查询、导出或渲染上限。
- 不为旧 `@itharbors/sqlite-workbench` 的内部消息名提供兼容代理；它只在该 Kit 内使用，将随 Kit 和测试原子迁移。
- 不把 SQLite 专属能力提升到仓库级内置插件。
- 不改变 MySQL Kit，也不借本次改造抽象跨数据库工作台框架。
- 不持久化 SQL 历史、面板筛选或连接信息；这些状态仍限于当前运行会话。

## 方案比较与决定

### 方案一：每个功能插件独立连接数据库

隔离最直接，但同一文件会出现多个连接。只读/读写切换、活跃 SQL worker、事务、schema 缓存和撤销令牌将分散在不同插件，难以保证关闭与切换的原子性，因此不采用。

### 方案二：只拆 main 服务，保留单一工作台 Panel

迁移量较小，但 UI 状态、渲染、事件委托和无障碍逻辑仍集中在一个巨型 Panel，Kit 也没有获得可组合的插件单元，因此不采用。

### 方案三：核心数据插件加独立功能 Panel

核心插件保留唯一连接和安全边界，五个 UI 插件通过 request 获取数据、通过 broadcast 接收失效通知。布局直接组合这些 Panel。该方案同时保证数据一致性和功能隔离，因此采用。

## 插件边界

### `@itharbors/sqlite-core`

无 Panel。它拥有 `better-sqlite3` 连接、最近路径、写入模式、schema/count 缓存、撤销快照和 SQL worker。现有 `SqliteService`、文件浏览、协议校验、SQL 分析、worker runner 与 worker 迁入此插件。

公开 request：

- 连接与文件：`listDirectory`、`getRecentDatabases`、`getConnectionState`、`openDatabase`、`setConnectionMode`、`closeDatabase`。
- 元数据：`getSchema`、`getObjectSchema`、`getRelationshipGraph`。
- 数据：`getRows`、`exportRows`、`insertRow`、`updateRow`、`deleteRow`、`undoLastMutation`。
- SQL：`analyzeSql`、`executeSql`、`cancelSql`、`explainSql`。

它继续在服务边界验证所有输入并返回结构化中文公开错误。Panel 的确认对话框不能替代核心插件的只读、对象可写性、令牌、影响行数和并发校验。

### `@itharbors/sqlite-explorer`

贡献 `explorer` Panel，负责打开/新建数据库、最近路径、只读/读写切换、关闭连接、对象分组和当前对象选择。插件 main 保存当前选择，并公开：

- `getSelection()`：返回当前连接 revision 下的选择快照。
- `selectObject(input)`：校验对象存在且属于当前 schema，更新选择并广播。

连接或 schema 变化后，Explorer 重新读取对象列表。当前对象仍存在时保持选择，否则选择第一个普通表；没有对象或连接关闭时选择 `null`。窄窗口下的抽屉不再需要，因为 Explorer 是独立的固定侧栏。

### `@itharbors/sqlite-data`

贡献 `data` Panel，负责当前对象的数据分页、搜索、列筛选、排序、行选择、单元格详情、CSV/JSON 导出、记录新增/编辑/删除和撤销入口。筛选、排序、页码、对话框和行选择均为该 Panel 的本地状态；切换对象时清理对象相关状态。

只有该插件消费 CRUD 与行导出请求。写入成功后依赖 core 广播刷新数据，而不是直接操作其他 Panel。

### `@itharbors/sqlite-schema`

贡献 `schema` Panel，展示当前对象的字段、主键、索引、外键、触发器与格式化 DDL，并保留复制和换行切换。它只消费 `getObjectSchema`，不持有数据编辑状态。

### `@itharbors/sqlite-relationships`

贡献 `relationships` Panel，展示数据库全局关系图、搜索、缩放、平移、适应窗口和非 SVG 摘要。关系图仍只包含普通表与虚拟表，不推断外键，视图和 shadow 表不加入图。

点击或键盘激活节点时，该 Panel 调用 Explorer 的 `selectObject`，再通过 Panel runtime 打开或聚焦单实例 Schema Panel，从而保留“从关系图跳到结构”的行为。关系图按连接和 schema revision 缓存；纯 SELECT、CRUD 或撤销不使其失效。

### `@itharbors/sqlite-sql`

贡献 `sql` Panel，负责 SQL 草稿、格式化、补全、风险确认、执行、取消、查询计划、二十条会话历史、结果分页、复制与导出。对象补全从 core schema 快照获得。SQL 草稿和历史在对象切换时保留，在 Panel 卸载时清空。

## 共享协议与依赖方向

新增 `kits/sqlite/shared/`，只包含可序列化 TypeScript 类型、公开错误 envelope、revision 类型和浏览器端通用 request 解包函数。它不得导入 Node API、`better-sqlite3`、DOM 或任何插件实现。

依赖方向固定为：

```text
sqlite-explorer ─┐
sqlite-data ─────┤
sqlite-schema ───┼── request/broadcast ──> sqlite-core
sqlite-relationships ┤
sqlite-sql ──────┘

sqlite-data/schema/relationships/sql ── request/broadcast ──> sqlite-explorer selection
```

Panel 不导入其他插件实现。构建期只允许导入 `kits/sqlite/shared/` 中的协议与纯函数，以及自身插件目录内的模块。

只有 `sqlite-core/package.json` 声明 `better-sqlite3`。其余插件不直接访问文件系统或数据库。

## 状态、revision 与消息契约

Core 维护三个单调递增的会话内 revision：

- `connectionRevision`：成功打开、创建、模式切换或关闭连接后递增。
- `schemaRevision`：连接变化以及成功改变 schema 的 SQL 后递增。
- `dataRevision`：连接变化以及成功 CRUD、撤销或改变数据的 SQL 后递增。

`getConnectionState` 和 `getSchema` 的响应携带相关 revision。每个异步 Panel 请求在发起时记录连接/选择/revision；响应到达后只有仍匹配当前状态才可提交到 UI。Panel 自己的 request sequence 继续用于拒绝同一 revision 内的乱序响应。

Core 广播：

- `@itharbors/sqlite.connection.changed`：连接快照与三个 revision。
- `@itharbors/sqlite.schema.changed`：`connectionRevision`、`schemaRevision`、`dataRevision`。
- `@itharbors/sqlite.data.changed`：revision 与受影响对象名；无法可靠确定目标的 SQL 使用 `objectName: null`，由消费者保守刷新。

Explorer 广播：

- `@itharbors/sqlite.selection.changed`：`connectionRevision`、所选对象名或 `null`。

广播只用于失效通知，不作为唯一状态来源。所有 Panel 在 mount 时请求 core 连接/schema 快照和 Explorer 选择快照。revision 不匹配时清空旧视图并重新取快照，避免依赖插件装载顺序或广播到达顺序。

## 布局与交互

Kit 默认布局改为：

```text
┌──────────────────┬────────────────────────────────────────────┐
│ SQLite Explorer  │ Data | Schema | Relationships | SQL       │
│ 固定约 300px     │ 原生 tab group，Data 默认激活             │
└──────────────────┴────────────────────────────────────────────┘
```

对应 `LayoutNode` 为根 `hsplit`，左侧 `leaf` 是 Explorer，右侧 `tab` 包含四个功能 `leaf`。所有 Panel 均为 `multiInstance: false`。`activePanel` 为 Data。用户仍可使用框架已有的标签拖拽、分栏和浮动能力。

每个 Panel 自带标题、加载态、空态和错误区域，不依赖另一个 iframe 的 DOM。连接摘要只在 Explorer 展示；功能 Panel 只显示与本功能有关的当前对象或数据库级上下文，避免重复状态栏。

## 错误处理与生命周期

- Core 延续 `$sqliteWorkbenchError` 的 envelope 语义，但字段名改为中性的 `$sqliteError`；共享解包函数把它转换为 Panel 可展示的错误。
- 用户可处理错误显示中文 message；原始 detail 保持在折叠区域，不把堆栈直接暴露为主文案。
- 某个 Panel 请求失败只影响该 Panel。连接切换失败必须保留原连接，写入或 SQL 失败不得发布成功广播。
- Core unload 时终止活跃 worker、关闭数据库并使 pending 操作失败；重复 unload 保持幂等。
- 连接切换和关闭继续等待活跃 SQL worker 终止，不能在旧 worker 运行时替换连接。
- Panel unmount 时注销 DOM/media listener、取消本地 timer、递增 request sequence 并丢弃迟到响应；它不关闭共享数据库连接。

## 迁移策略

1. 先建立 shared 协议和 `sqlite-core`，原样迁移服务实现与服务层测试，验证消息 manifest 与 unload。
2. 建立 Explorer 及选择协议，把连接、文件选择和对象树从旧 Panel 迁出。
3. 依次迁移 Data、Schema、Relationships、SQL；每一步搬迁对应纯函数、样式、Panel 测试和可访问性断言，不在两个插件间复制实现。
4. 更新 Kit manifest 和布局，增加跨插件运行时测试。
5. 只有在所有行为测试通过且仓库内没有源代码、manifest、文档或测试引用旧插件名时，删除 `sqlite-workbench` 及其 dist。
6. 使用插件构建脚本重新生成并校验每个插件的 dist；生成物与源码一同提交。

迁移期间允许中间提交尚未被 Kit manifest 装载的新插件，但每个提交必须有自己的聚焦测试。最终提交必须完全移除旧插件，不能长期保留双实现或兼容分支。

## 测试策略

### Core 单元与契约测试

- 搬迁现有 protocol、file browser、service、mutation、SQL analysis 和 worker 测试，确保数据序列化、安全校验、分页、导出、撤销、取消及连接原子性不变。
- 新增 revision 测试：失败操作不递增；连接、DDL、DML、CRUD 与 undo 只递增规定的 revision。
- 验证 manifest 中每个 request 都有同名 method，公开错误使用 `$sqliteError`，重复 unload 会安全关闭服务。

### Panel 单元测试

- 每个 Panel 使用 jsdom 和 mock message runtime 独立测试 mount、交互、错误、空态、迟到响应和 unmount。
- Explorer 覆盖受控文件选择、最近路径、写入确认、对象分组与选择广播。
- Data 覆盖查询、筛选、排序、导出、显式类型编辑、删除确认、撤销、焦点恢复及只读状态。
- Schema 覆盖完整结构、DDL 文本安全渲染、复制和换行。
- Relationships 保留布局、五千表链、循环/自引用/平行边、搜索、缩放、平移、摘要和键盘跳转测试。
- SQL 保留格式化、补全、风险确认、分页、历史、复制/导出、取消和错误后保留输入测试。
- 原有颜色、焦点、modal trap、reduced-motion、ARIA live/alert 和表格语义检查按职责迁入对应插件。

### 跨插件与 Kit 集成测试

- Kit manifest 精确声明六个新插件，布局包含 Explorer leaf 和四 Panel tab group，且不存在旧插件名。
- 真实 Editor 装载 Kit 后，通过 `@itharbors/sqlite-core` 完成只读打开、模式切换、CRUD、undo、schema、关系图、SQL 与关闭。
- 通过 Explorer 设置选择后，验证选择广播路由注册并能驱动各功能 Panel 的声明处理器。
- 验证 core 数据/schema 广播仅在成功操作后发出，Kit unload 后所有新插件的 Panel 和消息路由均被清理。

### 验证命令

- 对六个插件分别运行 `node scripts/ce-plugin.mjs build <plugin-path>` 与 `check`。
- 运行 `npm test -w @itharbors/kit-sqlite`。
- 运行仓库 `npm run check`。
- 启动 `npm run dev -- --kit ./kits/sqlite`，人工验证打开/创建、切换写入、对象切换、四个功能标签、CRUD/undo、关系图跳转、SQL/取消和窄窗口可用性。

## 完成标准

- `kits/sqlite/plugins/` 下存在六个职责明确的新插件，不再存在 `sqlite-workbench`。
- Kit manifest、默认布局、README、构建产物和测试全部使用新插件名。
- `better-sqlite3` 连接只由 `sqlite-core` 创建和关闭。
- 五个 UI 插件之间不直接导入实现，所有跨插件协作均经过声明的 request/broadcast 契约。
- 现有 SQLite 功能与安全约束均有迁移后的自动化测试证据。
- 六个插件 build/check、SQLite Kit 测试和仓库 `npm run check` 全部通过。
- 本地人工烟测覆盖默认布局与关键跨 Panel 流程，未发现阻断问题。
