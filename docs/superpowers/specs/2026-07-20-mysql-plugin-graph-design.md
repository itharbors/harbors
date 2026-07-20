# MySQL Kit 插件化与全库关系图设计

## 背景

MySQL Kit 当前只装载 `@itharbors/mysql-workbench`。该插件的 main 同时持有连接池、元数据读取、分页查询、写事务和任意 SQL 执行；单个 Panel 同时承担连接表单、对象导航、数据编辑、结构查看和 SQL 工作区。SQLite Kit 已经验证了 `core + explorer + data + schema + relationships + sql` 的多插件结构。本次改造让 MySQL 采用同样的职责边界，并新增基于真实 MySQL 外键的全库关系图。

## 目标

- 将 MySQL Kit 拆为六个可独立构建、校验和测试的插件。
- 保持连接池与全部数据库访问只有一个权威所有者。
- 使用 Kit 原生布局组合 Explorer 与四个工作区，不在 Panel 内重复实现标签系统。
- 保留现有连接、对象浏览、分页、结构查看、增删改和 SQL 执行能力及安全约束。
- 新增当前 database 的全库关系图，支持复合、自引用、循环和平行外键。
- 使用 revision 快照与广播同步连接、schema、数据和选择状态，避免依赖插件装载顺序。
- 最终删除旧 `@itharbors/mysql-workbench`，不保留双实现或兼容代理。

## 非目标

- 不新增 SQLite 独有的文件浏览、只读/读写模式、撤销、导出、SQL 风险确认、取消或查询计划能力。
- 不改变 MySQL 凭据持久化策略；密码仍只存在于连接请求中，并在连接成功后从表单状态清除。
- 不跨 database 推断或展示关系，不展示 view 节点，也不推断未声明的外键。
- 不在本次工作中抽取跨数据库 Panel 框架或共享关系图渲染包。
- 不改变现有分页大小、SQL 返回上限、可编辑对象判断或错误代码语义。

## 方案比较与决定

### 方案一：六插件完整拆分

建立 `mysql-core`、`mysql-explorer`、`mysql-data`、`mysql-schema`、`mysql-relationships`、`mysql-sql` 和共享协议包 `mysql-contracts`。它与 SQLite 的架构和布局对齐，同时只迁移 MySQL 已有产品能力并新增关系图。职责、状态和测试边界最清晰，因此采用。

### 方案二：只拆 core、workbench 与 relationships

迁移量较小，但连接、对象树、数据、结构和 SQL 仍集中在一个巨型 Panel，不能满足插件化的实际目标，因此不采用。

### 方案三：先抽取跨数据库工作台与关系图库

长期复用度较高，但会同时重构已经稳定的 SQLite Kit，扩大范围并把 MySQL 交付绑定到新的公共抽象，因此不采用。两套实现稳定后再根据真实重复点决定是否抽取。

## 插件边界

### `@itharbors/mysql-core`

无 Panel。它独占 `mysql2` pool，并提供：

- 连接：`getConnectionState`、`connect`、`disconnect`。
- 元数据：`getSchema`、`getObjectSchema`、`getRelationshipGraph`。
- 数据：`getRows`、`insertRow`、`updateRow`、`deleteRow`。
- SQL：`executeSql`。

现有 `MysqlService`、driver 与协议校验迁入 core。所有输入校验、标识符引用、事务、影响行数检查、对象可写性和 MySQL 错误标准化继续位于服务边界。嵌套 Kit 插件不是 npm workspace，因此 Kit package 继续声明 `mysql2` 以安装运行时依赖；六个插件中只有 core 声明并导入 `mysql2`、创建连接池。

### `@itharbors/mysql-explorer`

贡献 `explorer` Panel，负责连接表单、TLS 开关、连接摘要、刷新/断开、表与视图分组和当前对象选择。插件 main 持有当前选择并提供 `getSelection()` 与 `selectObject(input)`。连接或 schema 改变时，它重新读取对象列表；旧选择仍存在则保留，否则选中第一个表，再退回第一个视图或 `null`。

