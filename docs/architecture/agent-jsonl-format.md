# Agent JSONL v1 格式与持久化架构

本文定义 Agent Plugin 会话日志的 canonical JSONL v1。它是磁盘格式和持久化顺序的
正式协议；Chat 只消费 Agent 的 request/broadcast 契约，不直接解析此文件。

本文中的“会话”指一个 `conversation_id` 对应的单个 `.jsonl` 文件。JSONL 是唯一事实
来源（source of truth）：内存快照、Transcript、分页结果和未来的索引都必须能够从它
重建。本文不把尚未实现的数据库索引、物理压缩或分段文件描述为当前能力。

## 1. 设计目标与不变量

v1 解决旧日志只有 `version: 0` 头部、事件字段不稳定、事件顺序与持久化边界不清楚的
问题，同时保持 Agent/Chat 的现有可见契约。

每个 v1 文件满足以下不变量：

- 文件使用 UTF-8；每一行都是一个完整 JSON object，并以一个 `\n` 结束。对象内部不
  跨行。
- 第一条记录必须是 `type` 为 `session_meta` 的 v1 记录，其
  `payload.schema_version` 固定为 `1`。
- `ordinal` 是写入器在单个会话内分配的物理顺序，从 `0` 开始，连续、单调递增且不重用。
  `ordinal = 0` 只属于 `session_meta`，不进入对外 trace；每条 canonical 事件记录的
  API `seq` 为 `ordinal - 1`。它们都不与模型流的 `sequence` 混用。
- 会话文件名中的 ID 必须与 header/session_meta 中的 `conversation_id` 完全一致；不一致
  的文件不得被读取、列出或写入。
- codec 定义的 envelope 和 payload 结构字段使用 `snake_case`。`data`、`snapshot`、
  `delta` 等由用户、模型或工具产生的 opaque 对象必须原样保存，包括其内部 key 的
  大小写和嵌套结构；枚举值和原 AgentTraceEvent discriminator 也不因投影到 API 而改名。
- 顶层 envelope 只有统一的时间、顺序、record discriminator、payload 和可选元数据。
  业务关联 ID 放在 payload，不借助隐式的上一条记录或新增的 parent 链表达因果。
- `response_item` 的 completed snapshot 是该 item 的权威状态。实时 delta 只是增量
  观察，重建 Transcript 时不能把缺失或重复的 delta 当成最终内容。
- 写入成功前不能更新持久化快照，也不能发送 trace 广播；写入失败不能制造提前的
  成功内容。

## 2. Canonical envelope

### 2.1 顶层结构

v1 每条记录的逻辑结构如下：

| 字段 | 类型 | 必需 | 含义 |
| --- | --- | --- | --- |
| `timestamp` | string | 是 | UTC 的 RFC 3339 时间，使用毫秒精度，例如 `2026-08-23T10:00:00.000Z`。用于显示和延迟分析，不用于排序。 |
| `ordinal` | integer | 是 | 本会话文件内的连续写入序号，从 `0` 开始。 |
| `type` | string | 是 | record tagged union 的 discriminator。当前值为 `session_meta`、`turn_context`、`response_item`、`event_msg` 或 `compacted`。 |
| `payload` | object | 是 | 与 `type` 对应的 payload tagged union。codec 结构字段和原事件的无损内容在这里。 |
| `metadata` | object | 否 | 不决定 Transcript 语义的附加信息，例如实现诊断标记。未知 metadata 可被读取器忽略。 |

规范化写入器固定字段顺序为 `timestamp`、`ordinal`、`type`、`payload`、`metadata`（省略
时不输出 `metadata`）。读取器按字段名而不是 JSON key 的物理顺序解析。写入前先把
整条对象序列化为一行，再追加换行；不得把一个对象拆成多次可见写入。

### 2.2 Record 与 payload tagged union

