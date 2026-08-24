# 开发工作流

本指南以仓库根目录为工作目录，覆盖当前 workspace 的安装、启动、构建、测试和排查。
架构背景见[系统架构](../architecture/system-overview.md)。

## 自动化开发主流程

所有可交付的 Framework 或 Kit 变更都使用一个 [Task 档案](../tasks/README.md)，依次经过“定义任务 → 工作环境确认 → 执行计划 → 总结沉淀 → 交付处理”五段主流程。Task 的三份正式文件是需求快照 `task.md`、机器状态 `status.json` 和收口总结
`summary.md`；本机过程材料放在默认不提交的 `.work/`。

主 Agent 负责外部编排和唯一阶段状态；干净 sub-agent 接收最小 `StagePacket`，完成一个工作单元
并返回结构化 `StageResult`。工作环境确认和交付处理不新增 `status.json` stage，五个内部 stages
仍为 `requirements`、`design`、`implementation`、`verification`、`consolidation`。完整架构见
[自动化开发主流程](../architecture/automated-development-workflow.md)。

### 决策反馈闭环

决策信息按[决策反馈闭环指南](./decision-feedback-loop.md)贯穿 Task，但仍只使用下表的五个内部
stages，不增加 `status.json` 阶段或其他状态字段。角色反馈是规划输入，不能因收集到反馈就自动
升级为正式决策。

外部 decision memory 只能辅助发现可回链的仓库来源，不能独立约束 Task。无命中、`partial` 或
`failed` 都不能解释为“没有决策”，仍必须扫描仓库中的 ADR、架构文档、指南、相关 Task 和实现路径。

| 内部 stage | 闭环动作与应保留的证据 |
| --- | --- |
| `requirements` | 任务启动时检索已批准的决策，形成 Decision Context；记录候选 owner、reviewer、approver 的角色来源和负责范围；无论外部 memory 是否命中都扫描仓库 Markdown，并记录检索范围、来源、质量和未决缺口。 |
| `design` | 确认 owner、reviewer、approver 的分工；规划逐条标记决策为“适用、不适用、冲突、需新增”或“需人工确认”，并处置角色反馈、记录理由和来源；反馈与正式决策分开记录。 |
| `implementation` | 建立“决策 → 实现证据”映射；任务范围变化时重新检索并更新处置，不能沿用过期上下文。 |
| `verification` | 建立“决策 → 测试/验证证据”映射，核对冲突、例外和人工确认项的实际结论。 |
| `consolidation` | 形成 Decision Delta，分类并发布到正式落点；完成反向检索验证，确认下一次任务能找到新增或修订的信息；验证失败时保持 `in_progress` 或人工 `block`。 |

`skip` 只表示对应 stage 确认无需执行实际工作，不豁免 Decision Context、Decision Delta 或反向检索
记录。确无适用决策时，必须在检索仓库 Markdown 后明确记录“无适用项”及检索证据；确无决策增量
时，必须明确记录“无增量”及分类、反向检索验证证据。缺少这些证据时不得用 `skip` 进入终态。

新建 Task 的 `task.md` 必须有“决策上下文与处置”记录：检索意图和范围、已批准来源、外部 memory
状态及仓库定向查找、未决缺口，候选和确认后的 owner、reviewer、approver、角色来源与负责范围；
逐条列出适用性处置、理由/证据、角色反馈和需人工确认项。`summary.md` 应按“已批准决策、当前架构
事实、操作方法、待讨论方案、一次性任务证据、冲突或例外”记录 Decision Delta，并标注保留、修订、
替代、新增等变化、正式落点（ADR、架构文档、指南或 Task 记录）以及反向检索所用查询、命中结果
和仍未解决的缺口。已有 Task 的兼容边界和可复用记录结构见 [Task 档案契约](../tasks/README.md)。

### 定义任务

开始实现前确认背景、目标、范围、非目标、验收标准和约束，再选择一种类型：`feature`、`bug`、
`optimize`、`docs`、`refactor`、`test` 或 `chore`。类型决定分支主类型；选择创建 PR 时才决定 PR
主类型，并要求分支中至少有
一笔对应主类型提交；每笔提交标签按实际变更性质选择。不能用期限、负责人授权或已经投入的时间
代替需求确认与 Task 建档。

