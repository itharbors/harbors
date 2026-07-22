# 开发与稳定桌面端口隔离设计

## 背景

Harbors 的 Electron 桌面宿主会同时启动 Gateway、Server、Vite Client 和 Notification Host。当前源代码中的稳定实例与开发实例均使用 8080、3000、5173、17896；在主仓库运行日常 Electron 后，从另一个 worktree 启动开发版本会发生端口冲突，或迫使用户停止日常实例。

当前 `scripts/dev.mjs` 还将同一个环境对象传给 Gateway 和 Server。若用户只设置 `PORT`，Gateway 和 Server 都会尝试监听该端口，不能作为可靠的隔离方式。

## 目标

- 日常桌面启动继续使用稳定端口，不受开发版本影响。
- Electron 开发与浏览器开发默认使用独立端口组。
- Gateway、Server、Vite Client 和 Notification Host 都有明确、可单独配置的端口。
- 每个子进程只获得自己的监听端口；Gateway 获得后端目标端口。
- 重复或无效配置在启动前失败，并给出可操作的错误。
- 默认的开发清理命令只影响开发端口。

## 非目标

- 不改变 Gateway 路由、Server API、SSE、Kit 和插件协议。
- 不替换现有 Electron、Vite 或 Node 启动工具。
- 不提供远程访问、端口自动探测或生产发布流程。
- 不自动停止任何稳定实例或其他 worktree 的进程。

## 运行配置

| 运行配置 | 启动命令 | Gateway | Server | Client | Notification Host |
| --- | --- | ---: | ---: | ---: | ---: |
| 稳定桌面 | `npm run electron` | 8080 | 3000 | 5173 | 17896 |
| 开发桌面 | `npm run dev` | 18080 | 13000 | 15173 | 17897 |
| 浏览器开发 | `npm run dev:web` | 18080 | 13000 | 15173 | 不启动 |

稳定端口保留当前含义，避免影响已经在主仓库运行的桌面实例。开发端口仅由开发入口占用，因此同一台机器可以同时运行稳定桌面与一个开发实例。

## 配置接口

统一使用显式环境变量，不再要求用户设置含义含混的 `PORT`：

- `HARBORS_GATEWAY_PORT`
- `HARBORS_SERVER_PORT`
- `HARBORS_CLIENT_PORT`
- `HARBORS_NOTIFICATION_PORT`

每个变量必须是 1–65535 之间的整数，四个端口不得重复。未设置时取运行配置的默认值。`HARBORS_NOTIFICATION_PORT` 保持既有名称；其余三个名称新增，用于避免 Gateway 与 Server 共用 `PORT`。

内部启动器将把解析后的值转换为子进程所需的 `PORT`、`SERVER_PORT`、`CLIENT_PORT`：

- Gateway：`PORT=gateway`、`SERVER_PORT=server`、`CLIENT_PORT=client`
- Server：`PORT=server`
- Vite：`CLIENT_PORT=client`

这样父 shell 即使带有旧的 `PORT`、`SERVER_PORT` 或 `CLIENT_PORT`，也不会改变子进程之间的端口归属。

## 启动流程

1. 新增纯函数端口模块，负责运行配置默认值、显式环境变量解析、范围校验、唯一性校验和子进程环境组装。
2. `scripts/dev.mjs` 默认选择开发配置；直接浏览器开发也因此隔离稳定实例。
3. 新增跨平台的开发 Electron 启动包装器。`npm run dev` 通过它设置开发配置后再启动 Electron，并继续转发 Kit 参数。
4. `scripts/electron.mjs` 根据运行配置决定 Gateway URL 和 Notification Host 默认端口，并把当前配置传给它启动的 Web 栈。
5. `npm run electron` 不设置开发配置，保持稳定端口，作为日常源代码桌面入口。
6. `npm run kill` 改为只释放开发默认端口；文档明确它不会清理稳定实例。

## 测试与验证

- 端口模块单测：稳定/开发默认值、显式覆盖、范围错误、重复端口错误、子进程环境隔离。
- 启动器测试：`dev` 使用开发包装器，`electron` 保持稳定入口，Electron 通过同一运行配置构造 URL 和 Notification Host。
- 运行 `npm run check`。
- 在本机稳定 Electron 保持运行时，从新 worktree 启动开发 Web 栈；验证开发 Gateway、Server、Client 监听 18080、13000、15173，而稳定实例仍监听 8080、3000、5173、17896。