顶层 `type` 先决定 payload 的大类；非 `session_meta` payload 用 payload 内的 `type`
保存原 `AgentTraceEvent.type`，并用 `data` 保存原 `AgentTraceEvent.data`。`payload.type`
只要求是非空字符串并原样保留，不是事件类型闭集；读取器按 record 类别验证其余结构
字段，不把任意的 `data` 对象误认为成功事件。payload 中的 `conversation_id`、`turn_id`、
`item_id`、`request_id`、`item_kind`、`phase`、`surface_op` 和 `source_event_seqs` 是
codec 的结构字段副本；它们便于校验与索引，而 `data` 仍是无损 opaque 值。

| record `type` | payload discriminator / 形状 | 作用 |
| --- | --- | --- |
| `session_meta` | 固定 payload，`schema_version: 1` | 文件头、会话身份、创建时间和可恢复的初始设置。只能出现在 ordinal `0`，不投影为 AgentTraceEvent。 |
| `turn_context` | payload `type` 保留原 AgentTraceEvent.type，通常为 `turn/start`、`turn/end` 或 `request/context` | 一次 turn 的模型、沙盒、审批、请求边界和终态上下文。 |
| `response_item` | payload `type` 保留原 AgentTraceEvent.type；`item_id` 必需；`item_kind` 保留 `message`、`reasoning`、`tool-call`、`tool-result` 或 `approval`，`phase` 为 `started`、`delta` 或 `completed` | Item 生命周期和快照。`item/completed` 必须带最终 snapshot；data 内的 item、snapshot、delta 原样保留。 |
| `compacted` | payload `type` 保留原 AgentTraceEvent.type（通常以 `compaction/` 开头） | 表示上下文逻辑折叠；它保留原事件的 seq 引用，不删除旧记录。 |
| `event_msg` | payload `type` 保留其余原 AgentTraceEvent.type | 不适合归入上述类别的控制、请求、审批和业务事件；`user/message`、`tool/call`、`tool/result`、`approval/asked`、`approval/resolved` 等即使 opaque `data.item` 存在也仍是 `event_msg`。 |

因此分类映射是固定的：

```text
显式 `item/started|item/delta|item/completed` -> response_item
turn/start|turn/end|request/context -> turn_context
compaction/* -> compacted
其余 AgentTraceEvent.type（包括 `user/message`、`tool/call`、`tool/result`、`approval/asked`、`approval/resolved`） -> event_msg
```

除 `session_meta` 外，每个 payload 都保留原 `AgentTraceEvent.type`（写入 payload
`type`）、原 `data`、原 `surfaceOp`（写入 `surface_op`）和原 `sourceEventSeqs`
（写入 `source_event_seqs`）。canonical record 只是分类和编码，不发明不可逆的新业务
事件名。

record discriminator 是闭集；payload `type` 是原事件类型的开放字符串，不因新增事件
类型而要求更新闭集。`response_item` 仍校验 `item_kind` 和 `phase` 等结构字段；未知
record discriminator 不能被投影为成功 Transcript，不能复用一个旧 record discriminator
改变其字段含义。

record 分类只看显式的 AgentTraceEvent lifecycle verb；不能因为 opaque `data.item` 存在
就把业务 verb 复制或提升为 `response_item`。

### 2.3 最小有效示例

下面是一个完整的、可逐行解析的 v1 片段。每个代码行都是独立 JSON object；代码块中
没有 JSON 注释或拼接语法。