### 工作环境确认

Task 定义完成后固定询问用户选择当前工作区或独立 worktree。`current` 允许当前已有分支或
linked worktree，保留已有 dirty；但 detached HEAD 必须拒绝。选择 `worktree` 时基于本地
`main` 当前 HEAD 创建隔离环境，并安全携带已经完成的 Task 档案。

先在当前 primary checkout 建立并填写 Task。环境选择入口只在 `task.md` 完整、`requirements`
已终态且用户明确选择后运行：

```bash
node scripts/task-status.mjs init feature safe-login
# 将输出的 <task-id> 对应的 docs/tasks/<task-id>/task.md 填写完整

# 用户选择 current：保留当前工作区已有改动
bash .agents/skills/change-workflow/scripts/start-change.sh current <task-id>

# 用户选择 worktree：基于本地 main HEAD 创建隔离环境
bash .agents/skills/change-workflow/scripts/start-change.sh worktree <task-id>
```

`current <task-id>` 只登记当前工作区并开始 `design`，不创建分支或 worktree；`worktree <task-id>`
基于本地 `main` HEAD 创建隔离分支和 worktree，将启动前已形成的 Task 安全带入后开始 `design`。
两条入口都会输出 `TASK_ID=` 和 `TASK_DIR=`。若代码已经存在而工作区没有 Task，必须先用
`task-status init` 补建并填写，再选择环境。detached HEAD、缺少 Task 或无法确认工作区事实时
必须停止并报告，不能猜测或自动切换环境。

环境选择后必须记录实际环境事实：绝对工作区路径、`mode`、当前 branch、HEAD、dirty 状态和
dirty 文件数/范围、Task 目录及（worktree 模式）`base_commit`。`current` 的 `dirty_policy`
为 `preserve`；允许已有分支或 linked worktree，但不得覆盖无关改动。`worktree` 的
`dirty_policy` 为 `clean-required`，唯一例外是把未提交的 Task 档案转移后初始只允许该 Task
目录 dirty；执行计划开始后，sub-agent 只能修改 StagePacket 声明的 `allowed_paths`，其他 dirty
或越界变更必须停止并返回主 Agent。

```bash
node scripts/task-status.mjs check <task-id>
```

### 执行计划

spec、plan、research、短期验证输出和同机 handoff 默认放在当前 Task 的 `.work/`，不提交到 Git。
这些材料若形成跨需求长期有效的架构、安全、迁移或维护规则，必须升级到正式 guide、reference、
ADR 或设计文档。

执行计划内部固定覆盖：计划、二次审查、实现、代码审查、验证、有限自动修复和重验。计划与
二次审查属于 `design`，实现与代码审查属于 `implementation`，验证、有限修复和重验属于
`verification`。自动修复只允许处理验证证据明确指向、范围内且可逆的问题；达到轮次或停止
条件仍失败时必须记录 `blocking` 并交还用户。

每个工作单元使用最小 `StagePacket`，具体字段以 [protocol reference](../../.agents/skills/change-workflow/references/protocol.md)
为准，至少包含 `protocol_version`、`task`、`stage`、`work_unit`、`objective`、`workspace`、
`allowed_paths`、`inputs`、`acceptance` 和 `stop_conditions`；`StageResult` 必须返回
`protocol_version`、`task_id`、`stage`、`work_unit`、`outcome`、`recommendation`、`artifacts`、
`evidence`、`issues`、`decision_candidates`、`follow_up` 和 `next_action`。`outcome` 只能是
`completed`、`needs_repair`、`blocked` 或 `not_applicable`。sub-agent 不修改 `status.json`、
不创建环境、不执行交付动作。

#### 执行计划的状态与验证

`status.json` 只由 Task CLI 管理 schema 字段，只保存阶段、更新时间、PR 编号等客观结构化事实，
不保存主观判断或自由文本。原因猜测、风险判断、交接说明、备选方案、下一步建议不得写入 status；同机过程判断
写入明确命名的 `.work/` 文件，需要长期或跨环境保留的事实按上节升级。