### `@itharbors/mysql-data`

贡献 `data` Panel，负责当前对象的数据分页、行选择和记录新增/编辑/删除。分页、对话框、草稿和选择是 Panel 本地状态。切换对象后重置页码和行选择；成功写入后等待 core 的 data broadcast 刷新。

### `@itharbors/mysql-schema`

贡献 `schema` Panel，展示字段、主键、索引、外键和 DDL，并保留安全文本渲染。它只读取当前选择和 `getObjectSchema`，不持有编辑状态。

### `@itharbors/mysql-relationships`

贡献 `relationships` Panel，读取全库关系图并提供搜索、缩放、平移、适应窗口、可见的非 SVG 关系明细和键盘操作。点击或键盘激活表节点时，它调用 Explorer 的 `selectObject`，再打开或聚焦单实例 Schema Panel。

关系图只包含当前 database 的 `BASE TABLE`。每个节点包含列名、MySQL `COLUMN_TYPE`、主键顺序与是否参与外键。每条边对应一个真实外键 constraint；复合外键的列按 `ORDINAL_POSITION` 聚合；方向从引用表指向被引用表，并包含 `ON UPDATE`、`ON DELETE`。自引用、循环和平行外键不折叠。

### `@itharbors/mysql-sql`

贡献 `sql` Panel，负责 SQL 草稿、显式执行、结果表和 mutation 摘要。草稿在对象切换时保留，在 Panel 卸载时清空。现有单语句执行和 500 行显示上限保持不变。

## 共享协议与依赖方向

新增 workspace 包 `packages/mysql-contracts/`，只包含可序列化类型、插件名、topic、revision 快照、错误 envelope 与浏览器端 response 解包函数。它不得导入 Node、DOM、`mysql2` 或插件实现。

依赖方向固定为：

```text
mysql-explorer ─┐
mysql-data ─────┤
mysql-schema ───┼── request/broadcast ──> mysql-core
mysql-relationships ┤
mysql-sql ──────┘

mysql-data/schema/relationships/sql ── request/broadcast ──> mysql-explorer selection
```

Panel 不导入其他插件实现。现有 `view-model` 和 `copy` 按使用职责移动，不能在多个插件中产生不同版本的同一行为。

## 状态、revision 与广播

Core 维护三个会话内单调递增 revision：

- `connectionRevision`：成功 connect 或实际 disconnect 后递增。
- `schemaRevision`：连接变化，或成功执行 `CREATE`、`ALTER`、`DROP`、`RENAME`、`TRUNCATE` 后递增。
- `dataRevision`：连接变化，成功 CRUD，或成功执行返回 mutation 的 SQL 后递增。

Core 广播：

- `@itharbors/mysql.connection.changed`：完整连接与 revision 快照。
- `@itharbors/mysql.schema.changed`：三个 revision。
- `@itharbors/mysql.data.changed`：三个 revision 与 `objectName`；CRUD 使用具体对象，任意 SQL 使用 `null`。

Explorer 广播 `@itharbors/mysql.selection.changed`，内容是 `connectionRevision` 与 `objectName`。

广播只用于失效通知。每个 Panel mount 时主动请求 core 连接快照和 Explorer 选择快照。异步请求提交 UI 前必须再次匹配连接、选择、revision 和本地 request sequence。失败操作不递增 revision，也不发送成功广播。

SQL 的 schema 分类只读取去除前导空白与注释后的首个关键字。无法可靠分类但返回 mutation 时，保守同时递增 schema 与 data revision，避免关系图和对象列表陈旧。

## 布局与交互

默认布局为左侧约 300px 的 Explorer，右侧原生 tab group 依次放置 Data、Schema、Relationships、SQL，Data 默认激活。所有 Panel 都是 `multiInstance: false`。功能 Panel 自带加载、空和错误状态，不访问其他 iframe 的 DOM。