```jsonl
{"timestamp":"2026-08-23T10:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000000","created_at":"2026-08-23T10:00:00.000Z","sandbox_mode":"workspace-write","approval_policy":"ask"}}
{"timestamp":"2026-08-23T10:00:01.000Z","ordinal":1,"type":"turn_context","payload":{"type":"turn/start","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1","model":"test-model","sandboxMode":"workspace-write","approvalPolicy":"ask"}}}
{"timestamp":"2026-08-23T10:00:01.010Z","ordinal":2,"type":"turn_context","payload":{"type":"request/context","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","request_id":"request-1","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1","requestId":"request-1","provider":"model-service","generation":"generation-1"}}}
{"timestamp":"2026-08-23T10:00:01.020Z","ordinal":3,"type":"response_item","payload":{"type":"item/started","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","item_id":"item-1","request_id":"request-1","item_kind":"message","phase":"started","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1","itemId":"item-1","requestId":"request-1","item":{"kind":"message","itemId":"item-1","phase":"started","snapshot":{"role":"assistant","content":""}}},"surface_op":"append"}}
{"timestamp":"2026-08-23T10:00:01.030Z","ordinal":4,"type":"response_item","payload":{"type":"item/delta","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","item_id":"item-1","request_id":"request-1","item_kind":"message","phase":"delta","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1","itemId":"item-1","requestId":"request-1","item":{"kind":"message","itemId":"item-1","phase":"delta","delta":{"content":"你好","requestId":"request-1","generation":"generation-1","sequence":0}}}}}
{"timestamp":"2026-08-23T10:00:01.040Z","ordinal":5,"type":"response_item","payload":{"type":"item/completed","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","item_id":"item-1","request_id":"request-1","item_kind":"message","phase":"completed","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1","itemId":"item-1","requestId":"request-1","item":{"kind":"message","itemId":"item-1","phase":"completed","snapshot":{"role":"assistant","content":"你好"}}}}}
{"timestamp":"2026-08-23T10:00:01.050Z","ordinal":6,"type":"turn_context","payload":{"type":"turn/end","conversation_id":"00000000-0000-4000-8000-000000000000","turn_id":"turn-1","data":{"turn":1,"conversationId":"00000000-0000-4000-8000-000000000000","turnId":"turn-1","reason":{"kind":"completed"}}}}
```

示例中的 `sequence` 是请求流的模型 delta 序号；它只在 delta 所属请求内使用，不能
替代 `ordinal`。示例中 ordinal `1` 的事件对外是 `seq = 0`；ordinal `0` 的
`session_meta` 没有对应的 AgentTraceEvent。`request_id`、`turn_id` 和 `item_id` 同时
以 codec 结构字段和原 `data` 内的关联键保留。

## 3. 关联 ID 与生命周期

v1 继续使用 Agent Turn 事件协议规定的四类 ID，不新增 parent 链：

| ID | 所属范围 | 约束 |
| --- | --- | --- |
| `conversation_id` | 整个会话文件 | 必须与文件名及 `session_meta` 一致。它把不同 turn 和重启后的历史归到同一 Transcript。 |
| `turn_id` | 一次 Agent 执行 | turn 级事件和 item 事件必须使用同一值。旧日志没有该值时，读取器按 turn 推导 `legacy-turn-<n>`，不修改旧事实。 |
| `item_id` | 一个 turn 内的 message、reasoning、tool call、tool result 或 approval | 同一 item 的 started、零个或多个 delta、completed 必须保持不变。不同 item 不能复用。 |
| `request_id` | 一次定向请求及其响应 | Model Service 请求、审批请求及关联错误必须回显同一值。它不是 turn 或 item 的替代品。 |

Item 生命周期的合法局部形式为（payload `type` 保留括号内的原 AgentTraceEvent.type）：

```text
response_item(item/completed)
response_item(item/started) -> response_item(item/delta)* -> response_item(item/completed)
response_item(item/started) -> response_item(item/delta)*  [允许在文件 EOF 结束]
```

每条 `response_item` 都必须带 `item_id`；同一 item 的 `conversation_id`、`turn_id`、
`request_id`、`item_kind` 等关联在局部生命周期内保持稳定，不得跨 turn 复用。除上述
singleton completed 和文件 EOF 未完成的 started -> delta* 外，缺少 started、completed
或 item 关联不一致、未知 `item.kind`/phase、回退的 delta `sequence` 都是格式错误。
`completed` 必须带最终 snapshot；EOF 未完成的 started item 不能被当作 completed。Chat
可用 delta 更新实时预览，但从历史重建时只使用 completed snapshot；tool result 的错误也
必须存在于 completed snapshot，不能只依赖一条临时状态广播。

