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

## 启动 Web 开发栈

```bash
npm run dev
```

脚本并行启动：

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Gateway | `http://localhost:8080` | 对外统一入口 |
| Server | `http://localhost:3000` | API、SSE 与运行时 |
| Client | `http://localhost:5173` | Vite 开发服务 |

浏览器访问 Gateway，而不是直接访问 Vite。Gateway 才能把 API 和 SSE 路由到 Server。

开发脚本还会列出：

- `/`：工作台；
- `/?page=layout-kit`：布局组件示例；
- `/?page=ui-kit`：基础 UI 示例。

## 指定 Kit

```bash
npm run dev -- --kit ./kits/default
npm run dev -- --kit @itharbors/kit-default
```

`--kit`、`--kit-path` 和 `--kitPath` 都被开发脚本接受，最终写入 Server 的
`CE_DEFAULT_KIT`。路径必须包含有效 package；package name 必须能在配置的 Kit 目录中
找到。

## Electron

```bash
npm run electron
```

Electron 启动同一开发栈，等待 Gateway 就绪后打开 BrowserWindow。它不是独立的第二套
前端。传给 Electron 脚本的 Kit 参数会继续转发给 `npm run dev`：

```bash
npm run electron -- --kit ./kits/default
```

## 构建

```bash
npm run build
```

根构建顺序：

1. `@ce/plugin-types`；
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

先确认占用者：

```bash
lsof -i :8080
lsof -i :3000
lsof -i :5173
```

仓库提供 `npm run kill`，但它会对这三个端口上的所有进程发送 `SIGKILL`。只有确认
进程确属本项目后才使用。

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

先检查 `http://localhost:8080/api/health`，再看 Server 日志中的 Kit/插件装载错误。
Client 会尝试创建 session 并重试一次，但不会掩盖持续装载错误。

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
