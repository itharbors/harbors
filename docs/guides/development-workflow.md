# 开发工作流

本指南以仓库根目录为工作目录，覆盖当前 workspace 的安装、启动、构建、测试和排查。
架构背景见[系统架构](../architecture/system-overview.md)。

## 环境准备

- Node.js 20.19 或更高版本；
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

它扫描 `kits/*` 中所有合法 Kit。启动后只显示系统托盘图标，
不会自动打开默认 Kit。单击或右键托盘图标，从列表选择 Default、SQLite 或 MySQL；首次
选择会按需创建稳定 session、独立窗口和插件/Panel/消息管线，之后再次选择只会打开或聚焦
已有窗口。

`npm run dev` 启动隔离开发 Electron，可与稳定实例并行运行：

```bash
npm run dev
```

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
Default Kit  http://localhost:49380/kits/default
SQLite       http://localhost:49380/kits/sqlite
MySQL        http://localhost:49380/kits/mysql
```

`/?kit=<package-name>` 仍是兼容的直接入口。省略 session 时客户端会为该 Kit 创建新 session；
已有 session 首次初始化后以其已加载 Kit 为准，不能通过替换 URL 中的 `kit` 隐式切换。

开发脚本还会列出：

- `/`：Kit 选择页；
- `/?page=layout-kit`：布局组件示例；
- `/?page=ui-kit`：基础 UI 示例。

## 指定 Kit

```bash
npm run dev -- --kit ./kits/default
npm run dev -- --kit @itharbors/kit-default
```

`--kit`、`--kit-path` 和 `--kitPath` 都被 Electron 启动脚本接受。指定参数代表已经显式
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
npm run start -- --kit ./kits/default
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
node scripts/ce-plugin.mjs build kits/default/plugins/log
node scripts/ce-plugin.mjs check kits/default/plugins/log

npm run plugins:build
npm run plugins:check
```

`build` 会重建目标 `dist/`；`check` 要求产物已经存在，只做 manifest 与文件校验。

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

SQLite、MySQL 和 Notifications 分别保存在 `kits/sqlite`、`kits/mysql`、`kits/notifications`。
Kit 合并只改变 `main` 上的目录内容，不发布 Release，也不修改或发布 Framework 版本。完整生命周期是：

```text
main
  -> kit-change/<name>/<type>/<slug>
  -> PR base main
  -> merge without Release
  -> version-preparation PR updates kits/<name>/kit.json and kits/<name>/package.json
  -> release-kit.sh emits confirmation
  -> push kit/<name>/v<semver>
```

开始 SQLite 变更：

```bash
bash .agents/skills/kit-workflow/scripts/start-kit-change.sh sqlite feature add-import
```

该命令固定获取 `origin/main` 并校验仓库本地 Git 身份，然后创建隔离 worktree、执行根目录
`npm ci`，再完整校验官方 Kit 契约。只在输出的 worktree 中开发。完成后准备含 `## Summary`
与 `## Testing` 的 PR body，再运行：

```bash
bash .agents/skills/kit-workflow/scripts/finish-kit-change.sh \
  sqlite "添加数据导入" /absolute/path/to/pr-body.md
```

finish 只运行目标 Kit 的 `npm run kit:check -- sqlite`，普通 push 后创建并核验 base 为 `main`
的 PR。路径级 CI 至少检查被修改的 Kit；`kit-core`、Kit CLI、发布/Registry 工具或其他共享
构建面变化会触发所有官方 Kit CI。

发布前用独立 PR 同步更新目标目录的 `kit.json`、`package.json` 和根 `package-lock.json`。
合并并确保本地干净 `main` 与 `origin/main` 完全一致后运行：

```bash
bash .agents/skills/kit-workflow/scripts/release-kit.sh sqlite 1.2.0
```

第一次运行只显示 Kit、版本、频道、Commit、Tag 和精确的 `Tag@40-char-SHA` 确认令牌，不创建
Tag。获得用户对这次发布的明确确认后，按输出设置 `HARBORS_KIT_RELEASE_CONFIRM` 重跑。功能
实现或 PR 合并的确认不等于发布确认。普通 SemVer 发布 Stable，带 prerelease 段的 SemVer
发布 Preview；build metadata 不允许用于发布 Tag。

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

例如：`[Feature] 添加用户登录`、`[Bug] 修复 SQLite 连接泄漏`、`[Docs] 完善开发指南`、
`[Refactor] 拆分插件加载器`、`[Optimize] 减少查询内存占用`、`[Test] 补充工作流回归测试`、
`[Chore] 更新构建依赖`。类型大小写必须与表格完全一致；摘要使用简洁中文，末尾不加
句号。每个提交只表达一个可审查的逻辑改动。

## 提交前最小检查

根检查是有限时长命令，不会启动开发服务器：

```bash
npm run check
```

它依次构建共享协议包、运行 Server/Client 全量测试并校验所有插件产物。按变更范围快速
迭代时可拆分执行，但提交前不要少于：

```bash
npm run test -w packages/server
npm run test -w packages/client
npm run plugins:check
git diff --check
```

修改插件时先 `plugins:build` 再 `plugins:check`。修改架构行为时同步检查
[文档维护指南](./maintaining-docs.md)。