审批的 `item_id` 与 `request_id` 都不可省略。审批结果的允许值为
`allowed-once`、`rejected`、`cancelled`、`unavailable` 和 `timed_out`；重复响应按
同一 request 的终态做幂等处理。Turn 的终态为 `completed`、`failed`、`cancelled`、
`rejected` 或 `timed_out`，并通过 `reason.kind` 表达。

## 4. 磁盘 snake_case 与 Agent API 投影

磁盘协议不要求 Chat 改用新字段。v1 读取器先解码 canonical record，再投影为既有的
`AgentTraceEvent`；legacy v0 读取器则先将旧事件投影为 `AgentTraceEvent`，再沿用既有的
legacy normalize（包括 turn 关联、seq 和 surface 引用修复）。投影规则如下：

| canonical 磁盘值 | 现有 Agent API 值 | 说明 |
| --- | --- | --- |
| `timestamp` | `time` | RFC 3339 时间解析为现有 API 使用的 Unix 毫秒数。 |
| `ordinal >= 1` | `seq = ordinal - 1` | `session_meta` ordinal `0` 不投影；其后的 seq 从 `0` 开始，不另设第二个计数器。 |
| `payload.type`（payload discriminator） | `type` | 原 AgentTraceEvent.type 原样恢复，例如 `turn/start`、`item/delta`，不改成不可逆的新事件名。 |
| `payload.data` | `data` | 原 AgentTraceEvent.data 原样恢复；不递归 snake/camel 转换 opaque data、snapshot 或 delta。 |
| `payload.conversation_id` / `turn_id` / `item_id` / `request_id` | `conversationId` / `turnId` / `itemId` / `requestId` | 关联键投影到 API 事件顶层；data 中原有的 camelCase 副本同时保持不变。 |
| `payload.item_kind` / `payload.phase` | `itemKind` / `itemPhase` | 便于旧 Chat 消费者快速筛选；data 内原有 item、completed snapshot 仍保持不变。 |
| `payload.surface_op` / `source_event_seqs` | `surfaceOp` / `sourceEventSeqs` | 恢复原 AgentTraceEvent 的 surface 操作和来源引用，不改变范围或顺序。 |
| `metadata` | 不参与 Transcript | 只有已有 API 扩展明确声明时才投影；不能把 metadata 误当业务事件。 |

对外事件名、request 名称和 broadcast topic 仍以 Agent/Chat 契约为准，例如
`agent.conversation.trace.append`、`agent.message.delta`、`agent.message.status`。
API 投影不会要求 Chat 识别 `session_meta` 或理解文件布局；Chat 通过 trace 的关联键、
`seq` 和 item 终态重建历史。`session_meta` 的设置只进入会话初始化状态，不作为一条
可见 trace 事件广播。

投影 `response_item` 时，读取器必须从 canonical item 字段重建 `data.item`：使用
`item_id`、`item_kind`、`phase`，并在存在时带上 canonical `snapshot` 或 `delta`；其余
opaque `data` 字段仍原样保留。canonical item 字段是重建 descriptor 的依据，不能只依赖
`payload.data.item` 是否存在。

## 5. Writer、队列、文件锁与持久化 barrier

### 5.1 串行化范围

同一会话在一个 Agent 实例内使用独立 writer queue；队列保证 append 请求按入队顺序
串行执行。不同会话使用不同队列，仍可并行。跨进程或跨实例追加时，在该会话文件上
取得排他的 lock；lock 文件本身也必须是普通文件，过期 lock 可按既有回收规则处理。

进入 lock 后，writer 必须重新检查 tombstone、真实文件类型、文件尺寸/修改时间和磁盘
尾部；如果另一实例已经追加，先把内存快照 reconcile 到磁盘事实，再分配下一个
ordinal。任何写入都不能依赖一个过期的 `events.length`。

