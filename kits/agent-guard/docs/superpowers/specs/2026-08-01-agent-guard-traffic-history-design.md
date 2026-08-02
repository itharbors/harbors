# Agent Guard 历史流量与模型用量设计

## 背景

Agent Guard 已经按约 60 秒窗口将 Claude 与 Codex 的网络字节、连接数和活跃任务写入本机按日
NDJSON 文件，但面板只展示当前快照。用户关闭面板后后台仍会采集；退出 ITHARBORS、停止后台或关机
则产生无法事后还原的网络采样缺口。

本功能把现有短期指标变成可查询、可解释、可管理的历史记录，同时允许从本地 Agent 会话日志回填
token、请求和会话活动。网络字节与模型用量属于不同指标域，任何来源都不得把 token 换算成字节，
也不得把未采集显示成零。

## 目标

1. 展示最近 1 小时、24 小时、7 天、30 天、90 天和 1 年的 Claude/Codex 历史趋势与总量。
2. 将网络实测、会话日志回填和数据缺口作为一等语义，显示来源、质量与覆盖率。
3. 支持按 Agent 和 Provider endpoint 筛选，不暴露完整远端 IP、凭据或会话正文。
4. 在现有存储之上增加可恢复、幂等的分层聚合，限制长期磁盘占用。
5. 提供存储占用、保留规则、回填开关和清空历史能力。
6. 关闭面板不停止采集；后台停止造成的缺口在恢复后仍可识别。

## 非目标

- 不从 token、请求数、账单金额或会话文件大小估算网络字节。
- 不承诺补回后台未运行期间的精确网络流量。
- 不保存 Prompt、回复正文、API Key、Cookie、Authorization、完整 argv 或完整环境变量。
- 第一版不调用 Provider 远端用量 API，不引入新的登录、凭据或网络权限。数据模型保留未来来源扩展点。
- 不把连接数描述成模型请求数。
- 不提供无限期原始记录或逐连接审计浏览器。
- 不改变异常检测、熔断阈值和事件记录的现有语义。

## 产品决策

### 两个独立指标域

历史页提供两个相邻但不可混算的视图：

1. **网络流量**：上行字节、下行字节和连接活动，仅来自实时网络采样。总量只对已覆盖区间求和，
   同时显示覆盖率；缺口不参与求和，也不作为零值绘制。
2. **模型用量**：输入 token、输出 token、缓存 token、请求和会话活动。第一版从 Claude/Codex 本地
   会话日志的 allowlist 字段回填；某字段不存在时显示“不支持”，不猜测或补零。

页面不得使用一个“总用量”数字混合字节与 token。来源优先级只在同一指标、同一单位、同一覆盖区间
内生效。第一版只有网络实测与本地日志来源；未来增加 Provider API 时，同单位重叠数据采用
`measured > provider-reported > local-session-derived`，被覆盖来源保留诊断计数但不重复累加。

### 默认视图

- 默认范围为最近 24 小时，默认同时展示 Claude 与 Codex，可按 Agent 和 endpoint 筛选。
- 范围预设为 1 小时、24 小时、7 天、30 天、90 天和 1 年。
- 1 小时与 24 小时使用分钟桶，7 天与 30 天使用小时桶，90 天与 1 年使用日桶。服务端可以为满足
  返回点数上限而提升粒度，但不得返回比请求更细且明显超出预算的序列。
- 摘要卡展示所选指标的总量、变化趋势、覆盖率和估算占比；网络流量的估算占比恒为 0。
- 图表用实线表示实测、点线表示回填、断线和阴影表示部分覆盖或缺失。颜色不作为唯一状态信号。
- endpoint 明细默认折叠，避免首页退化为原始日志表。

### 管理规则

- 原始分钟记录保留 7 天，小时聚合保留 90 天，每日聚合保留 365 天。
- 保留周期使用固定产品默认值，第一版不开放任意天数输入，避免产生未经预算验证的组合。
- 用户可以查看当前历史占用、最早/最新记录时间、最后聚合时间和最近回填状态。
- “清空历史”删除流量、模型用量、聚合文件与回填游标，但不删除策略、基线、异常事件或控制 ledger；
  操作必须二次确认并在后台完成。
- 本地会话回填默认开启，可关闭。关闭后不再扫描会话日志，已有聚合数据保留到自然过期或用户清空。

## 方案选择

### 选择：追加式原始 NDJSON + 不可变聚合段 + 原子清单

继续使用现有 NDJSON 作为短期事实记录，新增小时/每日不可变聚合段、回填游标和原子 manifest。查询只
通过后台 history service 读取并合并合适粒度，UI 不直接访问文件。

