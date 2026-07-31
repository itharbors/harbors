# Agent Guard 本机智能体异常流量监控与熔断设计

## 背景

2026 年 7 月 29 日，本机 Claude Code 的 `SessionEnd` Hook 在会话结束后执行新的
`claude -p`。新进程结束时再次触发同一 Hook，形成递归进程和会话风暴。该链路从下午逐步
放大，次日 00:00–08:00 在 Relay 侧产生约 51,620 条 Trace。仅恢复配置无法停止已经继承旧
Relay 环境变量的存量进程；最终需要移除递归 Hook 并终止异常进程树。

这次事故暴露了一个本机侧缺口：Claude Code、Codex 等 Agent 可以在无人操作时持续创建任务并
消耗模型流量，而本机缺少低开销、无内容采集、能够归因和止损的常驻保护能力。

## 目标

1. 在不修改 Claude、Codex 或系统网络配置的前提下，监控本机已知 Agent 的外部连接和累计字节。
2. 第一版支持 Claude Code 与 Codex CLI/Desktop，并通过独立适配器保留扩展边界。
3. 结合网络、进程树和会话元数据识别突发流量与递归任务风暴。
4. 动态异常默认预警；固定安全规则和高置信度递归异常可以自动熔断。
5. 零配置模式下通过暂停或终止确认过的任务进程树止损，不终止 Agent 宿主程序。
6. 全程不读取、记录或展示 Prompt、回复正文、API Key、完整请求头或完整环境变量。
7. UI 关闭后后台保护仍生效，并满足明确的 CPU、内存和磁盘预算。

## 非目标

- 第一版不提供 HTTP/HTTPS、SOCKS、CONNECT 或系统级代理。
- 不安装中间人证书，不解密 TLS，不读取请求路径或请求正文。
- 不把连接数描述成模型请求数；一个 HTTP/2 连接可能承载多个请求。
- 不精确统计 Token、费用或 Relay Trace 数量。
- 不监控浏览器、未知 CLI 或机器上的全部网络流量。
- 不支持 Linux、Windows 或 Intel Mac；首个发布资产为 macOS arm64。
- 不自动修改 Agent Hook、Provider、模型或登录配置。
- 不对无法安全归因的进程执行自动处置。

## 核心约束与术语

### 周期聚合不是请求抽样

后台持续读取操作系统提供的累计连接字节。每 2–5 秒计算一次累计值差量，统计窗口内即使发生
多次网络活动，累计字节仍会进入该窗口。该周期不是随机挑选某个请求。

纯观察模式仍存在两个不可消除的限制：

1. 在相邻进程快照之间完整启动并退出、且没有留下会话元数据的极短进程可能无法被发现。
2. 在相邻网络快照之间完整建立并关闭的短连接可能漏记，其字节不会被估算补齐。
3. TLS 和 HTTP/2 隐藏请求边界，因此只能统计连接和字节，不能得出准确请求数。

产品文案和 API 字段必须保留这些语义，不提供 `requestCount` 一类虚假指标。

### 域名是归因结果，不是 TLS 观察结果

`netstat -anv -p tcp` 能提供进程、两端地址、连接状态与累计字节，但不能可靠提供 TLS 请求使用的原始域名。
Agent Guard 从 Agent 的当前 Provider 配置读取非敏感 endpoint，再将 hostname 按 TTL 解析为
A/AAAA 地址集合，并与远端地址匹配。反向 DNS 只作为辅助线索，不作为确定证据。

界面显示的域名必须同时显示置信度和证据来源：

- `confirmed`：当前 Agent 配置声明该 endpoint，连接属于该 Agent 任务进程，远端地址命中该
  endpoint 的当前或 TTL 内历史 DNS 集合。
- `probable`：连接属于已知 Agent，远端地址或反向解析命中已登记模型服务，但当前配置无法完成
  唯一匹配。
- `unknown`：共享 Helper、浏览器、未知进程或共享 CDN 地址无法安全归因。

只有 `confirmed` 归因可以参与自动熔断。DNS 轮换、共享 CDN、解析失败和 VPN 改写均应降低置信度，
不能用猜测补齐。

## 产品形态

新增独立 Kit：`@itharbors/kit-agent-guard`。首版 Kit manifest 声明：

- `target`: `darwin/arm64`；
- `permissions`: `network`、`filesystem`、`process-control`、`application-startup`；
- 一个 application-scope 后台插件 `@itharbors/agent-guard-background`；
- 一个 session-scope UI 插件 `@itharbors/agent-guard-center`。

