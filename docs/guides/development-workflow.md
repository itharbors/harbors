# 开发工作流

本指南以仓库根目录为工作目录，覆盖当前 workspace 的安装、启动、构建、测试和排查。
架构背景见[系统架构](../architecture/system-overview.md)。

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

## 启动 Electron 多 Kit 工作台

`npm run start` 是稳定 Electron 入口；`npm run electron` 保留为兼容入口：

```bash
npm run start
```

它只加载显式内置 Kit，以及 `<userData>/kit-store` 中已经安装并激活的商城 Kit，不扫描仓库中的
普通开发 Kit。启动后只显示系统托盘图标，不会自动打开默认 Kit。单击或右键托盘图标，从列表选择
当前可用 Kit；首次
选择会按需创建稳定 session、独立窗口和插件/Panel/消息管线，之后再次选择只会打开或聚焦
已有窗口。

`npm run dev` 启动隔离开发 Electron，可与稳定实例并行运行：

```bash
npm run dev
```

开发入口使用同一套来源解析，但额外加载仓库 `kits/*` 中所有合法 Kit，因此可以直接联合调试
descriptor 发现的全部合法 Kit，不需要先从市场安装。开发源码与 active 商城 Kit
同 ID 时只在当前开发进程中临时使用源码，不修改 `installed.json`。

两种 Electron 入口分别启动以下 Web 开发服务：

脚本并行启动：

| 服务 | 稳定 Electron | 隔离开发 Electron | 说明 |
| --- | --- | --- | --- |
| Gateway | `http://localhost:48380` | `http://localhost:49380` | 对外统一入口 |
| Server | `http://localhost:48381` | `http://localhost:49381` | API、SSE 与运行时 |
| Client | `http://localhost:48382` | `http://localhost:49382` | Vite 开发服务 |
| Notification Host | `127.0.0.1:48383` | `127.0.0.1:49383` | 本机通知与桌面提示 |

需要浏览器调试入口时显式运行：

```bash
npm run dev:web
```

浏览器访问 Gateway，而不是直接访问 Vite。`npm run dev:web` 默认使用隔离开发端口，因此访问
`http://localhost:49380`；Gateway 才能把 API 和 SSE 路由到 Server。

Web 栈始终运行统一 Kit 主机，裸地址显示 Kit 选择页，并提供开发直达地址：

```text
Kit 选择页   http://localhost:49380/
任意 Kit     http://localhost:49380/kits/<name>
```

### Kit Web 优先、桌面能力按需验收

普通 Kit 的开发、调试和最终验收默认使用 `npm run dev:web` 与浏览器。只要改动在 Web 与 Electron
中共享实现，浏览器验收即可作为该改动的界面验收证据，无需再执行统一的 Electron 收口。

涉及系统托盘、BrowserWindow 生命周期、原生对话框、桌面 IPC、通知、自动更新、打包、操作系统
集成，或明确修改 Web 与 Electron 不同的控件、入口或行为时，必须使用 Electron 开发或完成补充
验收。同时影响共享 Kit 行为和桌面专属行为时，分别验证浏览器共享路径与 Electron 专属路径。
普通 Kit 可以自愿执行 Electron 冒烟检查，但它不是统一门禁。

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

`--kit`、`--kit-path` 和 `--kitPath` 都被开发 Electron 启动脚本接受。指定参数代表已经显式
选择 Kit：服务就绪后只自动创建该 Kit 的窗口，其他 Kit 仍保留在 Tray 中并继续懒加载。
Electron 窗口统一使用多 Kit 聚合菜单。路径必须包含有效 package；package name 必须能在
Kit 目录中找到。外部路径会临时追加到 Catalog。Web 裸地址 `/` 始终显示选择页；开发脚本
额外打印 `Requested Kit` 直达地址，供内置浏览器打开。

## Electron

```bash
npm run start
```

`npm run start` 是稳定桌面入口，`npm run electron` 为兼容入口，使用 Gateway 48380、Server 48381、Client 48382 和 Notification Host 48383。`npm run dev` 是
隔离开发入口，使用 Gateway 49380、Server 49381、Client 49382 和 Notification Host 49383。Electron 先显示托盘，再启动
`npm run dev:web` 子进程；选择 Kit 后会等待 Gateway 就绪再创建 BrowserWindow，不会递归
启动桌面宿主。传给 Electron 的 Kit 参数会继续转发给 Web 开发栈：

```bash
npm run dev -- --kit ./kits/<name>
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

仓库提供 `npm run kill`，但它会对这三个开发端口上的所有进程发送 `SIGKILL`，不会关闭
稳定 Electron 的 48380、48381、48382 或 48383 端口，也不清理开发 Notification Host 的 49383 端口。只有确认进程确属本项目后才使用。

可用 `HARBORS_GATEWAY_PORT`、`HARBORS_SERVER_PORT`、`HARBORS_CLIENT_PORT` 和
`HARBORS_NOTIFICATION_PORT` 分别覆盖 Gateway、Server、Client 和 Notification Host 端口。
每个值必须是 1–65535 的整数，且四个端口不得重复。

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
Framework 版本。完整生命周期是：

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

## 主程序发布与本地包验收

主程序发布使用 updater 可直接解析的 `v<semver>`、**Developer ID Application** 和受保护的 `app-publish-v1` 工作流。
`npm run desktop:dir` 的未签名目录包只能用于隔离的本地结构验收，不能上传或替代 GitHub 签名发布；
精确确认令牌、Apple 凭据、环境门禁、attestation 与不可变 Release 的恢复方式见
[主程序构建、发布与验收](./app-releases.md)。

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