该方案保持现有数据兼容，不增加 native database 打包风险，并能在当前数据量下满足一年查询。聚合段
由确定性 key 生成并通过 manifest generation 发布，可以在崩溃后重试而不重复计数。

未选择的方案：

- **直接查询全部 NDJSON**：首版代码最少，但 90 天/1 年查询、去重、压缩恢复和磁盘管理会逐渐失控。
- **立即迁移 SQLite**：事务和索引能力更强，但引入迁移、运行时兼容和打包风险。若日聚合文件超过
  10,000 个、单次查询超过 200 ms 的性能预算或来源维度显著扩展，再以相同 service contract 迁移。

## 数据模型

### 覆盖语义

每个时间桶必须有独立覆盖状态：

```ts
type Coverage = 'complete' | 'partial' | 'missing';
type Provenance = 'network-sample' | 'local-session' | 'provider-reported';
type Quality = 'measured' | 'derived';
```

`complete` 表示整个桶都由连续 collector epoch 覆盖；`partial` 表示只有部分窗口有效或日容量上限导致
丢样；`missing` 表示没有有效观测。任何状态都不能仅由数值是否为零推导。完整覆盖下的零是有效零值；
`partial` 或 `missing` 下的零不代表无流量。

网络域额外写入不含 endpoint 或流量值的 collector coverage heartbeat，记录观察区间、collector epoch、
采集器/进程观察器是否可用、启用的 Agent 和缺失原因。只有 heartbeat 完整覆盖区间，且目标 Agent 在
该区间启用并完成进程观察时，没有指标记录才可以解释为有效零。后台退出、collector degraded、Agent
被禁用和达到落盘上限分别返回稳定的 coverage reason，UI 不把它们合并成“无活动”。

### 原始网络记录

现有 `PersistedMetricV1` 继续可读。新写入使用版本化记录，增加 `intervalStart`、`intervalEnd`、
`collectorEpoch` 和 `coverage`；字节仍按 `agent + provider + hostname + remoteDigest` 保存。迁移读取规则：

- `complete: true` 映射为 `coverage: complete`；
- `complete: false` 映射为 `coverage: partial`，即使 `bytesIn/bytesOut` 为零也不得当成有效零；
- v1 的区间结束时间取 `at`，开始时间由相邻同维度记录推导并限制在一个评估窗口内；无法可靠推导时
  标记为 `partial`。

### 本地会话用量记录

回填器以流式方式读取 Claude/Codex 会话文件，仅提取明确 allowlist 的时间、模型标识、token usage、
请求/消息事件标识和会话标识。解析后的记录包含：

- `agent`、可选 provider/model 摘要、事件发生时间和指标单位；
- 输入、输出、缓存 token 以及日志明确报告的请求/会话活动；
- `provenance: local-session`、`quality: derived`、解析器版本；
- 基于本机 salt 生成的稳定事件摘要，用于幂等去重。

不得持久化读取到的正文、工具输入输出、文件路径原文或未知字段。无法确认语义的 usage 字段被忽略并
计入本地诊断计数，不进入历史总量。

### 聚合记录

聚合 key 为：

```text
domain + metric + unit + agent + provider + hostnameDigest + bucketStartUtc + bucketSize
```

聚合记录保存数值、有效覆盖毫秒数、期望覆盖毫秒数、来源计数、质量、schema version 和算法版本。
同一 key 的输出由排序后的输入确定，不依赖处理顺序。网络流量只累加相互不重叠且 collector epoch
连续的有效区间；会话用量只累加未见过的稳定事件摘要。

## 存储布局与生命周期

在现有 Agent Guard 数据目录中增加：

```text
history-manifest.json
coverage-raw-YYYY-MM-DD.ndjson
usage-raw-YYYY-MM-DD.ndjson
history-hour-YYYY-MM-g<generation>.ndjson
history-day-YYYY-g<generation>.ndjson
history-cursors.json
```

`history-manifest.json` 记录当前 generation、已发布聚合段、输入高水位、算法版本、最后成功聚合和
回填时间。`history-cursors.json` 以会话文件 identity、大小、mtime 和已消费偏移记录增量回填位置；
文件截断、替换或 cursor 不一致时重新扫描，并依靠事件摘要去重。

压缩流程：

1. 读取上一个 manifest 和截至固定高水位的原始输入。
2. 生成临时不可变聚合段，校验 schema、排序、范围、计数与文件摘要。
3. `fsync` 文件后原子 rename 到 generation 唯一的正式名称。
4. 原子写入并切换新 manifest。
5. 只有新 manifest 可读且覆盖已确认后，才删除过期的旧原始文件和未引用聚合段。