现有 Kit permission 模型没有 `process-control`。本变更新增该权限，并按高风险权限展示。Registry
只允许官方 `itharbors` publisher 请求 `process-control`，规则与 `application-startup` 的官方发布者
限制并列。权限声明是安装审查和发布策略的一部分，不以“插件本来能调用 Node API”为理由省略。

### 后台插件

后台插件随 Framework 的 ApplicationRuntime 启动，不创建 Kit Session 或 BrowserWindow。它组合：

1. Agent Registry 与 Claude/Codex 适配器；
2. macOS 网络累计采集器；
3. 进程与会话观察器；
4. 归因器；
5. 动态基线与规则引擎；
6. 熔断控制器和恢复看门狗；
7. 轮转元数据存储；
8. Notification Host 客户端；
9. application message API。

后台插件失败只令 Agent Guard 进入 degraded 状态，不能阻止 Harbors、其他启动插件或其他 Kit 启动。

### 懒加载 UI 插件

用户首次打开 Agent Guard Kit 时才创建 Session 和 Dashboard Panel。Dashboard 提供：

- 总览：保护状态、Collector 健康、Claude/Codex 当前状态；
- 实时视图：Agent、Provider、归因域名、连接、上下行速率、活跃任务和置信度；
- 事件时间线：异常证据、规则、处置、恢复和降级记录；
- 规则设置：固定上限、动态敏感度、保留周期和每 Agent 开关；
- 熔断操作：恢复、终止或临时忽略已暂停的任务；
- 隐私说明：明确未采集正文、凭据和请求数。

关闭窗口只卸载 UI，不停止 application-scope 后台保护。

## 组件设计

### Agent 适配器

每个适配器实现统一接口：

```ts
interface AgentAdapter {
  id: 'claude' | 'codex';
  discoverConfiguration(): Promise<AgentConfiguration>;
  classifyProcess(process: ProcessSnapshot): AgentProcessRole | null;
  discoverSessionActivity(since: number): Promise<SessionActivity[]>;
  selectSafeControlTarget(tree: ProcessTree, incident: Incident): ControlTarget | null;
}
```

`AgentConfiguration` 只包含 Provider 名称、endpoint hostname、配置来源文件、读取时间和配置摘要
哈希。解析器必须使用字段 allowlist，不得把未知字段、Token、Key 或完整配置对象传入日志和存储。

Claude 适配器读取 `~/.claude/settings.json` 中允许的 Provider/base URL、Hook 名称和模型字段，只用
Hook 命令的可执行文件与事件名称识别递归风险，不保存命令参数和 Prompt。Codex 适配器读取
`~/.codex/config.toml` 中允许的 model/provider/base URL 字段，并识别 Desktop app-server、CLI
任务和 Renderer/Helper 的不同角色。

Adapter 使用 `fs.watch` 接收配置或会话目录变化，并以低频完整重扫作为丢事件后的修复。文件事件只
记录路径类别、时间和 session 标识摘要，不读取 transcript 正文。

### macOS 网络累计采集器

Collector 默认每 5 秒执行一次有超时和输出上限的 `netstat -anv -p tcp` 快照。每次命令结束后才
调度下一次，避免重叠；失败时指数退避并切换 epoch，避免把跨缺口累计值误当作连续流量。这个方案
比常驻 `nettop` 显著降低目标 macOS 上的 CPU 和 RSS。

Collector 输出经过严格列解析和上限约束后转换为：

```ts
interface ConnectionCounter {
  observedAt: number;
  pid: number;
  processStartTime: number;
  executableIdentity: string;
  localAddress: string;
  remoteAddress: string;
  transport: 'tcp' | 'udp';
  state: string;
  bytesIn: bigint;
  bytesOut: bigint;
}
```

任意计数器倒退、PID 启动时间变化、Collector epoch 变化或解析缺口都切断差量连续性；该窗口标记为
`incomplete`，禁止用负数、跨 epoch 差量或估算值触发熔断。

### 进程观察器

进程观察器以 5 秒为默认周期读取已知 Agent 及其祖先/后代的最小快照：PID、PPID、进程组、启动
时间、可执行文件 identity、可执行名称标记和父子拓扑。它不请求环境变量或命令行参数；无法通过
这些字段确认的顶层 CLI 只作为 host 监控，不参与自动控制。

观察器构建有界进程树并计算：

- 新任务进程数；
- 同类进程树深度与宽度；
- 相同可执行文件的父子递归；
- 短时间内会话和任务的创建速率；
- 宿主、任务、Hook 子进程和未知 Helper 角色。

