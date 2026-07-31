# TraceWeave Kit 迁移设计

## 1. 决策

将独立原型 TraceWeave 迁移为 Harbors 官方独立 Kit：`@itharbors/kit-traceweave`。

首期继续只读支持本机 Codex 会话，保留原型已经实现并验证的能力：

- 发现活跃与归档 Codex 运行；
- 将 JSONL rollout 解析为 Run、Turn、节点、边和指标；
- 默认按 Input → Understand → Execute → Output 展示每轮主干；
- 展开阶段查看按时间排序的原始步骤；
- 切换到完整 Events 诊断视图；
- 按 Observed、Derived、Inferred 证据等级筛选；
- 隐藏成功工具、折叠轮次、按源偏移回放；
- 打开脱敏后的原始证据检查器；
- 对损坏或未知记录给出告警，同时保留其余有效证据。

不迁移原型的独立 Fastify 服务、Vite 应用入口和固定端口。Harbors 已经拥有 Session、插件、Panel 和消息边界；重复建立本地 HTTP 服务会制造第二套生命周期、路由和安全模型。

## 2. 备选方案

### A. 原型作为独立服务，由 Kit iframe 打开

迁移最快，但保留额外端口、服务启动与退出竞态、跨进程错误处理和重复静态资源服务。它绕过 Harbors 插件协议，不选用。

### B. 把 TraceWeave 放进 Default Kit

能够复用现有窗口，但会把特定产品功能提升为框架默认能力，无法单独发布、停用或演进，不选用。

### C. 官方独立 Kit（选用）

数据读取运行在 Session 插件主进程，界面运行在 Kit Panel，二者只通过 Harbors message request 通信。功能与会话隔离、Kit 发布和桌面生命周期自然对齐。

## 3. 架构

```text
@itharbors/kit-traceweave
├── @itharbors/traceweave-core (Session plugin main)
│   ├── Codex discovery
│   ├── streaming JSONL parser
│   ├── normalization + skill inference
│   ├── redaction + bounded raw evidence
│   └── mtime/size cache + opaque run registry
└── @itharbors/traceweave-view (Panel)
    ├── run rail
    ├── Flow overview
    ├── Events board
    ├── replay and filters
    └── evidence inspector
```

`@itharbors/traceweave-contracts` 是唯一共享协议包，定义公开的 trace 数据、请求输入、错误 envelope 和 topic 名称。它不包含文件路径、Node API 或 UI 代码。

### 3.1 服务边界

Core 插件在 Session scope 装载。它从 `CODEX_HOME` 读取显式覆盖路径；没有覆盖时使用当前用户主目录下的 `.codex`。它不得启动端口、写入 Codex Home、依赖 Electron API或把真实 rollout 路径发给 Panel。

公开请求：

- `listRuns()`：重新扫描索引并返回排序后的不透明运行摘要；
- `loadRun({ runId })`：只接受当前 registry 发出的 opaque id；
- `loadRawEvidence({ runId, eventId })`：返回脱敏且最大 64 KiB 的证据；
- `refresh()`：清空缓存并重新扫描。

所有返回值使用 `structuredClone` 后冻结的快照。预期错误通过 `$traceweaveError` envelope 返回，Panel 不接触 Server 内部异常或路径。

### 3.2 数据模型

Canonical model 保留原型的证据真实性约束：

- `Observed`：Codex rollout 直接记录；
- `Derived`：由已记录事件确定性转换；
- `Inferred`：本地规则推断，必须包含 rule、source ids、raw offsets，并且置信度小于 1。

节点种类为 intent、goal、plan、reasoning、skill、tool、subagent、response、error。Skill 仍不是 Codex 稳定一等事件，只从明确的 `SKILL.md` 读取或独立 Skill 使用声明识别；普通含有 “using” 的句子不算 Skill 证据。

每个节点必须至少包含一个 source event id 和 raw offset。工具调用与结果按 call id 关联；缺失结果产生 warning，不伪造成功状态。

### 3.3 UI 数据流

Panel 的 `mount(ctx)` 创建 React root，并把 `ctx.message.request` 包装为 `TraceweaveApi`。UI 不使用 `fetch`，也不知道 Harbors session id。

```text
Panel action
  → ctx.message.request("@itharbors/traceweave-core", method, input?)
  → Core adapter / cache
  → immutable public snapshot or public error envelope
  → React state
```

Panel `unmount()` 必须卸载 React root。异步响应使用递增 request generation 忽略卸载或切换选择后的陈旧结果。

## 4. 交互与视觉

产品对象是调试 Codex 编排的 Agent 开发者；页面唯一任务是解释一次输入如何经过理解和执行变成输出。

保留原型的冷灰蓝工程工作台，但让 Harbors 主题 token 控制基础背景、文字和 accent。签名元素是贯穿多轮的“信号脊柱”：橙色轮次轨道连接每轮四个固定阶段，Input 使用深色终端面，Understand 使用线框计划面，Execute 使用活动密度刻度，Output 使用青绿色终端面。其余 chrome 保持安静。