崩溃发生在步骤 4 前时旧 manifest 仍有效，重启后可删除未引用临时段并重试；发生在步骤 4 后时新
generation 已成为唯一事实，不会再次累加。聚合任务使用进程内单飞锁，追加写不等待长期查询。

每日原始指标继续使用 20 MiB 上限。达到上限后记录当天 `partial` 覆盖与 dropped-record 诊断，仍保留
异常事件和已有聚合，不悄悄停止。小时/日聚合设置独立的小型总预算；超限时优先删除超过保留期的未
引用段，不删除仍在保留期内的当前 generation。

所有桶使用 UTC epoch 边界存储和聚合。UI 按用户当前时区格式化标签；跨夏令时的“本地一天”可能为
23 或 25 小时，查询总量按绝对时间范围计算，不通过固定 24 小时推导自然日。系统时钟倒退或大幅
跳变会切换 collector epoch 并产生覆盖缺口，不能生成负区间或重复区间。

## 组件边界

### History Store

扩展现有 store，负责版本化原始记录、聚合段、manifest、游标、保留和清空。它只接受已规范化的
allowlist 数据，不理解 UI 范围预设。

### Usage Backfiller

Claude/Codex 各自实现只读解析器，输出统一 usage event。扫描有文件数、单文件字节数和单轮耗时上限，
采用增量 cursor；错误文件隔离并记录诊断，不阻塞实时网络监控。

### History Aggregator

将原始网络与 usage event 分别聚合为确定性的分钟/小时/日序列，计算覆盖率并执行幂等 compaction。
它不跨单位归一化，也不参与异常规则判断。

### History Query Service

接收范围、指标域、筛选条件和期望粒度，校验最大跨度与返回点数，从 manifest 选择最细且满足预算的
已发布段，合并尚未压缩的近期原始记录，返回脱敏序列与诊断元数据。

### Panel

在现有实时“观测路由”下增加历史区域，包括范围切换、网络/模型用量切换、总量卡、趋势图、来源图例、
覆盖提示、endpoint 明细与存储管理。历史查询不加入现有 2 秒快照轮询；只在范围/筛选变化、用户刷新
或后台 generation 变化时请求，避免重复扫描。

## API 合约

Center 插件转发后台的以下方法：

```ts
getTrafficHistory(input: {
  from: number;
  to: number;
  domain: 'network' | 'model-usage';
  agents?: Array<'claude' | 'codex'>;
  hostnames?: string[];
  preferredBucket?: 'minute' | 'hour' | 'day';
}): Promise<TrafficHistoryResult>

getHistoryStatus(): Promise<HistoryStatus>
updateHistorySettings(input: { localSessionBackfill: boolean }): Promise<HistoryStatus>
clearHistory(input: { confirmation: 'clear-history' }): Promise<HistoryStatus>
```

输入采用严格对象 schema，拒绝未知字段、逆序范围、超过 366 天范围、过多筛选项和过细的超预算请求。
结果最多返回 2,000 个点；后台可以提升 bucket 粒度，并在结果中返回实际粒度。hostname 只允许从后台
已知 endpoint 集合中选择，UI 不能提交任意文件路径或日志查询表达式。

返回结果包含 `series`、`summary`、`coverage`、`sources`、`actualBucket`、`generation` 和 `warnings`。
`warnings` 使用稳定代码，例如 `partial-collector-coverage`、`raw-cap-reached`、
`backfill-parser-error`、`retention-boundary`，UI 自行本地化。

## Web 与 Desktop 行为

历史合约、聚合、回填解析器和 Panel 都是共享代码，优先通过 `npm run dev:web`、fixture 和自动化测试
开发。Web host 没有 Desktop 数据目录时使用有界内存 history store，仅保存当前开发会话并明确返回
`persistent: false`；不得写入 cwd 或 Home。

Desktop host 使用现有 `HARBORS_AGENT_GUARD_DATA_DIR` 持久化。由于数据目录、后台生命周期和重启恢复
属于 desktop-only 行为，最终验收需要针对已经存在的 ITHARBORS 进程做一次定向 Electron 检查；不得
为普通 UI 调试反复启动新的空 Electron 实例。

## 错误处理