Codex Desktop 主进程、Renderer、通用 Helper 和 Claude 宿主默认不可成为自动控制目标。

### DNS/IP 归因器

归因器按 Provider endpoint hostname 维护带 TTL 的 A/AAAA 地址历史。DNS 查询失败不删除仍在 TTL
内的旧集合；超过 TTL 后连接降为 `probable` 或 `unknown`。同一 IP 被多个 endpoint 或非模型服务
共享时不得产生 `confirmed`。

归因输出包含 Agent、Provider、display hostname、远端地址摘要、process role、confidence 和
evidence codes。远端完整 IP 只保留在短期内存关联中；持久化时使用带本机随机 salt 的摘要，避免
无必要保存完整网络目的地址。

### 动态基线与规则引擎

指标按 `agent + provider endpoint` 聚合：

- `bytesIn` / `bytesOut` 差量和速率；
- active/new/closed connections；
- active/new task processes；
- new sessions；
- process-tree depth、width 和 same-executable recursion；
- attribution confidence 与数据完整性。

动态基线使用有界滚动统计，比较短期窗口和历史中位数/离散度，避免单个离群点污染基线。前 24 小时
为学习期，动态规则只告警。基线按 Agent/endpoint 分开，不把 Claude 与 Codex 或官方 Provider 与
Relay 混为一组。

固定规则和默认值放在版本化 policy 文件中，用户设置只保存显式覆盖。规则判定遵循：

1. 数据不完整或置信度不足时只告警；
2. 单一字节峰值只告警；
3. 流量类熔断要求至少两个信号持续多个窗口；
4. 已确认的同类进程递归可以独立触发结构性熔断；
5. 规则触发必须生成可解释 evidence，不输出含糊的“AI 判断异常”。

初始 policy `v1` 使用 60 秒判定窗口、连续 3 个异常窗口和 10 分钟流量窗口：

- 动态预警：完整且至少 `probable` 的流量达到历史中位数的 5 倍、超过
  `median + 6 * MAD`，并且绝对出站速率不少于 8 MiB/min；同时 new sessions 不少于
  6/min、new task processes 不少于 8/min、new connections 不少于 20/min 三者之一成立。
- 固定流量预警：10 分钟出站累计不少于 128 MiB，并伴随 new sessions 或 new task processes
  不少于 20/10min。
- 固定流量熔断：`confirmed` 且完整的 10 分钟出站累计不少于 256 MiB，并伴随 new sessions 或
  new task processes 不少于 30/10min，连续 3 个 60 秒窗口成立。该规则只暂停安全任务目标。
- 结构性熔断：同类任务可执行文件递归深度不少于 4，且 120 秒内创建不少于 8 个同类任务进程；
  或 60 秒内创建不少于 20 个同类任务进程且同时活跃不少于 8 个。该规则在学习期立即生效。

默认数值以版本化 JSON 资源保存，并用事故回放与正常多 Agent 工作负载锁定。修改默认值必须提升
policy version、提供迁移说明和回归证据，不能在代码分支中散落匿名常量。用户可以收紧或放宽固定
阈值，但不能配置全局永久忽略。

### 熔断控制器

零配置模式无法在网络层拒绝单个请求。第一版的“熔断”定义为对安全控制目标进行进程控制：

- warning：创建通知和事件，不发送信号；
- tripped：对确认的任务进程组发送 `SIGSTOP`，阻止继续执行；
- recursive runaway：终止确认的递归任务子树，优先 `SIGTERM`，超时后只对同一已验证目标使用
  `SIGKILL`；
- recovery：用户确认后对仍匹配 PID、启动时间、可执行文件和进程组的目标发送 `SIGCONT`；
- ignore：为明确的 Agent/endpoint/rule 建立有期限豁免，不能创建全局永久绕过。

每次发送信号前重新读取 PID、启动时间、可执行文件 identity、进程组和父子关系。任意不一致都取消
控制并降级告警。控制器从不以进程名字符串作为唯一依据。

自动终止仅适用于适配器确认的递归任务子树。普通固定流量阈值只暂停，不自动终止。Codex Desktop
宿主、Claude 宿主和无法区分多任务的共享进程只告警。

### 恢复看门狗

暂停进程前，后台启动一个最小恢复看门狗并通过管道传入控制 ledger；不向命令行传完整策略、域名或
敏感数据。看门狗只拥有恢复由本次 Agent Guard 实例暂停目标所需的 PID、启动时间和 identity。

