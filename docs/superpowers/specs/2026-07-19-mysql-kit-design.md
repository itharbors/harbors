# MySQL Kit 设计

## 目标

新增一个独立的 MySQL Kit，让用户可以连接一个 MySQL 数据库，浏览表和视图，分页预览数据，查看对象结构，并对普通表新增记录、对具有主键的普通表修改和删除记录。Kit 同时提供单语句 SQL 控制台，用于执行查询、DDL 和 DML。

首版聚焦单个连接、单个默认数据库的桌面工作流。连接密码仅保存在当前 Server 进程内，不写入浏览器存储、配置文件或日志。

## 方案选择

采用独立 `kits/mysql` 与独立 MySQL 插件，不把现有 SQLite Kit 改造成多数据库平台。MySQL 与 SQLite 的连接模型、元数据、类型系统、SQL 方言和行标识规则差异较大，独立实现可以隔离驱动依赖和回归风险。

两个 Kit 保持相似的工作流和 request 边界，但首版不提前抽取共享工作台包。MySQL 实现稳定后，再依据真实重复代码抽取值格式化、分页器、结果表格或记录对话框等通用组件。

## 用户工作流

1. 用户输入 host、port、user、password 和 database；需要加密连接时启用 TLS。
2. 用户点击连接后，Server 验证连接参数、建立候选连接池并查询服务端版本和当前数据库。
3. 连接成功后，左侧导航展示当前数据库中的表和视图。
4. 选择对象后，数据页分页加载记录；普通表均可新增记录，有主键时还可修改和删除，视图始终只读。
5. 结构页展示字段、主键、索引、外键和 `SHOW CREATE` 结果。
6. SQL 页执行用户主动提交的单条语句，展示结果集、影响行数、插入 ID、警告数和执行耗时。
7. 用户切换连接或 Kit 卸载时，旧连接池被关闭。

## 目录与运行边界

创建 `kits/mysql`，包名为 `@itharbors/kit-mysql`，包含标准 `package.json`、`layout.json`、`main.html` 和 `secondary.html`。Kit 内包含一个 `@itharbors/mysql-workbench` 插件。

插件分为三个清晰边界：

- `main/src/protocol.ts`：定义传输类型、输入校验、标识符引用、分页规则和值序列化。
- `main/src/mysql-service.ts`：使用 `mysql2/promise` 管理连接池，读取元数据，生成 CRUD SQL，执行事务并归一化错误。
- `panel.workbench/src`：渲染连接表单、对象导航、数据/结构/SQL 页签、记录表单和确认对话框，只通过插件 request 调用 Server。

Panel 不直接接触数据库驱动。除用户输入连接表单外，Server 返回的连接状态不包含 password，也不会把完整连接配置广播给其他插件。

## 连接模型

连接输入包含：

- `host`：非空字符串，默认 `127.0.0.1`；
- `port`：1 到 65535 的整数，默认 3306；
- `user`：非空字符串；
- `password`：字符串，可以为空；
- `database`：非空字符串，首版一次只管理一个数据库；
- `tls`：布尔值，默认关闭。启用后使用系统信任链并校验证书，不提供忽略证书错误选项。

连接池使用较小的连接上限，默认 4 个连接，并设置 10 秒连接超时。驱动配置关闭 `multipleStatements`，启用大整数安全返回，并让日期、时间及 DECIMAL 保持字符串形式，避免 JavaScript 隐式精度或时区转换。

切换连接采用两阶段过程：先建立候选连接池并执行 `SELECT VERSION(), DATABASE()`，成功后替换当前连接池并关闭旧池；失败时关闭候选池并保留旧连接。`disconnect()` 和插件卸载关闭连接池且必须幂等。

## 插件接口

插件 main 暴露以下 request：

- `getConnectionState()`：返回是否连接、脱敏后的 endpoint、database 和 MySQL 版本。
- `connect(input)`：校验参数并连接数据库。
- `disconnect()`：关闭当前连接。
- `getSchema()`：返回当前数据库中的表和视图摘要。
- `getObjectSchema(input)`：返回字段、主键、索引、外键和定义 SQL。
- `getRows(input)`：分页返回对象数据和稳定行标识。
- `insertRow(input)`：向普通表插入一条记录。
- `updateRow(input)`：根据原始主键修改一条记录。
- `deleteRow(input)`：根据原始主键删除一条记录。
- `executeSql(input)`：执行单条用户 SQL 并返回结果集或变更摘要。

