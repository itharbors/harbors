# 开发工作流

本指南以仓库根目录为工作目录，覆盖当前 workspace 的安装、启动、构建、测试和排查。
架构背景见[系统架构](../architecture/system-overview.md)。

## Task 驱动的六阶段开发

所有可交付的 Framework 或 Kit 变更都使用一个 [Task 档案](../tasks/README.md)，依次经过以下
六个阶段。Task 的三份正式文件是需求快照 `task.md`、机器状态 `status.json` 和收口总结
`summary.md`；本机过程材料放在默认不提交的 `.work/`。

### 1. 需求确认与分类

开始实现前确认背景、目标、范围、非目标、验收标准和约束，再选择一种类型：`feature`、`bug`、
`optimize`、`docs`、`refactor`、`test` 或 `chore`。类型决定分支与 PR 主类型，并要求分支中至少有
一笔对应主类型提交；每笔提交标签按实际变更性质选择。不能用期限、负责人授权或已经投入的时间
代替需求确认与 Task 建档。

### 2. Task 建档

从 primary checkout 运行适合变更对象的 start workflow。Framework 变更使用：

```bash
bash .agents/skills/change-workflow/scripts/start-change.sh feature safe-login
```

独立 Kit 变更使用：

```bash
bash .agents/skills/kit-workflow/scripts/start-kit-change.sh <name> feature safe-login
```

两种 start 脚本都会基于 `origin/main` 创建隔离分支与 worktree，并自动运行 Task init，输出
`TASK_ID=` 和 `TASK_DIR=`。进入输出的 worktree 后立即把已确认需求完整写入 `task.md`。如果代码
已经存在而分支上没有 Task，必须先补建并填写，再继续或 finish；可在该 worktree 运行真实 CLI：

```bash
npm run task:status -- init feature safe-login
```

### 3. 设计与计划

spec、plan、research、短期验证输出和同机 handoff 默认放在当前 Task 的 `.work/`，不提交到 Git。
这些材料若形成跨需求长期有效的架构、安全、迁移或维护规则，必须升级到正式 guide、reference、
ADR 或设计文档。

### 4. 实现与验证

`status.json` 只由 Task CLI 管理 schema 字段，只保存阶段、更新时间、PR 编号等客观结构化事实，
不保存主观判断或自由文本。原因猜测、风险判断、交接说明、备选方案、下一步建议不得写入 status；同机过程判断
写入明确命名的 `.work/` 文件，需要长期或跨环境保留的事实按上节升级。

初始 Task 已将 requirements 标记为完成并进入 design。按实际工作运行状态命令：

```bash
npm run task:status -- complete <task-id> design
npm run task:status -- start <task-id> implementation
# 对进行中的 implementation，默认完成；若确认无需实施，用下一行注释中的 skip 替代 complete
npm run task:status -- complete <task-id> implementation
# npm run task:status -- skip <task-id> implementation
npm run task:status -- start <task-id> verification
npm run task:status -- block <task-id> verification
npm run task:status -- resume <task-id> verification
npm run task:status -- complete <task-id> verification
npm run task:status -- start <task-id> consolidation
npm run task:status -- check <task-id>
```

每次验证保留实际命令和结果。Task CLI 的聚焦测试与仓库快速预检是：

```bash
npm run test:task-status
npm run test:preflight
npm run check:preflight
```

`npm run test:preflight` 运行紧凑的关键测试；`npm run check:preflight` 先增加全仓 Kit 架构审计。
它们提供快速反馈，不替代 finish 所运行的最终门禁。

### 5. 收口与 PR

先更新完整 `summary.md`，写明验收完成情况、实际改动、决定、验证、影响、风险和遗留。`summary.md`
完整且内部 stages 终态后，必须通过 `--ready-for-pr` ready gate：

```bash
npm run task:status -- complete <task-id> consolidation
npm run task:status -- check <task-id> --ready-for-pr
```

提交全部变更、保持 worktree clean，并在仓库外准备包含 `## Summary` 和 `## Testing` 的 body 文件。
Framework 和 Kit 分别使用现有 finish 脚本：

```bash
bash .agents/skills/change-workflow/scripts/finish-change.sh \
  "添加安全登录" /absolute/path/to/pr-body.md

bash .agents/skills/kit-workflow/scripts/finish-kit-change.sh \
  <name> "添加安全登录" /absolute/path/to/pr-body.md
```

finish 会重新执行 ready gate 和各自边界检查，只创建或恢复当前仓库拥有且 base/head 身份一致的 open PR；同名 fork PR 不会被编辑或记录。已记录 PR 关闭且未合并时可安全替换并更新编号，已合并或身份不符时 fail closed。finish 在 PR body 添加指向 pre-PR
commit 上 `summary.md` 的不可变链接，回写 PR 编号，自动提交该 status 变化并二次 push。第一次调用在
PR 创建后失败时，修复外部原因后重跑相同 finish 命令；它只恢复已验证的 open PR 和精确的自动
status 写回状态，不把其他 dirty changes 当作可恢复状态。