- Harbors 正常退出时，后台先恢复所有仍暂停的目标，再结束看门狗。
- 后台心跳或控制管道意外关闭时，看门狗重新核验目标后执行 `SIGCONT`。
- 下次启动会读取未完成 ledger，核验后恢复遗留暂停目标并写入审计事件。
- 看门狗绝不终止进程，也不扩大控制集合。

### 元数据存储

第一版不引入新的 native database 依赖。后台使用原子 JSON 状态文件与按日轮转 NDJSON：

- `state.json`：schema version、规则覆盖、Collector 状态、rolling baseline 和 salt；
- `metrics-YYYY-MM-DD.ndjson`：分钟聚合指标；
- `incidents-YYYY-MM-DD.ndjson`：异常、证据和处置审计；
- `control-ledger.json`：当前由 Agent Guard 暂停的目标，原子更新。

Electron 在启动 Framework 时传入专用的 `HARBORS_AGENT_GUARD_DATA_DIR`，值固定为当前应用
`userData/agent-guard`。后台只接受绝对路径，并在首次写入前解析真实父目录、验证目标仍位于传入
目录内。Web 模式或环境变量缺失时进入只读 degraded 状态，不回退到 cwd、Home 或插件安装目录。

所有写入在内存聚合后每 5–10 秒批量执行。普通指标保留 7 天，异常与处置记录保留 30 天。每日普通
统计默认上限 20 MB；达到上限后停止写普通明细并继续保留聚合和异常审计。删除顺序始终先普通统计、
后过期异常，不删除仍关联控制 ledger 的事件。

存储目录权限仅当前用户可读写。序列化层使用 schema allowlist，并以测试证明 Prompt、response、
token、authorization、cookie、完整 argv、完整 env 等字段无法进入持久化记录。

## 数据流

```text
Claude/Codex 配置 ──> Agent Adapter ──> Provider endpoint + process roles
                                          │
DNS/IP 历史 ───────────────────────────────┤
                                          v
netstat 累计计数 ─> Counter Delta ──> Attribution ──> Window Aggregator
进程/会话元数据 ────────────────────────────┘              │
                                                          v
                                              Baseline + Policy Engine
                                                │       │        │
                                                │       │        └─> Metadata Store
                                                │       └──────────> Notification Host
                                                └──────────────────> Process Controller
                                                                         │
                                                                         └─> Recovery Watchdog
```

UI 通过 application message API 获取脱敏快照、查询事件和修改规则。UI 不直接读取文件、不执行系统
命令、不持有进程控制能力。所有修改和控制操作由后台校验并审计。

## 状态机

每个 `agent + endpoint` 有独立状态：

```text
learning/normal
    └─ anomaly observed ─> warning
warning
    ├─ recovered ────────> normal
    └─ fixed/structural threshold + confirmed ─> tripped
tripped
    ├─ user resume ──────> cooldown
    ├─ user terminate ───> terminated
    └─ watchdog recovery ─> degraded
cooldown
    ├─ quiet window ─────> normal
    └─ anomaly repeats ──> tripped
```

动态异常不能单独从 normal 进入 tripped。手动恢复进入 cooldown，期间保持高频证据聚合但不自动再次
暂停同一目标；若固定或结构性规则再次满足，则允许重新熔断。所有状态转换幂等。

## 错误处理与降级

- `netstat` 不存在、超时或输出不兼容：指数退避重试；超过预算后 Collector degraded，只保留进程和
  会话告警，不执行流量熔断。
- 配置无法解析：保留上一个已验证配置到短 TTL；到期后归因降级，不自动控制。
- DNS 失败或共享 IP：降低置信度，不自动控制。
- 进程快照缺失、PID 复用或 identity 不匹配：取消信号并记录 `CONTROL_TARGET_STALE`。
- 存储不可写：继续有界内存监控，只告警一次；禁用自动控制，避免失去审计与恢复 ledger。
- Notification Host 不可用：监控继续，事件保留；Dashboard 显示通知降级。
- 单个 Agent 适配器失败：隔离失败，不影响另一个 Agent。
- 后台插件 unload：停止接收操作、恢复暂停目标、flush 有界缓冲、停止 Collector 和看门狗。

重复错误按 code、Agent 和 endpoint 合并，在冷却期内更新计数而不是制造通知风暴。

## 性能预算