Task 定义完成后将 `requirements` 标记为完成；用户选定工作环境后进入 `design`。按实际工作运行状态命令：

```bash
pnpm run task:status complete <task-id> design
pnpm run task:status start <task-id> implementation
# 对进行中的 implementation，默认完成；若确认无需实施，用下一行注释中的 skip 替代 complete
pnpm run task:status complete <task-id> implementation
# pnpm run task:status skip <task-id> implementation
pnpm run task:status start <task-id> verification
pnpm run task:status block <task-id> verification
pnpm run task:status resume <task-id> verification
pnpm run task:status complete <task-id> verification
pnpm run task:status start <task-id> consolidation
pnpm run task:status check <task-id>
```

每次验证保留实际命令和结果。Task CLI 的聚焦测试与仓库快速预检是：

```bash
pnpm run test:task-status
pnpm run test:preflight
pnpm run check:preflight
```

`pnpm run test:preflight` 运行紧凑的关键测试；`pnpm run check:preflight` 先增加全仓 Kit 架构审计。
它们提供快速反馈，不替代交付选择前应明确记录的最终门禁。

### 总结沉淀

总结阶段自动提取需求变化、用户决定、实现 diff、评审意见和验证证据中的 Decision Delta，分类
写入 `summary.md` 或正式 architecture、guide、ADR。必须输出 `blocking`、`non_blocking`、
`decision_candidates`、`follow_up` 四类发现项；只有 `blocking` 会阻止自动收口，其余类别不阻止
ready gate，但必须报告给用户。自动提取不等于自动批准，ADR 的 `accepted` 仍需要 approver
明确批准。

先更新完整 `summary.md`，写明验收完成情况、实际改动、决定、验证、影响、风险和遗留。`summary.md`
完整且内部 stages 终态后，先通过 `--ready-for-pr` ready gate：

```bash
pnpm run task:status complete <task-id> consolidation
pnpm run task:status check <task-id> --ready-for-pr
```

运行 ready gate 前还要人工检查决策闭环：仓库扫描及外部 memory 无命中、`partial`、`failed` 状态
是否有记录，
候选角色来源、负责范围和最终分工是否清楚，每条决策是否已有处置且角色反馈未被当作决策，实现和
测试证据是否可追溯，范围变化是否触发重检，Decision Delta 是否已分类并落到正确的正式文档，
以及反向检索是否能命中新落点；任何 skipped stage 是否仍有 Decision Context、Decision Delta 和
反向检索记录，其中确无适用决策或无增量的，是否明确记录“无适用项”或“无增量”及检索、分类和
验证证据。反向检索失败时不得完成闭环或通过人工语义检查，`consolidation`
必须保持 `in_progress` 或由执行者 `block`。当前 CLI 的 ready gate 只检查正式文件、Markdown
基本契约和五个内部 stages 的终态，不会自动判断上述语义、校验 skip 证据或自动阻塞反向检索失败。

完成实现和验证后必须停下，向用户报告分支、提交、Task 状态、验证命令和风险，并询问唯一的后续路径：
创建 PR、本地整合到 `main`，或暂不处理。选择路径本身不授权任何外部写入；每一次 push、创建或更新
PR、以及本地整合都要取得对应的明确授权。未得到选择前不得 push、创建 PR、merge、rebase、stash 或
reset。

选择创建 PR 时，依次确认要 push 的确切分支和 head，再单独取得 push 授权；push 成功后核对 base/head
身份，再单独取得创建或更新 PR 的授权。PR 创建后才用 `task:status set-pr` 记录正整数编号。打开的
PR 不代表完成，PR 的合并和 required checks 仍是后续独立的外部事实；不要把状态文件中的
`pullRequest: null` 当作失败。

选择本地 `main` 时，先让用户选择一种整合策略：`fast-forward`、merge commit 或 squash。之后针对
确定的源分支和 head、目标 `main`、策略取得独立整合授权，且不 push。整合前必须确认源和目标 worktree
都 clean、目标确实是本地 `main`、源分支包含待交付提交。远端状态可作为 push/PR 路径的事实记录，
但 `origin/main` 不是本地开发或整合的强制基线；不自动 pull、rebase、stash 或 reset。应使用等价的
只读冲突预检（例如 `git merge-tree --write-tree`）；出现冲突时停止并交还用户处理。