所有输入在 main 边界完整校验。数据库、表和列名先与当前元数据匹配，再使用反引号引用并把内部反引号双写。记录值始终通过 `?` 占位符参数绑定，绝不拼接到自动生成的 SQL 中。

## 元数据与结构浏览

`getSchema()` 从 `information_schema.TABLES` 读取当前数据库中的 `BASE TABLE` 和 `VIEW`，按名称排序。对象摘要不在首屏逐表执行 `COUNT(*)`，避免大型数据库连接后产生高成本扫描。

`getObjectSchema()` 使用以下来源：

- `information_schema.COLUMNS`：字段顺序、类型、可空性、默认值、额外属性、生成表达式；
- `information_schema.STATISTICS`：主键和普通索引、唯一性、列顺序、前缀长度；
- `information_schema.KEY_COLUMN_USAGE` 与 `REFERENTIAL_CONSTRAINTS`：外键列、目标表和更新/删除规则；
- `SHOW CREATE TABLE` 或 `SHOW CREATE VIEW`：对象定义 SQL。

元数据查询必须同时限定 `TABLE_SCHEMA = 当前 database`，避免同名对象跨数据库混淆。视图始终标记为只读。

## 数据读取与行标识

分页默认每页 100 行，可选 25、50、100 或 250，上限固定为 250。总数通过独立 `COUNT(*)` 获得。首版不提供筛选器或可视化排序构造器，复杂读取使用 SQL 控制台。

稳定行标识仅使用主键：

1. 单列主键保存该列的原始值；
2. 复合主键按主键顺序保存所有原始值；
3. 普通表没有主键时仍可预览和新增，但修改、删除禁用；
4. 视图只允许预览。

更新和删除的 `WHERE` 条件使用读取记录时保存的原始主键，而不是编辑后的值。操作在独立事务中执行，必须检查 `affectedRows === 1`；为 0 时提示记录已变化或不存在，大于 1 时回滚并返回安全错误。

有主键的表默认按全部主键列升序读取，使连续翻页在无并发写入时保持稳定。无主键表和视图不隐式添加排序，只保证页面大小，不承诺跨页稳定顺序；自定义排序由 SQL 控制台或后续排序功能解决。

## 类型与序列化

驱动值转换为明确的 JSON 可传输形式：

- `NULL`、普通字符串、布尔值和安全范围内的有限数字保持原值；
- `BIGINT`、无符号大整数和 `DECIMAL` 使用带 MySQL 类型标签的十进制字符串；
- `DATE`、`TIME`、`DATETIME` 和 `TIMESTAMP` 使用带类型标签的原始字符串，不在 Server 中转换时区；
- `BINARY`、`VARBINARY`、`BLOB` 及其变体返回 `{ type: "blob", size, previewHex }` 摘要；
- JSON 值以带 `json` 标签的原始文本返回，由 Panel 格式化展示；
- 驱动返回的其他值若无法安全序列化，返回稳定的 `UNSUPPORTED_VALUE` 错误，不进行有损隐式转换。

编辑表单提交显式类型和值，区分空字符串、NULL、数字和日期文本。生成列不可编辑；自增列在新增时默认省略；二进制列首版只读，不提供上传或修改。

## CRUD 语义

新增表单基于字段元数据生成。用户可以省略具有默认值、允许 NULL、自动递增或生成的字段。插入 SQL 只包含用户实际提交的字段；完全使用默认值时生成 `INSERT INTO ... () VALUES ()`。

编辑只提交发生变化且可写的字段。若没有变化，Panel 不发请求。修改主键是允许的，但定位条件仍使用加载时的原始主键。删除必须显示对象名和主键摘要并二次确认。

CRUD 通过从连接池获取的专用连接执行 `BEGIN`、语句、结果校验、`COMMIT`；任何异常都执行 `ROLLBACK` 并释放连接。数据库权限由 MySQL 账号控制，Kit 不尝试绕过权限或自动提升权限。