### 5.2 一次 append 的固定顺序

一次记录从业务调用到广播的顺序是：

1. 记录进入该 `conversation_id` 的 per-session writer queue，等待前序写入完成。
2. writer 取得会话文件 lock，检查删除 tombstone、symlink/非普通文件和外部追加。
3. writer 在仍持有该 queue 和文件 lock 时，重新 reconcile、生成完整 payload 和四类
   关联键，分配 ordinal，并冻结完整 envelope；后续重试不能改 payload 或 ordinal。
   新会话的 `session_meta` 固定为 `0`。
4. writer 序列化已冻结的 envelope，直接追加一行及一个 `\n`。当前 append 是同步写入
   操作，没有独立的后台 writer 或 flush API。
5. header、legacy migration、`turn/end`、`approval/resolved` 等需要耐久保证的路径在
   这次写操作中执行 sync barrier（文件 `sync`/等价系统调用）；sync 失败不产生成功广播。
   普通 append 在写入完成后返回，不另有后台 flush 阶段。
6. 只有 append（以及要求 barrier 的记录的 sync）成功后，才更新内存 events、surface
   fold、会话 settings 和分页 cursor。
7. 在仍持有文件 lock 时调用 `traceEventListener`，且等待该回调结束；该回调通常触发
   `agent.conversation.trace.append`。监听器异常只记录诊断，不回滚已落盘记录，也不能
   阻断其他监听器。
8. 回调结束后释放文件 lock，再由调用方发送对应的实时 delta/status。

因此可观察顺序是“落盘 → 内存折叠 → trace 广播 → 其他可见广播”。在第 5 步以前失败
时，Chat 看不到该事件；第 6 或第 7 步失败时，同样不得广播。若底层只写入了一条不完
整的尾行，下一次在 lock 内读取时按尾部修复规则截断，再使用同一个已冻结的 ordinal
和记录重试；若完整的同 ordinal 行已经存在，则重试只确认并按需再次 sync，不得再追加一
份。不能因为重试而产生两个业务事件。

### 5.3 哪些操作必须经过 sync barrier

普通实时 delta 在同步 append 写入完成后即可发送；以下当前路径会在同一次写操作中
等待 sync barrier 后才标记完成并广播：

- 新建会话的 header/session_meta；
- legacy migration（以及受控修复写回）；
- `approval/resolved`，包括任何审批终态；
- `turn_context` 的 `turn/end` 及其失败、取消、拒绝、超时原因。

当前没有独立的 flush 请求、持久后台 writer 或异步 shutdown 生命周期；`AgentAdapter.stop`
仍是同步接口，也不负责排空 writer queue。后台 flush、显式 flush API 和 async shutdown
属于未来边界/非本 Task 目标。任一当前 append 或 sync 阶段失败都不得广播成功内容。

## 6. 读取、兼容与错误恢复

### 6.1 legacy v0 双读单写

读取器按首个非空记录识别格式：

- v1 必须以 `session_meta` 和 `payload.schema_version = 1` 开始；
- legacy v0 以旧的 `type: "session"`、`version: 0` header 开始，后续是旧的
  `type/seq/time/data` 事件。

v1 记录先解码为 canonical 内部 record，再投影为 `AgentTraceEvent`；legacy v0 行则先
投影为 `AgentTraceEvent`，再执行既有 normalize。legacy 读取时保留已有可见事件；缺少
`turn_id` 的 turn 只推导稳定的 `legacy-turn-<n>`，不改变原始业务内容。

