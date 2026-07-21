# MySQL 服务器级连接设计

## 背景与目标

当前 MySQL Kit 把 `database` 作为连接必填项，并在连接成功后立即读取当前库结构。这阻止了“先连接服务器，再选择数据库”的标准工作流。目标是让数据库可选：留空时连接服务器并展示当前账号可访问的数据库；选择数据库后再加载表、视图和其他工作区。连接时已填写数据库的现有直达流程保持不变。

## 方案比较

1. 对连接池执行一次 `USE database`。MySQL pool 中不同连接拥有独立会话状态，不能保证后续请求使用执行过 `USE` 的连接，因此不采用。
2. 所有元数据和数据 SQL 都使用数据库全限定名。它会扩大修改范围，并使 SQL 工作区失去自然的默认数据库语义，因此不采用。
3. 服务保存当前活动连接的服务端会话配置；选择数据库时创建候选 pool，探测成功后原子替换旧 pool。它同时保证数据、结构、关系图和自由 SQL 使用同一个默认数据库，因此采用。

## Core 与协议

- `ConnectionInput.database` 改为 `string | null`；空白输入规范化为 `null`。
- `Mysql2Driver` 在数据库为 `null` 时不向驱动传递 `database` 选项。
- `MysqlService.connect()` 允许 `DATABASE()` 返回 `null`。若请求指定数据库，仍要求探测结果与请求一致。
- Core 新增 `getDatabases()`，从 `information_schema.SCHEMATA` 返回当前账号可访问的数据库，按名称排序。
- Core 新增 `selectDatabase({ database })`。它使用当前活动连接配置创建候选 pool；候选探测成功才替换旧 pool，失败则关闭候选并保留旧连接。
- 成功切换数据库视为连接上下文变化，递增 connection/schema/data revision 并广播完整连接快照。

活动连接配置（包括密码）只存在于当前服务端进程内存，用于重建候选 pool；它不进入连接快照、广播、日志或浏览器状态，并在 disconnect/dispose 时清除。

## Explorer 与交互

`ObjectsSnapshot` 增加 `database: string | null` 与 `databases: string[]`。Explorer 在连接变化后先读取数据库列表：

- 未选择数据库时，只发布数据库列表，objects 与 object selection 为空，不调用 `getSchema()`。
- 已选择数据库时，同时读取数据库列表与当前库 schema，继续使用现有首表选择规则。
- 数据库按钮调用 Explorer 的 `selectDatabase`；Core 广播新连接快照后，Explorer 重新读取数据库和对象。
- 数据库切换期间旧列表保持可见；失败时展示错误，旧数据库和旧连接继续有效。

左侧对象栏在表/视图上方增加“数据库”分组。当前数据库使用既有选中样式；未选择数据库时搜索框禁用并提示“选择数据库后查看表和视图”。顶部连接字段改为“数据库（可选）”，连接状态在服务器级连接时显示“未选择数据库”。

## 错误与并发

- 无连接时选择数据库返回 `NOT_CONNECTED`；空数据库名返回 `INVALID_INPUT`。
- 不存在数据库继续映射为 `DATABASE_NOT_FOUND`，权限错误继续映射为 `PERMISSION_DENIED`。
- 迟到的数据库列表、schema 或数据库选择响应必须通过 revision 与本地 sequence 校验，不能覆盖更新连接。
- 重复选择当前数据库不重建 pool、不递增 revision。

## 验证

- 协议、driver、service、core revision、Explorer main 与两个 Panel 均先补失败测试。
- 使用真实 `115.29.41.139` 连接且数据库留空，确认左侧出现可访问数据库；选择数据库后加载对象。
- 运行 MySQL Kit 测试、插件 build/check 与仓库 `npm run check`。