`fast-forward` 仅在 `main` 是源分支祖先时允许，命令为 `git merge --ff-only <source-branch>`，不提供
新的提交标题；merge commit 必须显式使用非快进策略，并提供符合提交规范的合法中文标题，例如
`git merge --no-ff -m "[Feature] 合并安全登录" <source-branch>`；squash 必须先执行
`git merge --squash <source-branch>`，再使用合法中文标题提交，例如 `git commit -m "[Feature] 添加安全登录"`。
三种策略都要记录源 head；merge commit 和 squash 还要记录整合前后 `main` head，不能假装源分支已成为
`main` 的祖先。整合后重新确认 `main` clean，并将三份 Task 文件和交付变更都核对在本地 `main`。

选择暂不处理时，不写入外部仓库事实，不宣称需求已完成；保留当前分支和 Task 证据，待用户再次选择。

审查若要求实质代码或行为变更，不能直接沿用旧验证和 summary。按受影响范围回退
implementation、verification 或 consolidation，例如：

```bash
pnpm run task:status rewind <task-id> implementation
```

之后重新实现、验证、更新 `summary.md`、完成各 stages，并再次运行 ready gate，再重新询问交付路径。

### 交付处理

创建 PR 或通过 ready gate 只代表收口已提交，不代表 Task/任务完成。PR 路径的完成仍必须同时满足：

- 所有内部 stages 终态；
- `status.json` 已记录 PR 号；
- GitHub PR 状态为 merged；
- PR latest head commit 的 repository-required checks 成功；
- `task.md`、`status.json`、`summary.md` 三份正式文件都已在 `main`。

本地 `main` 路径不要求 PR 号：当所有内部 stages 终态、三份 Task 文件和交付变更已在本地 `main`、
且 `main` clean 时即可宣布本地整合完成，`pullRequest` 保持 `null` 是有效结果。它不代表远端 `main`
已更新，也不授权 push。全部对应事实成立后才能归档当前 Codex 会话；不要为了归档制造额外提交。

## Task 恢复与交接

同机跨会话恢复时，先读 `task.md` 和 `status.json`，再读 `.work/` 中必要的 plan、research、handoff，
最后核对 Git branch/status/log/diff。本地恢复完成之后才查询 GitHub 的 PR open/merged/checks 实时
事实；GitHub 是这些状态的权威源，不把易变状态复制进 `status.json`。status 只帮助定位阶段，恢复时
不猜测，也不重做已有证据证明完成的工作。

跨机或跨环境交接不能依赖 `.work/`。把已验证且长期有效的客观事实升级到 `task.md`、`summary.md`
或正式 docs。未验证的主观猜测必须明确标注，并使用经授权的非 status 交接渠道，不得伪装成结构化
事实。

## 环境准备

- Node.js 22.12 或更高版本；
- pnpm 9 或更高版本；
- 安装原生 `better-sqlite3` 所需的平台工具。

如果 pnpm 安装的依赖没有适配当前 Node/平台的 `better-sqlite3` 预编译包，还需要 Python、C/C++
编译工具链和系统构建工具。

```bash
pnpm install
```

仓库使用 pnpm workspaces：

- `packages/*`；
- `kits/*`；
- `plugins/*`。

## 启动 Web 工作台

开发时运行：

```bash
pnpm dev
```

`pnpm dev` 启动 Gateway、Server 和 Client 三个开发进程：Gateway 与 Server 使用 `tsx watch` 监听源码，Client 使用 Vite 提供 HMR。浏览器应访问 Gateway `http://localhost:49380`，由它将 API 和 SSE 路由到 Server，不要将 Vite 端口当作完整应用入口。

Web 栈运行统一 Kit host，裸地址显示 Kit 选择页，并提供开发直达地址：

```text
Kit 选择页   http://localhost:49380/
任意 Kit     http://localhost:49380/kits/<name>
```

界面或 Kit 行为变更应使用浏览器完成最终验收。仓库不再包含桌面 host、托盘、原生窗口或打包链路。