审查若要求实质代码或行为变更，不能直接沿用旧验证和 summary。按受影响范围回退
implementation、verification 或 consolidation，例如：

```bash
npm run task:status -- rewind <task-id> implementation
```

之后重新实现、验证、更新 `summary.md`、完成各 stages，并再次运行 ready gate 与 finish。

### 6. 合并确认与会话归档

`PR_URL=` 或 PR 已创建只代表收口已提交，不代表 Task/任务完成。完成是派生事实，必须同时满足：

- 所有内部 stages 终态；
- `status.json` 已记录 PR 号；
- GitHub PR 状态为 merged；
- PR latest head commit 的 repository-required checks 成功；
- `task.md`、`status.json`、`summary.md` 三份正式文件都已在 `main`。

全部成立后才能宣布需求完成并归档当前 Codex 会话。不要为了会话归档制造 merge 后 commit；用户
要求“完成”也不授权 Agent 主动 merge PR。

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
- npm 9 或更高版本；
- 安装原生 `better-sqlite3` 所需的平台工具。

如果 npm 没有适配当前 Node/平台的 `better-sqlite3` 预编译包，还需要 Python、C/C++
编译工具链和系统构建工具。

```bash
npm install
```

仓库使用 npm workspaces：

- `packages/*`；
- `kits/*`；
- `plugins/*`。

## 启动 Web 工作台

开发时运行：

```bash
npm run dev
```

`npm run dev` 等同于 `npm run dev:web`，并行启动 Gateway、Server 和 Client。浏览器应访问
Gateway `http://localhost:49380`，由它将 API 和 SSE 路由到 Server，不要将 Vite 端口当作完整应用入口。

Web 栈运行统一 Kit host，裸地址显示 Kit 选择页，并提供开发直达地址：

```text
Kit 选择页   http://localhost:49380/
任意 Kit     http://localhost:49380/kits/<name>
```

界面或 Kit 行为变更应使用浏览器完成最终验收。仓库不再包含桌面 host、托盘、原生窗口或打包链路。

`/?kit=<package-name>` 仍是兼容的直接入口。省略 session 时客户端会为该 Kit 创建新 session；
已有 session 首次初始化后以其已加载 Kit 为准，不能通过替换 URL 中的 `kit` 隐式切换。

开发脚本还会列出：

- `/`：Kit 选择页；
- `/?page=layout-kit`：布局组件示例；
- `/?page=ui-kit`：基础 UI 示例。

## 指定 Kit

```bash
npm run dev -- --kit ./kits/<name>
npm run dev -- --kit <package-name>
```

`--kit`、`--kit-path` 和 `--kitPath` 都被 Web 开发脚本接受。路径必须包含有效 package；
package name 必须能在 Kit 目录中找到。外部路径会临时追加到 Catalog，开发脚本会打印
`Requested Kit` 直达地址。稳定的单进程 Web 入口为：

```bash
npm run build
npm start
```

## 构建

```bash
npm run build
```

根构建顺序：

1. `@itharbors/plugin-types`；
2. Client TypeScript 与 Vite；
3. Server TypeScript；
4. 所有插件。

插件可以单独处理：

```bash
node scripts/ce-plugin.mjs build plugins/menu
node scripts/ce-plugin.mjs check plugins/menu
node scripts/ce-plugin.mjs build kits/<name>/plugins/<plugin>
node scripts/ce-plugin.mjs check kits/<name>/plugins/<plugin>

npm run plugins:build
npm run plugins:check
```

`build` 会重建目标 `dist/`；单目录 `check` 要求产物已经存在，只做 manifest 与文件校验。
根 `plugins:check` 先检查 Framework 插件，再在隔离副本中构建每个发现到的 Kit，既保留全量语义，
也不会要求源码树预先保存市场 Kit 的 `dist/`。Framework CI 使用更窄的
`npm run plugins:check:framework`。

Kit 的运行时测试如果需要创建真实 Editor，只能从 `@itharbors/server/testing` 使用稳定的窄测试入口；
隔离 runner 会提供对应 Framework toolchain。不要相对导入 `packages/server/src/**`，也不要借用
其他 Kit 目录作为测试夹具。

## 测试

```bash
npm test
```

根测试先运行 Server，再运行 Client。也可分包执行：

```bash
npm run test -w packages/server
npm run test -w packages/client
```

Client 的 test script 会先 typecheck，再通过包装脚本从 Client workspace 运行 Vitest。
Server 集成测试需要打开本机临时端口；在严格沙箱中可能因监听权限失败。

只运行单个测试文件时，应从对应 workspace 或使用它的配置，避免根目录 Vitest 同时发现
Server 与 Client 两套环境：

```bash
npm run test -w packages/client -- tests/core/transport.test.ts
npm run test -w packages/server -- tests/framework/message.test.ts
```

## 清理