这是“双读、单写”：新建会话只写 v1，writer 不为同一事件长期同时写 v0 和 v1 两份。
普通读取 legacy 文件不会隐式重写它，也不会扫描旧目录。legacy 会话若要继续写入，必须
经过显式、受控的一次性升级边界：在会话 lock 内读取并验证完整旧文件，将其规范化为
v1，在同目录临时文件中完整写入并执行 file sync，随后以同目录 atomic rename 替换为
单一 v1 文件，再追加新记录；升级失败保留旧文件且不广播。当前没有父目录 fsync，因而
只保证文件内容不会混合或处于半迁移状态，不宣称断电后目录项绝对持久。实现不得把
v0 header 与 v1 header 混在一个长期格式中。

### 6.2 尾部损坏

读取器按物理行扫描，并记录最后一个完整、以 `\n` 结束且成功解析的记录。若仅最后一
个非空物理行没有结束换行且 JSON 不完整，视为进程中断造成的尾损坏；在持有 lock 时
截断到最后一个完整换行，再从该边界继续。尾部修复只允许移除无法构成完整记录的字节，
不得删除一个已经完整落盘的 JSON object。

尾部行即使位于文件末尾，只要它以换行结束却无法解析，也不是可安全猜测的中断行，而
是损坏文件，应返回错误。修复动作必须更新文件 stat，并让内存快照重新从修复后的 JSONL
构建。

### 6.3 中间损坏、未知 schema 和未知 record

- 任意中间行损坏、非法 UTF-8、重复/倒退/跳跃的 v1 ordinal、错误的首行或 payload
  discriminator，都 fail closed。读取、列表和分页返回稳定错误；一个损坏会话不能被
  静默过滤成“没有会话”。
- `schema_version` 不是 `1` 时拒绝按 v1 解释。未来版本不能被旧读取器降级为成功内容。
- 文件名 ID 与 header/session_meta 的 `conversation_id` 不一致，或 response item 缺少
  `item_id`、生命周期/关联不合法、completed 缺少 snapshot，必须 fail closed。
- `source_event_seqs` 和 `surface_op` 只能引用当前记录之前已经存在的 API `seq`；同一
  当前记录或未来 seq 的引用必须拒绝。
- 未知 record discriminator 不得投影为成功 Transcript。`payload.type` 是开放字符串，
  只要满足非空及该 record 类别的其余结构校验即可保留；读取器可以在诊断结果中报告
  ordinal 和 discriminator，只有显式声明为不影响语义的 metadata 才可忽略。
- legacy 的既有 seq 修复只能发生在 legacy 规范化路径，且必须保留物理事件、修正其
  引用关系并记录为修复；v1 不允许静默重编号。

## 7. Transcript、compaction 与 source of truth

JSONL 的所有记录都是事实；`surface` 只是从这些记录折叠出的模型可见视图。普通
`response_item`、`event_msg` 和 `turn_context` 记录按 ordinal 回放。带有逻辑替换的
事件通过结构字段 `source_event_seqs` 保留原 AgentTraceEvent 的 seq 引用，而不是修改或
物理删除旧行。该字段和 `surface_op` 的范围使用对外 seq 域；回放 canonical 文件时，
读取器将它们映射到物理 ordinal（事件 ordinal = seq + 1）。

`compacted` 记录至少包含：

- codec 结构字段 `conversation_id`，以及适用的 `turn_id` 和 `request_id`；
- 原 `compaction/*` AgentTraceEvent.type（写入 payload `type`）及原 `data`。其中
  `shadowedRange`、`shadowedSeqs`、summary 等 data 内 key 保持原样，不改写成新的
  canonical 业务字段；
- 原 `surfaceOp`/`sourceEventSeqs`（若有）对应的 `surface_op`/`source_event_seqs`；
  这些引用值保持原 API seq 域，不改成物理 ordinal。

读取器先将结构引用的 API seq 映射到 ordinal，并验证其存在且早于当前记录，再把
compacted 记录应用为 surface 的逻辑替换。任何同 ordinal 或未来 ordinal/seq 的
source/surface 引用都 fail closed。
旧行仍可供审计、重新折叠和错误排查使用；“不在当前 surface”不等于“从 source of
truth 删除”。tool result 的裁剪也应记录为逻辑 replace，而不是覆盖原始行。