`/?kit=<package-name>` 仍是兼容的直接入口。省略 session 时客户端会为该 Kit 创建新 session；
已有 session 首次初始化后以其已加载 Kit 为准，不能通过替换 URL 中的 `kit` 隐式切换。

自动化 Web Host smoke 使用 Framework 提供的 `scripts/lib/web-host-runner.mjs` 生命周期 runner：它为
Gateway、Server、Client 分配隔离端口，创建临时数据根，注入明确的 Kit sources/default Kit，轮询
`/api/health`，收集有限日志并在 finally 中清理进程和临时目录。runner 只管理进程、健康检查和清理，不包含
任何 Kit、Panel、对话或页面业务断言；完整 Web Host smoke 的业务测试仍归目标 Kit。

Plugin runtime 和 Kit assembly 测试使用 `@itharbors/server/testing` 的公开 testing export，其中
`createPluginRuntimeHarness` 只加载一个真实 Plugin，`createKitAssemblyHarness` 加载真实 Kit 的全部声明
Plugin。Kit 测试不得 import `packages/server/src/**`、`packages/server/tests/**` 等 Framework 私有源码，也不
应直接操作 `createEditor`。测试使用 harness 提供的外部 request/broadcast/能力 double 和 message observer，
按[统一测试指南](./testing.md)记录真实消息顺序。

开发脚本还会列出：

- `/`：Kit 选择页；
- `/?page=layout-kit`：布局组件示例；
- `/?page=ui-kit`：基础 UI 示例。

## 指定 Kit

```bash
pnpm dev -- --kit ./kits/<name>
pnpm dev -- --kit <package-name>
```

`--kit`、`--kit-path` 和 `--kitPath` 都被 Web 开发脚本接受。路径必须包含有效 package；
package name 必须能在 Kit 目录中找到。外部路径会临时追加到 Catalog，开发脚本会打印
`Requested Kit` 直达地址。稳定的单进程 Web 入口需先生成构建资产，随后使用：

```bash
pnpm run build
pnpm start
```

`pnpm start` 只启动 Server，直接提供已构建的 Client 资产，不包含 Gateway、源码监听或 HMR。

## 构建

```bash
pnpm run build
```

根构建顺序：

1. `@itharbors/magnet` 插件核心；
2. `@itharbors/plugin-types` 浏览器与宿主共享协议；
3. Kit Core 与 Kit CLI；
4. Client、Server 等 Framework workspace；
5. 所有插件。

插件可以单独处理：

```bash
node scripts/ce-plugin.mjs build plugins/menu
node scripts/ce-plugin.mjs check plugins/menu
node scripts/ce-plugin.mjs build kits/<name>/plugins/<plugin>
node scripts/ce-plugin.mjs check kits/<name>/plugins/<plugin>

pnpm run plugins:build
pnpm run plugins:check
```

`build` 会重建目标 `dist/`；单目录 `check` 要求产物已经存在，只做 manifest 与文件校验。
根 `plugins:check` 先检查 Framework 插件，再在隔离副本中构建每个发现到的 Kit，既保留全量语义，
也不会要求源码树预先保存非 builtin Kit 的 `dist/`。Framework CI 使用更窄的
`pnpm run plugins:check:framework`。

Kit 的运行时测试如果需要创建真实 Editor，只能从 `@itharbors/server/testing` 使用稳定的窄测试入口；
隔离 runner 会提供对应 Framework toolchain。不要相对导入 `packages/server/src/**`，也不要借用
其他 Kit 目录作为测试夹具。

## 测试

测试按受影响的功能单元边界选择，不要默认运行全仓测试。完整的测试分层、放置约定和命令见
[统一测试指南](./testing.md)。

按变更范围选择对应命令：

- Framework 包级测试：

  ```bash
  pnpm --filter @itharbors/server run test
  pnpm --filter @itharbors/client run test
  ```

  只运行单个测试文件时，从对应 workspace 执行，避免根目录 Vitest 同时发现 Server 与 Client
  两套环境：

  ```bash
  pnpm --filter @itharbors/client run test -- tests/core/transport.test.ts
  pnpm --filter @itharbors/server run test -- tests/framework/message.test.ts
  ```