- UI 未打开时不存在持续 Renderer 工作。
- Collector 使用不重叠、带 1.5 秒超时的轻量 `netstat` 快照，并在失败时指数退避。
- 空闲默认 5 秒聚合；第一版不因接近阈值而提高采集频率。
- 空闲 15 分钟平均增量 CPU 不超过 0.5%。
- 压力场景持续增量 CPU 通常不超过 2%。
- 后台与看门狗增量 RSS 合计不超过 50 MB。
- 普通统计默认每天不超过 20 MB。

性能数字是验收目标，必须由真实构建的 macOS arm64 运行结果证明，不能只用单元测试推断。若
采集器在目标系统上无法满足预算时，实施必须优化采样和聚合；不能通过放宽验收数字掩盖开销。

## 测试策略

### 单元测试

- Claude/Codex 配置 allowlist、Provider endpoint、进程角色和安全控制目标选择；
- `netstat` fixture、累计差量、epoch、计数器倒退、PID 复用和不完整窗口；
- DNS TTL、共享 IP、IPv4/IPv6 与置信度降级；
- 进程树深度、宽度、相同可执行文件递归和会话速率；
- 滚动基线、冷启动、多窗口、多信号、cooldown 和规则覆盖；
- state/metrics/incidents/control ledger schema、轮转、空间上限和敏感字段拒绝；
- 通知去重、错误降级和 UI 公开 projection。

### 集成测试

- 用受控 fixture stream 驱动 Collector、归因、规则、通知和存储全链路；
- 模拟 `SessionEnd -> claude -p -> SessionEnd` 进程树，证明结构性规则在冷启动期生效；
- 只对专用测试子进程执行 `SIGSTOP`、`SIGCONT`、`SIGTERM` 和超时升级；
- 模拟后台异常退出，证明看门狗恢复被暂停测试目标；
- 模拟 Collector、DNS、存储和 Notification Host 分别失败，证明按设计降级；
- 测试 application background 与 lazy session UI 分离，未打开 Kit 时保护仍运行。

### macOS 真实验收

1. 真实启动 Claude/Codex 后识别宿主和任务进程，不把 Renderer/Helper 当成自动控制目标。
2. 针对安全测试 endpoint 建立连接，验证累计字节、远端地址、DNS/IP 归因和窗口差量。
3. 通过专用测试 Agent 产生连接与递归任务风暴，产生桌面通知并只暂停/终止测试任务树。
4. Harbors 退出和模拟后台崩溃后，确认被暂停测试任务已恢复。
5. 重启后确认规则、基线、事件和审计恢复。
6. 检查落盘文件，确认没有对话、Key、完整 argv/env 或完整远端 IP。

### 性能验收

- 在无 Agent 任务的稳定桌面实例运行 15 分钟，记录增量 CPU/RSS；
- 回放至少 100,000 条 counter/process/session 事件并保持 30 分钟，记录 CPU、RSS、落盘大小和
  event-loop delay；
- Dashboard 关闭和打开分别测量，UI 成本不得归入后台预算；
- 所有数值写入测试报告，超出预算视为未完成。

## 验收标准

1. 安装 Agent Guard 后无需修改 Claude、Codex 或系统网络配置即可进入保护状态。
2. Claude 与 Codex 的已知任务进程、Provider endpoint、连接和累计字节可见，且带置信度。
3. 产品不显示或声称拥有准确模型请求数、Token 或费用。
4. 正常流量峰值只告警；确认的递归任务风暴可以在冷启动期自动熔断。
5. 自动控制只作用于重新核验通过的任务进程树，宿主和不确定目标不被终止。
6. Harbors 正常或异常退出均不会永久遗留由 Agent Guard 暂停的进程。
7. 所有持久化数据满足隐私 allowlist、轮转和空间上限。
8. 后台失败不阻止 Harbors 和其他 Kit，并按设计降级。
9. macOS arm64 的真实性能测量满足 CPU、内存和磁盘预算。
10. Kit manifest、`process-control` 权限治理、插件构建、受影响包测试和仓库完整检查全部通过。

## 兼容与发布

第一版作为独立 preview Kit 发布，只提供 `darwin/arm64` 资产。`process-control` 与
`application-startup` 都属于官方发布者受限权限；Registry、Kit Manager 和发布校验必须同步认识
该权限。安装界面将其标为高风险，并明确说明“可观察并暂停或终止已确认的本机 Agent 任务进程”。

后续扩展 Gemini、OpenCode、Linux 或 Windows 时新增适配器与平台 Collector，不改变 attribution、
policy、storage 和 UI 的公共契约。任何系统代理、TLS 解密或 Network Extension 方案都需要新的
设计和单独授权，不属于本规格的兼容演进。