## SQL 控制台

SQL 控制台仅在用户点击执行或使用明确快捷键时运行。驱动保持 `multipleStatements: false`，首版一次执行一条语句，不实现客户端 SQL 拆分器。

返回结果集时展示字段名、最多 500 行、是否截断和耗时；非结果语句展示 `affectedRows`、`insertId`、`warningStatus` 和耗时。SQL 控制台具备当前账号的完整数据库权限，因此界面明确标记为直接执行，不替用户自动提交、重写或重试 SQL。

首版不提供查询历史、自动补全、参数面板、取消查询或长查询后台任务。

## 界面设计

Kit 使用一个占满主窗口的 workbench panel，视觉语言沿用 SQLite Workbench，但保持独立源码：

- 顶部连接区域：host、port、user、password、database、TLS、连接/断开和刷新；
- 左侧对象导航：表和视图分组，带搜索过滤但不触发远程查询；
- 右侧工作区：数据、结构、SQL 三个页签；
- 底部状态区：endpoint、对象、分页范围、耗时、影响行数和最近错误。

窄窗口下连接表单换行，导航缩为顶部对象选择器，数据表保持横向滚动。密码输入不会回显，错误发生后保留用户输入；连接成功后 Panel 清空本地 password 字段。

## 安全与错误处理

连接状态、错误对象和日志不包含密码。认证错误只返回 MySQL 错误码和经过清理的消息，不回显完整连接字符串。TLS 开启时不允许跳过证书校验。

服务层把驱动错误归一化为稳定错误码，至少包括：

- `NOT_CONNECTED`、`INVALID_INPUT`、`INVALID_OBJECT`、`READ_ONLY_OBJECT`；
- `AUTH_FAILED`、`HOST_UNREACHABLE`、`CONNECTION_TIMEOUT`、`TLS_FAILED`；
- `DATABASE_NOT_FOUND`、`PERMISSION_DENIED`；
- `CONSTRAINT_FAILED`、`DEADLOCK`、`LOCK_TIMEOUT`；
- `STALE_ROW`、`SQL_SYNTAX_ERROR`、`UNSUPPORTED_VALUE`、`MYSQL_ERROR`。

Panel 保留当前输入并在状态区展示可读错误。自动 CRUD 遇到死锁不自动重试，避免用户操作被隐式重复；用户可明确再次提交。

## 测试与验收

协议与服务单元测试使用可注入的驱动边界，至少覆盖：

- 连接参数校验、密码脱敏、候选连接失败时保留旧连接；
- 表/视图、字段、主键、索引、外键和定义 SQL 归一化；
- 分页输入、标识符引用以及主键/复合主键行标识；
- NULL、大整数、DECIMAL、日期时间、JSON 和二进制值序列化；
- 新增、修改、删除 SQL 与参数、事务提交/回滚、陈旧记录检测；
- 无主键表禁用修改删除、视图完全只读的限制；
- 查询、DDL、DML、结果截断和错误码映射；
- 断开和插件卸载幂等。

Panel DOM 测试至少覆盖：

- 未连接、连接中、连接成功、空数据库和错误状态；
- 密码不回显、失败后保留输入、成功后清空密码；
- 对象选择、搜索、页签、分页和刷新；
- 类型化新增/编辑表单、NULL、默认值和生成列；
- 无主键表/视图禁用修改删除，以及删除确认；
- SQL 结果、变更摘要和窄窗口结构。

真实 MySQL 集成测试使用隔离测试数据库，覆盖连接、结构读取、分页、复合主键、外键约束，以及一轮新增、修改和删除。默认项目测试不依赖常驻 MySQL；集成测试通过明确的测试连接环境变量运行。最终验收必须实际运行该集成测试，并用 `npm run dev -- --kit ./kits/mysql` 在浏览器完成连接、结构预览、数据预览和 CRUD 冒烟测试。

## 非目标

首版不包含连接配置或密码持久化、多连接标签页、跨数据库浏览、SSH 隧道、自定义 CA 文件、忽略 TLS 证书错误、可视化建表、迁移管理、导入导出、查询历史、SQL 自动补全、结果导出、BLOB 编辑和长查询取消。
