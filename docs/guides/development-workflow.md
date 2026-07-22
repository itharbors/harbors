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

`npm run electron` 是稳定 Electron 入口：

```bash
npm run electron
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
| Gateway | `http://localhost:8080` | `http://localhost:18080` | 对外统一入口 |
| Server | `http://localhost:3000` | `http://localhost:13000` | API、SSE 与运行时 |
| Client | `http://localhost:5173` | `http://localhost:15173` | Vite 开发服务 |
| Notification Host | `127.0.0.1:17896` | `127.0.0.1:17897` | 本机通知与桌面提示 |

需要浏览器调试入口时显式运行：

```bash
npm run dev:web
```

浏览器访问 Gateway，而不是直接访问 Vite。`npm run dev:web` 默认使用隔离开发端口，因此访问
`http://localhost:18080`；Gateway 才能把 API 和 SSE 路由到 Server。

Web 栈始终运行统一 Kit 主机，裸地址显示 Kit 选择页，并提供开发直达地址：

```text
Kit 选择页   http://localhost:18080/
Default Kit  http://localhost:18080/kits/default
SQLite       http://localhost:18080/kits/sqlite
MySQL        http://localhost:18080/kits/mysql
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
npm run electron
```

`npm run electron` 是稳定桌面入口，使用旧端口 8080、3000、5173 和 17896。`npm run dev` 是
隔离开发入口，使用 18080、13000、15173 和 17897。Electron 先显示托盘，再启动
`npm run dev:web` 子进程；选择 Kit 后会等待 Gateway 就绪再创建 BrowserWindow，不会递归
启动桌面宿主。传给 Electron 的 Kit 参数会继续转发给 Web 开发栈：

```bash
npm run electron -- --kit ./kits/default
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
lsof -i :18080
lsof -i :13000
lsof -i :15173
```

仓库提供 `npm run kill`，但它会对这三个开发端口上的所有进程发送 `SIGKILL`，不会关闭
稳定 Electron 的 8080、3000、5173 或 17896 端口。只有确认进程确属本项目后才使用。

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

先检查对应入口的 Gateway health 地址（隔离开发默认是 `http://localhost:18080/api/health`），再看 Server 日志中的 Kit/插件装载错误。
Client 会尝试创建 session 并重试一次，但不会掩盖持续装载错误。

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