## 8. 索引、压缩与迁移边界

### 当前实现

- `.jsonl` 是唯一 source of truth；会话列表、历史分页和 Transcript 重建均可直接扫描
  或读取它。
- 内存中的 session snapshot、surface 序列、文件尺寸和修改时间是缓存/一致性辅助，
  不是第二个事实来源。
- 当前任务不引入 SQLite 索引、物理压缩、zstd、分段日志或 manifest。不得要求这些
  对读取和写入成立。

### 允许的未来扩展

未来可以从 JSONL 重建按 ordinal、timestamp 或 turn 的 byte-offset 索引，也可以为冷
会话生成压缩表示。但扩展必须满足：

1. 索引可删除并从原始 JSONL 完整重建，索引损坏不能隐藏或改变日志内容。
2. 物理压缩不改变 canonical record，不与热写入并发覆盖同一文件；读取器应能在表示
   切换期间安全重试。
3. 压缩前必须完成 writer barrier；重新追加前必须回到可写的 canonical JSONL，不能在
   压缩块中原地追加。
4. 迁移必须是显式、可观测、可失败回滚的操作；普通读取不偷偷迁移，也不扫描并改写
   用户的旧会话目录。
5. 若需要断电后 rename 目录项的更强持久性，未来可在同目录 atomic rename 后增加父目录
   fsync；这不是当前实现的保证。

这些是边界而不是当前能力。引入索引、压缩或迁移时，仍须保持 JSONL 可独立验证，不能
让数据库、压缩文件或分段 manifest 成为本任务的强依赖。

## 9. Harbors Harness request/broadcast 完整顺序

下列顺序描述普通流式 turn、工具审批、终态和失败的完整可观察链路。定向 request 只有
一个目标；broadcast 可有多个订阅者，单个监听器异常不反向破坏发送者。

### 9.1 普通流式 turn

1. Chat/Conversation 以定向 request 调用 `agent.createConversation` 或
   `agent.sendMessage`，参数包含会话和用户输入。
2. Agent 创建新会话时先写并完成 `session_meta`；之后按 writer 顺序写 sandbox/approval
   设置、turn started、`user/message` 等 event_msg，以及显式 `item/*` lifecycle 和
   surface 记录。除不投影的
   `session_meta` 外，每条成功记录都先完成同步 append 和内存 fold，再在持有文件 lock
   期间触发 `agent.conversation.trace.append`，之后才更新对应的 Chat 可见状态。
3. Agent 以定向 request 调用 `model-service.getCatalog`（如需）和
   `model-service.complete`。请求携带唯一 `request_id`、`generation`、模型及上下文；
   Agent 同时持久化原 `request/context`，保留该 request 的关联。
4. Model Service 将 Provider 流增量以 `model-service.complete.delta` broadcast 发出。
   Agent 只接受同一 `request_id`、`generation` 且 `sequence` 连续的增量；晚到、重复、
   跨 generation 或乱序增量丢弃，不进入日志。
5. 对每个接受的增量，Agent 将 `response_item` delta 放入该会话 queue，按本节第 5.2
   节完成同步 append，然后 broadcast `agent.conversation.trace.append`。随后才通过
   `agent.message.delta` 向 Chat 提供实时文本，并保留 request/generation/sequence。
6. Model Service 完成后，Agent 先写 assistant message 的 completed snapshot，再写
   response item completed、step 结束和适用的工具调用；completed snapshot 是 Chat 重放
   时的最终依据。Agent 发送 `agent.message.status` 的 running/completed/error 状态。
7. 无工具调用时，Agent 写 `turn_context` ended（`reason.kind = completed`），等待 sync
   barrier 后 broadcast trace append 和最终 status；有工具调用时进入工具/审批链路。

### 9.2 工具调用与审批回环