布局：

```text
┌─────────────────────────────────────────────────────────────┐
│ TraceWeave · Local only                         Flow Events  │
├──────────────┬──────────────────────────────────────────────┤
│ Runs         │ T01  Input → Understand → Execute → Output   │
│ search/list  │      expandable chronological evidence       │
│              │ T02  Input → Understand → Execute → Output   │
│              │                                              │
│              │ replay / filters / status                    │
└──────────────┴──────────────────────────────────────────────┘
```

Events 视图使用可滚动、可缩放的语义 DOM/SVG 画布，不依赖 React Flow。它保留完整节点和因果边、轮次折叠、证据筛选、成功工具筛选与节点检查；节点不允许拖拽或连线。这样 Panel 产物不需要携带第二套画布样式运行时。

宽度低于 980px 时 run rail 变成顶部横向列表，Flow 四阶段纵向排列；不产生页面级横向滚动。Events 画布自身可以滚动。所有按钮使用原生控件、44px 最小主操作目标、明确 focus-visible，reduced-motion 下停止自动回放和过渡。

## 5. 安全与隐私

- Kit 权限只声明 `filesystem`；没有 network 或 application-startup。
- 读取边界固定在解析后的 Codex Home 的 sessions、archived_sessions 与 session_index.jsonl。
- 递归发现拒绝逃逸根目录的路径；不跟随符号链接目录。
- Panel 只收到 opaque run id，不收到 home、rollout 或 workspace 的绝对路径。Workspace 字段只返回目录 basename 或省略。
- 常见 token、secret、authorization、cookie、password 字段在跨浏览器边界前递归脱敏。
- 单条 raw evidence JSON 序列化后最多 65,536 字符，并明确标记 truncated。
- 不上传数据、不发送遥测、不修改 Codex 会话。

## 6. 官方 Kit 集成

新增 `traceweave` 到唯一官方 Kit policy、Kit monorepo 列表、Kit check CLI usage、根测试门禁和选择器测试。版本从 `0.1.0-preview.1` 开始，runner 使用 `ubuntu-latest`，target 为 `any/any`。

Kit 使用一个主窗口、一个 simple Panel。`main.html` 和 `secondary.html` 只提供窗口标题占位，实际工作区由 layout 加载 `@itharbors/traceweave-view.trace`。

根构建图增加 `@itharbors/traceweave-contracts` workspace，并让两个 TraceWeave 插件依赖其 dist。Kit 自己的 build 先构建 contracts，再构建 core 和 view；test 先构建 Framework 内置插件，再运行 Kit Vitest。

## 7. 错误处理

- 找不到 Codex Home 或没有会话：返回空列表，UI 给出下一步提示；
- index 损坏：忽略无效行，仍从 rollout 文件元数据发现会话；
- rollout 部分损坏：记录 line warning 并继续；
- run id 或 event id 无效：返回固定 public error code，不泄露 registry 内容；
- 文件在读取期间变化：本次结果按读取到的完整行构建，下次 load 通过 size/mtime 失效缓存；
- Panel 请求失败：保留 rail，主区域显示可重试状态；
- Kit unload：清空 runtime 引用和内存 cache，不删除文件。

## 8. 测试与验收

1. 官方 Kit manifest、policy、lock、build/check/CI 选择均接受 traceweave。
2. sanitized 两轮 fixture 可解析出 intent、reasoning、skill、tool/result、sub-agent 与 response。
3. malformed JSON、unknown event 与 missing tool result 形成 warning，其他证据仍可用。
4. Skill 只从明确证据推断且 confidence < 1。
5. registry 不公开路径，非法 run id/event id 被拒绝。
6. raw evidence 在返回 Panel 前脱敏并限制到 64 KiB。
7. Core 插件通过真实 Harbors message route 完成 list → load → raw evidence。
8. Flow 默认每轮固定四阶段，数百事件不会增加主干卡片数。
9. Events 保留过滤、折叠、缩放、回放和检查器。
10. Panel mount/unmount、loading、empty、error、narrow viewport、键盘和 reduced-motion 行为有自动化覆盖。
11. `npm run build -w @itharbors/kit-traceweave`、Kit 测试、`npm run kit:check -- traceweave` 与相关仓库测试通过。
12. 使用本机真实 Codex Home 做只读验证；验证前后被选 rollout 的 size 与 mtime 不变，输出只打印聚合统计。

## 9. 明确不做

- 不展示隐藏 chain-of-thought，只展示 Codex 记录的 reasoning summary；
- 不推断时间重叠就是并行；
- 不编辑、恢复或继续 Codex 会话；
- 不实现运行对比；
- 不连接实验性 Codex App Server 实时事件；
- 本次不发布 Kit Tag，只完成可审查、可打包的 Preview 实现。