关系图布局和交互对齐 SQLite，但使用 MySQL 标识与文案：节点类型显示 `TABLE`，画布 aria-label 指向 MySQL，节点激活打开 `@itharbors/mysql-schema.schema`。关系明细始终以普通 DOM 列表呈现，不能只依赖 SVG title。

## 错误处理与生命周期

- Core 把公开失败转换为 `$mysqlError` envelope，保留现有错误 code 和 message，并可携带 detail。
- Panel 通过 `unwrapMysqlResponse` 将 envelope 转为 `MysqlRequestError`；错误只影响发起请求的 Panel。
- 新连接建立失败时保留原连接；写入或 SQL 失败不广播；断开失败按服务当前真实状态发布或保留快照，不能伪造成功。
- Core unload 关闭连接池并清除 runtime；重复 unload 保持安全。
- Panel unmount 清理 DOM、listener 和本地状态，并使迟到响应失效；它不关闭共享连接。

## 迁移策略

1. 建立 `mysql-contracts` 与 `mysql-core`，迁移 driver、协议、服务和测试，并先加入关系图服务测试。
2. 建立 Explorer main 与 Panel，迁移连接和对象树。
3. 依次建立 Data、Schema、Relationships、SQL Panel，按职责迁移纯函数、样式和测试。
4. 更新 Kit manifest、布局、根构建依赖与跨插件运行时测试。
5. 所有新插件就绪后删除 `mysql-workbench`，并搜索清除旧名称。
6. 重新构建和校验六个插件，运行 MySQL Kit 与仓库级检查。

迁移提交可以暂时包含尚未装载的新插件，但最终状态不允许旧、新插件并存。

## 测试策略

### Core 与服务

- 迁移 connection、protocol、driver、schema、分页、CRUD、事务和 SQL 测试。
- 新增关系图测试，覆盖普通表过滤、列类型、复合主键、复合外键聚合、自引用和平行 constraint。
- 新增 revision/broadcast 测试，验证成功与失败路径、DDL 与 DML 分类、error envelope 和 unload。

### Panel

- Explorer：连接表单、密码清除、失败保留、对象分组、选择恢复和广播。
- Data：分页、对象切换、记录草稿、增删改、不可编辑对象和错误恢复。
- Schema：字段、索引、外键、DDL 与安全文本渲染。
- Relationships：确定性布局、循环/自引用/平行边、搜索、缩放、平移、适应窗口、关系明细和键盘打开 Schema。
- SQL：显式执行、行结果、mutation 摘要、错误后保留草稿和切换对象不清空。
- 每个 Panel 覆盖 mount 快照恢复、相关广播、迟到响应和 unmount。

### Kit 与集成

- manifest 精确声明六个插件，布局包含 Explorer 与四个功能 tab，不存在旧插件名。
- 真实 Editor 能装载六插件并清理消息路由。
- `MYSQL_TEST_URL` 存在时，真实 MySQL 测试覆盖 connect、schema、关系图、CRUD、DDL/DML revision 与 disconnect。

## 验证命令

- `node scripts/ce-plugin.mjs build kits/mysql/plugins/<plugin>` 与对应 `check`，覆盖六个插件。
- `npm run test -w @itharbors/kit-mysql`。
- `npm run check`。
- 若提供 `MYSQL_TEST_URL`，运行真实 MySQL 集成测试。
- 启动 `npm run dev -- --kit ./kits/mysql`，烟测连接、对象选择、四个工作区、CRUD、关系图跳转和 SQL。

## 完成标准

- `kits/mysql/plugins/` 下只有六个职责明确的新插件，不再存在 `mysql-workbench`。
- Kit manifest、布局、构建产物和测试全部使用新插件名。
- 只有 `mysql-core` 创建和关闭 `mysql2` pool。
- 五个 UI 插件之间不直接导入实现，跨插件协作全部使用声明的 request/broadcast。
- 全库关系图使用真实 MySQL 外键，复合、自引用、循环和平行关系均有测试证据。
- 现有 MySQL 功能与安全约束均有迁移后的测试证据。
- 六插件 build/check、MySQL Kit 测试和仓库 `npm run check` 全部通过。