```bash
npm run clean
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

仓库提供 `npm run kill`，但它会对这三个开发端口上的所有进程发送 `SIGKILL`。
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

Framework 和官方 Kit 都通过 `main` 集成，但使用不同的本地 Skill 和检查范围：

| 变更对象 | 基线 / PR base | 变更分支 | 本地 Skill |
| --- | --- | --- | --- |
| Framework | `origin/main` / `main` | `<type>/<slug>` | `change-workflow` |
| 单个 Kit | `origin/main` / `main` | `kit-change/<name>/<type>/<slug>` | `kit-workflow` |

每个 Kit 保存在自己的 `kits/<name>` 功能单元中；根工作流按 descriptor 发现，不维护产品清单。
市场 Kit 的开发 PR 同时携带版本升级；PR 合并即发布授权。自动化只发布发生版本变化的市场 Kit，不修改或发布
Framework 版本。合并后工作流会自动创建对应的不可变 Kit Tag。完整生命周期是：

```text
main
  -> kit-change/<name>/<type>/<slug>
  -> PR base main
  -> PR updates kits/<name>/kit.json, kits/<name>/package.json, and kits/<name>/package-lock.json
  -> merge to main authorizes publication
  -> automatically create kit/<name>/v<semver>
  -> publish immutable GitHub Release and refresh Registry
```

开始某个 Kit 的变更：

```bash
bash .agents/skills/kit-workflow/scripts/start-kit-change.sh <name> feature add-import
```

该命令固定获取 `origin/main` 并校验仓库本地 Git 身份，然后创建隔离 worktree、执行根目录
`npm ci`，再完整校验官方 Kit 契约。只在输出的 worktree 中开发。完成后准备含 `## Summary`
与 `## Testing` 的 PR body，再运行：

```bash
bash .agents/skills/kit-workflow/scripts/finish-kit-change.sh \
  <name> "添加数据导入" /absolute/path/to/pr-body.md
```

finish 只运行目标 Kit 的 `npm run kit:check -- <name>`，普通 push 后创建并核验 base 为 `main`
的 PR。路径级 CI 至少检查被修改的 Kit；`kit-core`、Kit CLI、发布/Registry 工具或其他共享
构建面变化会触发所有官方 Kit CI。

开发 PR 必须同步更新目标目录的 `kit.json`、`package.json` 和 `package-lock.json`，三处使用同一个严格
递增的规范 SemVer。Kit CI 会在 PR 和 merge queue 中展示将创建的 Tag；合并到 `main` 后，自动工作流先完整
校验所有候选，再逐个创建 Tag 并显式调度发布。Preview 直接发布，Stable 继续经过 `kit-stable` Environment
审批。已有 Tag 或 Release 不会被移动、覆盖或删除。

`release-kit.sh` 只保留为自动 Tag 缺失时的人工恢复入口。恢复前确保本地干净 `main` 与 `origin/main`
完全一致，再运行：

```bash
bash .agents/skills/kit-workflow/scripts/release-kit.sh <name> 1.2.0
```

第一次运行只显示 Kit、版本、频道、Commit、Tag 和精确的 `Tag@40-char-SHA` 确认令牌，不创建
Tag。获得用户对恢复操作的明确确认后，按输出设置 `HARBORS_KIT_RELEASE_CONFIRM` 重跑。普通 SemVer
发布 Stable，带 prerelease 段的 SemVer 发布 Preview；build metadata 不允许用于发布 Tag。恢复流程也不得
替换已有 Tag 或不可变 Release。

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

根检查是有限时长命令，不会启动开发服务器：

```bash
npm run check
```

它只构建一次 Framework，再运行 Framework 与 workflow 测试，并以一次 `kits:check` 完成所有
Kit 的 build、test、validate 和市场产物检查，最后检查 Framework 插件产物。独立的 `npm test`、
`kits:test` 与 `plugins:check` 仍保留各自的完整语义，但根门禁不会重复组合它们。

需求开发循环优先运行聚焦测试和紧凑预检：

```bash
npm run check:preflight
```

预检执行全仓 Kit 架构审计和关键 workflow/元数据测试，成功时使用紧凑 reporter；它用于快速
反馈，不替代 `npm run check`。通用变更提交完成后直接调用 `finish-change.sh`，由完成流程运行
最终全量门禁；不要在没有新代码变化时先手动重复同一轮全量检查。

`npm run kits:boundary`
会独立审计完整源码树；`npm run kits:boundary -- <slug>` 只审计目标 Kit，不会被无关 Kit 的临时损坏拖累。
审计禁止跨 Kit 源码引用、Kit 外本地依赖、缺失 lockfile、Framework 产品特判和静态产品清单。
按变更范围快速
迭代时可拆分执行，但提交前不要少于：

```bash
npm run kits:boundary
npm run test -w packages/server
npm run test -w packages/client
npm run plugins:check
git diff --check
```

修改插件时先 `plugins:build` 再 `plugins:check`。修改架构行为时同步检查
[文档维护指南](./maintaining-docs.md)。
