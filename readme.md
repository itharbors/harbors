# ITHARBORS

[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-339933?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-3178C6?logo=typescript)](https://www.typescriptlang.org/)

ITHARBORS 是一个插件优先的 Web 应用框架。Gateway 提供统一入口，Server 持有 Kit、会话与插件运行时，Client 在浏览器中渲染工作台。Kit 源码位于 `kits/`，用于本地开发、校验与打包。

## 快速开始

需要 Node.js 22.12+、npm 9+，以及 `better-sqlite3` 在本机编译时需要的 Python/C++ 工具链。

```bash
npm install
npm run dev
```

`npm run dev` 等同于 `npm run dev:web`，启动开发 Gateway、Server 与 Client，访问 <http://localhost:49380>。稳定单进程入口使用：

```bash
npm run build
npm start
```

`npm start` 在 `HARBORS_SERVER_PORT`（默认 `48381`）启动 Web Server，并从 `kits/default` 装配内置 Kit。运行数据写入被 Git 忽略的 `.data/`。

## 架构

```text
浏览器
  │
Gateway（开发统一入口）
  ├─ /api、/sse ─► Server ─► Application Runtime / Session Runtime
  └─ 页面资源 ───► Client ─► Panel iframe
```

- `packages/server`：会话、Kit、插件、消息、API、SSE 和持久化。
- `packages/client`：浏览器工作台、布局、主题和交互。
- `packages/gateway`：开发环境统一入口与反向代理。
- `plugins`：框架级插件。
- `kits/default`：内置 default Kit、descriptor、布局和依赖。
- `scripts`：构建、检查、Task 与 Kit 本地制品工具。

Harbors 只支持 Web host，不包含 Electron、桌面打包、托盘、原生窗口、桌面更新或桌面 IPC。

## Kit 与插件

Kit 由 `kit.json` 和 `package.json` descriptor 描述；`distribution` 仅表达本地装配类别。插件通过 manifest 声明 Panel、Message、Menu 和 public assets，通过 `editor.plugin.define()` 注册生命周期。

Kit 变更与 Framework 一样使用 change-workflow，从 `origin/main` 创建 `<type>/<slug>` 分支并提交到 `main`。合并只更新源码；不会自动创建制品、发布版本、创建 Release Tag 或更新远程 Registry。版本字段仍用于 descriptor 与本地制品校验，可用 `npm run kit -- validate`、`npm run kit -- pack` 和 `npm run kit -- inspect` 完成本地制品循环。

常用命令：

```bash
npm run build
npm run check
npm run plugins:build
npm run plugins:check
npm run kit -- validate ./path/to/kit
npm run kit -- pack ./path/to/kit --output ./dist/example.hkit
npm run kit -- inspect ./dist/example.hkit --json
```

## 文档

- [文档入口](./docs/README.md)
- [系统架构](./docs/architecture/system-overview.md)
- [核心运行流程](./docs/architecture/runtime-flows.md)
- [插件运行时模型](./docs/architecture/plugin-runtime-model.md)
- [Kit 与会话模型](./docs/architecture/kit-and-session-model.md)
- [开发工作流](./docs/guides/development-workflow.md)
- [Kit 制品打包](./docs/guides/kit-artifacts.md)
- [架构决策记录](./docs/decisions/README.md)

## 开发原则

- 产品能力优先放入 Kit 插件，Framework 保持通用。
- Server 持有权威状态，Client 只投影快照并提交意图。
- Panel 资源必须由 manifest 显式声明且不能越过插件目录。
- 变更在隔离 worktree 中完成，并运行受影响测试与 `npm run check`。