- 单个 Plugin 构建与校验：

  ```bash
  node scripts/ce-plugin.mjs build plugins/<name>
  node scripts/ce-plugin.mjs check plugins/<name>
  ```

- 单个 Kit 构建与校验（可传 slug）：

  ```bash
  pnpm run kits:test <slug>
  pnpm run kits:check <slug>
  ```

全仓测试 `pnpm test` 会依次运行 Framework、所有 Kit 和 workflow 测试；它不是局部 Plugin 或
Kit 验证的默认要求。Client 的 test script 会先 typecheck，再通过包装脚本
从 Client workspace 运行 Vitest。Server 集成测试需要打开本机临时端口；在严格沙箱中可能因
监听权限失败。

局部验证按变更边界选择：只修改单个 Plugin 时选择该 Plugin 的测试（若有）以及构建与产物校验；
只修改 Kit 根配置或跨 Plugin 装配时选择目标 Kit 的验证；只修改 Framework 时选择受影响的
Framework 测试。跨边界变更取这些范围的并集，不因局部变更自动扩大到全仓。

## 清理

```bash
pnpm run clean
```

会删除可再生内容：

- Client、Server、plugin-types 的 `dist/`；
- `plugins/*` 和 `kits/*/plugins/*` 的 main/panel `dist/`；
- coverage、Vite/Vitest cache 和 `*.tsbuildinfo`。

Server 开发入口默认把 SQLite 文件写到 Server workspace 的 `.editor.db`。该文件及
`-shm`、`-wal` 是本地运行状态，不属于 clean 脚本的构建产物清单。

## 端口冲突

先确认隔离开发端口的占用者：

```bash
lsof -i :49380
lsof -i :49381
lsof -i :49382
```

仓库提供 `pnpm run kill`，但它会对这三个开发端口上的所有进程发送 `SIGKILL`。
只有确认进程确属本项目后才使用。

可用 `HARBORS_GATEWAY_PORT`、`HARBORS_SERVER_PORT` 和 `HARBORS_CLIENT_PORT` 分别覆盖
Gateway、Server 和 Client 端口。每个值必须是 1–65535 的整数，且三个端口不得重复。

## 常见失败

### `Plugin "... " not found`

- 核对 package `name`；
- 核对插件位于 `plugins/*` 或当前 Kit 的 `plugins/*`；
- 确认目录直接包含 `package.json`，resolver 不递归扫描任意深度。

### main 或 panel entry 不符合 dist 约定

先运行目标插件 build，再检查 manifest：

- main 指向 `main/dist/*.js`；
- panel entry 指向 `panel.<name>/dist/index.html`；
- 路径不能离开插件根目录。

### `Kit "... " not found`

- 路径写法必须是明显路径或有效 Kit package name；
- Kit 根目录必须含 `package.json` 和 `ce-editor.kit`；
- package name、目录名至少一个与请求值匹配。

### bootstrap 失败

先检查对应入口的 Gateway health 地址（隔离开发默认是 `http://localhost:49380/api/health`），再看 Server 日志中的 Kit/插件装载错误。
Client 会尝试创建 session 并重试一次，但不会掩盖持续装载错误。

## Framework 与 Kit 的单主分支治理

Framework 和官方 Kit 都通过 `main` 集成，统一使用 change-workflow，按变更对象调整检查范围：

| 变更对象 | 本地开发基线 / PR base | 隔离分支（选择 worktree 时） | 本地 Skill |
| --- | --- | --- | --- |
| Framework | 本地 `main` / `main` | `<type>/<slug>` | `change-workflow` |
| 单个 Kit | 本地 `main` / `main` | `<type>/<slug>` | `change-workflow` |

每个 Kit 保存在自己的 `kits/<name>` 功能单元中；根工作流按 descriptor 发现，不维护产品清单。Kit 只在本地开发与打包。PR 合并仅更新源码，不会自动创建制品、发布版本、递增版本、创建 Release Tag 或更新 Registry。完整生命周期是：

```text
main
  -> <type>/<slug>
  -> PR base main
  -> PR updates the affected Kit source and descriptors as needed
  -> merge to main updates source only
```