- 单条 torn NDJSON 尾行：忽略未完成尾行并标记诊断；中间损坏行隔离，不中断其他文件查询。
- manifest 损坏：从可验证聚合段和保留期内原始文件重建；重建期间历史状态为 degraded，实时保护继续。
- 回填解析失败：按文件隔离、指数退避；不读取未知字段补偿，不阻塞网络 collector。
- 聚合超时：保留旧 generation 并稍后重试，查询继续使用旧数据加近期原始记录。
- 查询超预算：返回稳定的 validation error 或提升粒度，不读取无限文件后再截断。
- 清空中途崩溃：使用新的空 generation 原子切换；重启后清理未引用旧历史，不影响 incidents 和策略。
- 存储只读或空间不足：停止历史写入并明确显示 partial/degraded；实时内存监控和异常告警继续运行。

## 隐私与安全

- 所有持久化 schema 使用字段 allowlist，并以负向测试证明敏感字段无法序列化。
- 会话文件仅在本机读取；不上传、不调用 Provider API、不保存原始正文或未知字段。
- endpoint 显示使用 Agent 当前配置中的 hostname；远端 IP 继续只保存 salted digest。
- 会话、事件和文件 identity 使用本机 salt 摘要。UI 不展示可反查的本地路径或原始 session ID。
- 历史数据目录保持 `0700`，文件保持 `0600`；临时文件同样使用限制权限。
- 清空历史只接受固定确认 token，不能接受路径或通配符；删除目标由 store 内部固定文件类别解析。

## 性能预算

- 实时 collector 的现有 5 秒周期和 60 秒评估窗口不得因历史查询或回填延迟。
- 回填与压缩每轮采用时间预算并主动让出事件循环；同一时刻最多一个回填和一个聚合任务。
- 默认历史查询在 7 天正常数据量下目标低于 100 ms，在 1 年日聚合下目标低于 200 ms。
- 单次返回最多 2,000 点，序列化结果目标低于 2 MiB。
- 历史功能增量常驻内存目标低于 20 MiB；聚合使用流式读取，不一次加载全年原始文件。

## 测试与验收

### 单元测试

- v1 指标迁移：`complete=false + 0 bytes` 必须变成 partial，不得成为有效零。
- 只有 coverage heartbeat 完整且 Agent 已启用的无指标区间才能合成为有效零；后台停止或 Agent 禁用
  必须返回不同 coverage reason。
- UTC 桶边界、夏令时 23/25 小时、时钟倒退和跨午夜区间。
- 相同事件重复扫描、文件截断/替换和 cursor 回退不重复累计。
- 网络字节与 token 永不进入同一 series 或 summary。
- 聚合在每个发布步骤注入崩溃后，旧或新 generation 恰有一个可见且总量不变。
- torn 尾行、中间损坏行、manifest 损坏和磁盘只读的降级行为。
- 保留边界、20 MiB 原始上限、清空历史不删除 incidents/state/ledger。
- 敏感字段和未知字段无法进入 raw、aggregate、manifest 或 API 输出。
- 查询范围、筛选数量、粒度提升和 2,000 点上限。

### 集成测试

- 使用确定性 Claude/Codex 会话 fixture 回填 token/请求/会话，并验证正文不会持久化。
- 追加实时样本、聚合、重启 store、查询相同范围，结果与 coverage 完全一致。
- 原始 7 天、小时 90 天、每日 365 天的跨层查询无重叠和缺口误算。
- Panel 切换范围、域和 Agent 后只触发必要历史请求，2 秒实时轮询不重复加载历史。
- Web 内存 store 返回 `persistent: false`，不会在工作目录创建数据文件。

### 验收场景

1. 关闭 Panel、保持后台运行并产生 Agent 流量，重新打开后该区间显示为实测网络流量。
2. 停止后台后产生 Agent 活动，再启动：网络图显示缺口；模型用量可从日志回填并标为 derived。
3. 完整覆盖且无流量的区间显示为零；采集缺失区间显示断线，不显示零。
4. 达到原始写入上限后，覆盖率下降并出现明确警告，历史总量不声称完整。
5. 压缩过程中强制退出并重启，总量不重复、不丢失，实时保护始终可用。
6. 清空历史后趋势、聚合和回填游标为空，策略、异常事件与控制 ledger 保持不变。

## 交付边界

本功能作为独立 `kit-change/agent-guard/feature/traffic-history` 交付，不合并当前进程观察器 Bug 工作树的
改动。实现顺序为：合约与覆盖模型、存储/聚合、回填器、查询 service、Center 转发、Panel 与管理、
Web 验收、Desktop 定向持久化检查。Provider 远端 API、SQLite 迁移和自定义保留周期留待后续独立设计。
