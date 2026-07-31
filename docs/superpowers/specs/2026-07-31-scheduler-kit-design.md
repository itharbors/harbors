# Scheduler Kit 设计

## 目标

新增可独立发布的官方 `scheduler` Kit，让用户在桌面界面中配置本地 Node.js 脚本的一次性或固定间隔运行计划。计划在 Harbors 启动但 Scheduler 界面未打开时仍须执行；应用退出期间错过的时间点必须按用户选择补偿，并留下可审计的运行记录。

首版只执行本地 `.js`、`.mjs`、`.cjs` 文件，不提供 shell 命令、Cron 表达式、远程执行、依赖编排或系统级常驻服务。Harbors 未运行时不会唤醒操作系统；重启后的补偿属于本 Kit 的职责。

## 方案比较

### 方案 A：仅 Session 插件

调度器和界面都放在普通 Session 插件中。实现最少，但只有用户打开 Scheduler Kit 时才运行，无法承担可信的桌面调度职责，因此不采用。

### 方案 B：应用启动插件加独立 Loopback HTTP 服务

启动插件监听固定本机端口，面板通过 Session 插件转发 HTTP。它能脱离界面运行，但引入端口冲突、额外鉴权面和一套 Kit 私有传输协议，因此不采用。

### 方案 C：应用启动插件加应用消息回退

Scheduler Service 作为 `startup.plugins` 中的应用级插件运行。Framework 的 Session 消息模块在找不到本地路由时，将请求交给 Application Runtime；Panel 因而能通过既有 `message.request` 契约访问启动插件。该扩展是通用、同进程且向后兼容的，不开放新的网络端点。采用此方案。

## 产品语义

### 计划类型

- 一次执行：用户选择本地日期时间，保存为绝对 ISO 时间。
- 固定间隔：用户选择起始日期时间，以及 1 分钟至 365 天的间隔。后续时间始终锚定起始时间计算，不使用“上次实际完成时间”，避免长期漂移。
- 用户可暂停、恢复、立即运行、编辑或删除任务。手动运行不改变下一计划时间。

### 错过触发

计划时间之后 30 秒内启动仍视为正常触发；超过 30 秒视为错过。

- `run-once`（默认）：立即补跑一次。循环任务不逐次回放所有错过时间点，下一次仍按原始时间轴计算。
- `skip`：记录一次“已跳过”结果。一次性任务随后关闭；循环任务直接推进到第一个未来时间点。

同一任务上一进程尚未结束时到达新时间点，记录为“重叠跳过”，并继续按原始时间轴推进。不同任务可并行执行。

### 脚本执行

仅接受存在的绝对路径，扩展名必须是 `.js`、`.mjs` 或 `.cjs`。使用当前 Harbors 的 `process.execPath` 直接 `spawn`，参数为脚本路径，`shell: false`，工作目录为脚本所在目录，环境变量继承 Harbors 进程。首版不接受自由 shell 文本，从边界上消除 shell 注入。

运行记录保留最近 100 条；每个 stdout、stderr 最多保留末尾 64 KiB。应用关闭时先向仍在运行的子进程发送 `SIGTERM`，5 秒后仍未退出才发送 `SIGKILL`。下次启动把未完成记录标为“已中断”。

## 架构

### Framework 消息桥

`MessageModule` 增加可选的 `dispatchFallbackRequest`。请求经过本地通配观察器后，如果没有 Session 路由，则调用该回退；已有本地路由始终优先。Server 将它连接到 `ApplicationRuntime.request`。这让所有应用启动插件都能被 Session 请求，而不改变已有插件 API 或开放 HTTP 控制面。

### Scheduler Service

`@itharbors/scheduler-service` 是应用启动插件，包含以下独立单元：

- `schedule.ts`：校验计划并计算下一个锚定时间。
- `store.ts`：读取、校验和原子写入版本化 JSON。
- `script-runner.ts`：无 shell 地执行 Node 脚本、截断输出并管理关闭。
- `scheduler.ts`：维护单一唤醒定时器、协调补偿/重叠/持久化和运行历史。
- `index.ts`：插件生命周期及 `getSnapshot`、`saveJob`、`deleteJob`、`setJobEnabled`、`runJobNow` 消息方法。