Kit 变更使用 change-workflow，与 Framework 共享同一套 Task 合约。先创建并填写 Task，再由用户
选择 `current` 或 `worktree`：

```bash
node scripts/task-status.mjs init feature add-import
# 填写 docs/tasks/<task-id>/task.md 后，按用户选择执行其一：
bash .agents/skills/change-workflow/scripts/start-change.sh current <task-id>
bash .agents/skills/change-workflow/scripts/start-change.sh worktree <task-id>
```

`current` 保留已有改动，不创建分支或 worktree；`worktree` 才基于本地 `main` 当前 HEAD 创建隔离
分支与 worktree。完成实现和验证后，先按上面的交付选择停下；若用户选择 PR，再分别取得 push 和创建/更新
PR 的授权，并准备含 `## Summary` 与 `## Testing` 的 body。若用户选择本地 `main`，按确认的
fast-forward、merge commit 或 squash 策略整合，且不 push。路径级 CI 至少检查被修改的 Kit；Kit CLI
或其他共享构建面变化会触发所有官方 Kit CI。

若修改 Kit 的版本，必须同步 `kit.json`、`package.json` 和 `pnpm-lock.yaml`；版本一致性由本地校验保证，但普通开发变更不要求递增版本。需要制品时，在本地运行 validate、pack 和 inspect。

## 提交信息规范

提交标题必须匹配：

```text
^\[(Init|Feature|Bug|Docs|Refactor|Optimize|Test|Chore)\] .+
```

| 类型 | 使用范围 |
| --- | --- |
| `[Init]` | 仅用于仓库初始化 |
| `[Feature]` | 新功能，以及随功能一起交付的测试和文档 |
| `[Bug]` | 修复错误、回归或不符合预期的行为 |
| `[Docs]` | 不伴随行为变化的独立文档修改 |
| `[Refactor]` | 不改变预期行为的结构和维护性调整 |
| `[Optimize]` | 性能和资源使用优化 |
| `[Test]` | 不伴随产品行为变化的独立测试建设 |
| `[Chore]` | 依赖、构建工具和日常维护 |

例如：`[Feature] 添加用户登录`、`[Bug] 修复连接泄漏`、`[Docs] 完善开发指南`、
`[Refactor] 拆分插件加载器`、`[Optimize] 减少查询内存占用`、`[Test] 补充工作流回归测试`、
`[Chore] 更新构建依赖`。类型大小写必须与表格完全一致；摘要使用简洁中文，末尾不加
句号。每个提交只表达一个可审查的逻辑改动。

通用变更分支的主类型决定 PR 标题，并要求分支中至少有一笔对应主类型提交。每笔提交仍按它
实际包含的变更选择标签：例如 `feature/*` 开发中发现并修复的缺陷使用 `[Bug]`，独立回归覆盖
使用 `[Test]`，配套文档使用 `[Docs]`，构建维护使用 `[Chore]`。这样既保留 PR 的主目标，也让
提交历史真实反映每个可审查改动。`[Init]` 仍只允许仓库初始化；合法标签不能替代变更范围审查，
与当前 PR 无关的产品行为仍应使用独立变更分支。

## 提交前最小检查

提交前检查按受影响边界选择，不要对所有局部变更默认执行 Framework 全量测试。完整分层与
命令见[统一测试指南](./testing.md)。

`pnpm run check` 是当前全仓最终门禁，不作为局部 Plugin、Kit 或 Framework 开发的默认检查。
它只构建一次 Framework，再运行 Framework 与 workflow 测试，并以一次 `kits:check` 完成所有
Kit 的 build、test、validate 和本地产物检查，最后检查 Framework 插件产物。交付选择前应由 Agent
明确运行并记录这项门禁；这里的
Framework 测试是全仓门禁的组成部分，不改变局部 Plugin/Kit 验证要求。

需求开发循环优先运行聚焦测试和紧凑预检：

```bash
pnpm run check:preflight
```

预检执行全仓 Kit 架构审计和关键 workflow/元数据测试，成功时使用紧凑 reporter；它用于快速
反馈，不替代 `pnpm run check`。