1. Agent 将 `tool/call` event_msg（即使 opaque `data.item` 描述了工具调用）写入 JSONL，
   成功持久化后广播 trace append；`tool/result` 同样是 event_msg，另有显式 item lifecycle
   时才写入对应 response_item；工具结果必须以 tool result completed snapshot 落盘。
2. 需要权限时，Agent 先写显式 `approval` item lifecycle，再写
   `event_msg(payload.type = approval/asked)`；后者即使带有 `data.item` 也仍是 event_msg，
   完整携带 `conversation_id`、`turn_id`、`item_id`、`request_id`，再广播 `approval/asked`
   （作为 trace 及 Agent 的可见事件）。
3. Chat 只对同一四键关联调用定向 request
   `agent.resolvePermissionRequest`；Agent 校验 request 是否仍等待、四键是否一致，
   重复终态按幂等处理。
4. Agent 写 `event_msg(payload.type = approval/resolved)` 和 approval completed snapshot；
   该业务 verb 即使带有 `data.item` 也不分类为 response_item。对该记录执行 sync barrier；成功后广播 `agent.conversation.trace.append` 与审批
   结果/状态。审批结果不是提前更新的内存标志。
5. `rejected`、`cancelled`、`unavailable` 或 `timed_out` 会形成明确的工具错误结果；
   Agent 可继续向 Model Service 请求恢复性回答，拒绝本身不必然结束 turn。工具成功或
   错误均通过 tool result snapshot 进入下一次模型上下文。

### 9.3 Stop、Provider 错误与终态

1. Chat 的 Stop 通过 Agent 的定向 request 取消当前 request/generation；Agent 再向
   Model Service 定向 request `cancel`。晚到的成功或 delta 经过 request/generation
   校验后不改变当前会话。
2. Provider 错误、取消、超时或工具循环保护先形成包含 `request_id` 的错误 envelope，
   写入关联 `event_msg`/item，再写 `turn_context ended` 的终态 reason。
3. `turn_context ended` 的所有终态（`completed`、`failed`、`cancelled`、`rejected`、
   `timed_out`）都必须经过 sync barrier；barrier 成功后广播 trace append，最后广播
   `agent.message.status` 的 completed/error 状态。
4. 当前 `AgentAdapter.stop` 是同步取消接口；它不提供后台 writer queue 的排空、显式
   flush 或异步 shutdown 生命周期。后台 flush/async shutdown 是未来边界，不作为当前
   持久化成功的前提。重启后 Chat 从 JSONL 重放，不依赖上一进程的内存广播。

## 10. 实现检查清单

实现或审查 Agent JSONL 时至少验证：

- 新会话首行是 v1 `session_meta`，后续每行是有效 canonical envelope，codec 结构字段为
  snake_case，opaque data/snapshot/delta 保持原样，ordinal 连续；
- record discriminator、payload.type 的非空保留规则、文件名 ID/header conversation_id
  一致性、response_item 的 item_id、合法局部生命周期、稳定关联、completed snapshot
  和四类 ID 均有结构测试；singleton completed 与 EOF 未完成 started item 均属合法语义；
- source_event_seqs/surface_op 只引用当前记录之前已存在的 seq，canonical item 字段可重建
  投影后的 `data.item`；
- 同会话队列、跨实例 lock、append 与关键 sync barrier 的失败路径不会提前 broadcast；
- v0 可读、v1 单写，普通 legacy 读取不隐式重写；尾损坏可修复，中间损坏和未知 schema
  明确失败；
- 读取/分页/重启后的 API 投影与改造前 AgentTraceEvent 语义等价，Chat 不需要直接理解
  磁盘格式；
- 删除 tombstone、trash、普通文件检查和路径隔离继续 fail closed；
- 任何未来索引或压缩都能从 JSONL 重建，且不会被误写成 v1 当前已具备的能力。

相关协议：[Agent Turn 事件协议](./agent-turn-event-protocol.md) ·
[Harbors Harness Kit 装配与回归边界](./harness-kit-assembly.md)