桌面环境通过通用 `HARBORS_DATA_ROOT` 获得 Electron `userData` 目录，存储文件为 `<data-root>/kits/scheduler/state.v1.json`。Web 开发模式回退到仓库忽略的 `.harbors-data`。状态写入使用同目录临时文件加 rename，所有变更经串行写队列提交。

### Scheduler Panel

`@itharbors/scheduler-panel` 贡献一个全窗口 Panel，不包含调度状态。它每两秒读取快照，并通过应用消息执行变更。

界面采用“运行时刻表”视觉方向：

- 背景 `#eef3f8`，主墨色 `#13283a`，轨道蓝 `#1b6688`，时间琥珀 `#d7892f`，成功绿 `#2f8068`，危险红 `#b74f52`。
- 标题使用系统窄体回退栈，正文使用系统 UI，时间与路径使用等宽字体。
- 左侧是任务卡与下一触发轨道，右侧是编辑台；底部是最近运行日志。
- 记忆点是贯穿任务卡的“时间轨道”：节点表示下一触发，暂停、错过、运行中和失败状态使用不同轨道信号。
- 动画只用于当前运行节点的单次脉冲，并尊重 `prefers-reduced-motion`。

窄屏降为单列，编辑台移到任务列表之后。所有操作使用语义按钮和表单标签，状态信息使用 `aria-live`，键盘焦点始终可见。

## 数据模型

```ts
type Schedule =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; startAt: string; everyMs: number };

type SchedulerJob = {
  id: string;
  name: string;
  scriptPath: string;
  schedule: Schedule;
  misfirePolicy: 'run-once' | 'skip';
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRun = {
  id: string;
  jobId: string;
  trigger: 'scheduled' | 'manual' | 'misfire';
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted';
  reason: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};
```

磁盘根对象严格为 `{ schemaVersion: 1, jobs, runs }`。无法解析、版本错误或字段非法时启动插件进入 degraded 状态并保留原文件，不静默覆盖用户数据。

## 错误处理

- 表单输入错误返回到 Panel 展示，并且不写状态。
- 脚本在保存后被移动或删除时，该次运行记录为失败，循环计划仍继续。
- 非零退出码和信号终止记录为失败；调度服务自身不因单个脚本失败而停止。
- 状态写入失败时变更请求失败，内存回滚到写入前快照。
- Panel 连续刷新去重；旧请求和卸载后的响应不得覆盖新界面。
- 删除运行中的任务时先终止对应子进程，再删除任务；历史记录保留名称不可用时显示“已删除计划”。

## 官方 Kit 与发布边界

新增 `scheduler` 到 Registry policy、官方 Kit 集合、CI 选择矩阵和根测试命令。它与 CSV、SQLite、MySQL、Notifications 一样是市场 Kit，不加入内置 Kit 列表。版本从 `0.1.0-preview.1` 开始，权限声明为 `filesystem`、`native-code`、`application-startup`；Registry v1 中以现有高风险 `native-code` 权限保守覆盖本地 Node.js 脚本执行。

## 测试与验收

- Framework 单测证明本地消息优先、无本地路由才回退到 Application Runtime、未知应用消息仍返回明确错误。
- Schedule 单测覆盖一次性、锚定间隔、边界与错误输入。
- Store 单测覆盖空状态、原子保存、损坏/错误版本拒绝、运行中恢复。
- Runner 单测使用真实临时 Node 脚本覆盖成功、非零退出、输出截断和终止。
- Scheduler 使用可控时钟和真实内存 Store 覆盖正常触发、两种错过策略、无补跑风暴、重叠跳过、暂停恢复、手动执行与历史上限。
- Panel jsdom 测试覆盖快照、创建/编辑、暂停/恢复、立即运行、删除、错误/空状态、轮询清理和窄屏所需语义结构。
- Kit manifest、插件构建检查、`npm run kit:check -- scheduler`、根构建与相关测试必须通过。