按变更范围选择对应的最小检查：

- 仅修改 Framework 包：运行受影响包的测试，例如 `pnpm --filter @itharbors/server run test`、
  `pnpm --filter @itharbors/client run test`。
- 仅修改单个 Plugin：若有 Plugin 测试则显式运行；并按需执行构建与产物校验，例如
  `node scripts/ce-plugin.mjs build plugins/<name>` 后
  `node scripts/ce-plugin.mjs check plugins/<name>`。这两个 `ce-plugin` 命令不执行 Plugin
  测试或 runtime smoke。仓库没有根级统一的 `pnpm run test:plugin`，但 Agent Chat Kit 已声明并运行
  `pnpm --dir kits/agent-chat run test:plugin`。
- 仅修改单个 Kit：运行该 Kit 的构建与校验，例如 `pnpm run kits:test <slug>`、
  `pnpm run kits:check <slug>`。各 Kit 的 `test` script 以实际 package.json 为准；Agent Chat 的
  `test:kit` 已串联 descriptor validate、Plugin runtime smoke 和 Kit assembly，不应把 Default Kit 的
  validate-only 脚本推广为所有 Kit 的语义。

分层测试的当前聚焦命令如下：

- Framework runtime harness：`pnpm --filter @itharbors/server exec vitest run tests/framework/testing-harness.test.ts`。
  它验证 harness 的真实单 Plugin / Kit fixture、外部消息注入和 dispose 契约；这是 Framework 工具测试，不是
  Agent Chat 业务 smoke。
- Framework Web Host runner：`node --test scripts/lib/web-host-runner.test.mjs`。它只验证三进程启动、健康检查、
  隔离环境、日志和清理，不是 Kit 业务 smoke，也不代表浏览器中的 Kit 业务行为已通过。
- Agent Chat Plugin runtime smoke：`pnpm --dir kits/agent-chat run test:plugin`，真实加载 Conversation Plugin，
  只模拟 Plugin 外 request/broadcast。
- Agent Chat Kit assembly：`pnpm --dir kits/agent-chat run test:assembly`，通过公开 testing harness 加载全部
  声明 Plugin，验证真实组合 request/broadcast，不包含 Web Host 或浏览器交互。
- Agent Chat Kit test：`pnpm --dir kits/agent-chat run test:kit`，依次执行 validate、`test:plugin` 和
  `test:assembly`。
- Agent Chat HTTP smoke：`pnpm --dir kits/agent-chat run smoke`，启动真实 Gateway、Server、Client 并验证公开
  HTTP health、Kit catalog、redirect 和页面 HTML；它不执行浏览器点击或页面交互。
- Kit `test`：`pnpm run kits:test <slug>` 先构建 toolchain 和目标 Kit，再执行 Kit 声明的 `test` script。
  Kit `smoke` 是可选的声明脚本，只在 `pnpm run kits:check <slug>` 的适用阶段运行；Agent Chat 已声明该脚本，
  其他 Kit 是否有 smoke 以各自 descriptor 为准。

Vitest 必须使用目标 package 作为运行根或显式指定目标测试文件；禁止把仓库 `.worktrees/` 作为测试根或发现路径。
从仓库根启动的配置必须显式排除 `**/.worktrees/**`。测试证据要区分 `test`、可选 `smoke` 和组合的 `check`，
并记录实际退出结果。Agent Chat HTTP smoke 已通过公开 HTTP 验证；浏览器验收另行确认 13/13 声明 Plugin 均加载且
无 console error，不得把两者混写，也不得把 Framework runner contract 测试写成业务 smoke。

`pnpm run kits:boundary` 会独立审计完整源码树；`pnpm run kits:boundary <slug>` 只审计
目标 Kit，不会被无关 Kit 的临时损坏拖累。审计禁止跨 Kit 源码引用、Kit 外本地依赖、缺失
lockfile、Framework 产品特判和静态产品清单。

通用变更应在交付选择前按受影响范围运行最终门禁，并将命令和结果写入 `summary.md`；不要在没有新
代码变化时先手动重复同一轮全量检查。修改架构行为时同步检查
[文档维护指南](./maintaining-docs.md)。
