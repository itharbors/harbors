# ITHARBORS

[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-31%2B-47848F?logo=electron)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-3178C6?logo=typescript)](https://www.typescriptlang.org/)

ITHARBORS 是一个以插件为核心的桌面应用开发框架。它提供基于 Web 的编辑器工作台、按会话隔离的 Kit 与插件运行时，以及默认启用的 Electron 桌面宿主，用于构建跨平台开发工具。

> 仓库仍在持续演进。内置的默认 Kit 既可直接运行，也可作为编写 Kit 和插件的参考实现。

## 功能特性

- **插件优先的运行时**：功能、面板、菜单和消息处理器均通过插件声明和实现。
- **基于 Kit 的组合**：一个 Kit 定义应用启动插件，以及单个编辑器会话按需加载的插件、布局、窗口入口和主题。
- **可验证 Kit 制品**：提供确定性 `.hkit` 打包、检查、本地事务安装和 active 版本目录接入。
- **桌面 Kit 市场**：托盘中的 Kit Manager 提供严格 Registry、Sigstore 来源验证、权限提示、离线缓存、安装、重启激活和自动回滚。
- **Kit 独立发布**：专属 Tag 从 `main:kits/<name>` 选择一个 Kit，自动生成 `.hkit` Release Asset、SBOM、Artifact Attestation 与 GitHub Pages 市场索引。
- **会话隔离**：每个会话拥有独立的运行时、当前 Kit 和已加载的外部插件。
- **消息中枢**：面板与插件之间通过服务端路由的 request / broadcast API 通信。
- **可组合布局**：使用 split pane、divider 和 panel 构建可调整尺寸的编辑器工作台。
- **多 Kit 桌面宿主**：Electron 默认发现全部 Kit，通过系统托盘按需创建、打开或聚焦独立窗口和 session。
- **Agent 桌面通知**：本机通知接口、任务栏未读角标、临时或常驻弹窗，以及 Notification Center Kit 形成完整通知链路。
- **Web 调试兼容**：需要浏览器入口时可显式启动同一套 Gateway、Server 与 Client 开发栈。
- **TypeScript 工具链**：提供共享插件协议、类型定义，以及插件源码和 `dist/` 产物的构建/校验工具。

## 快速开始

### 环境要求

- Node.js 20.19 或更高版本
- npm 9 或更高版本

服务端使用 `better-sqlite3`。如果当前 Node.js 版本和平台没有可用的预编译二进制包，安装依赖时还需要 Python 和可用的 C/C++ 编译工具链。

### 开发环境

```bash
git clone https://github.com/itharbors/itharbors.git
cd itharbors
npm install
npm run dev
```

`npm run dev` 会启动隔离的开发 Electron，加载各 Kit 声明的应用级启动插件并显示系统托盘图标，但不会
自动打开默认 Kit。单击或右键托盘
图标，从列表选择 Default、SQLite 或 MySQL；首次选择会按需加载，之后再次选择只会打开或
聚焦已有窗口。选择 **Kit Manager…** 可刷新市场、安装 Stable/Preview Kit，并把版本排入下一次
安全重启激活。首个可信 Kit Release 完成发布和索引部署前，Registry 可能为空。

| 服务 | 稳定 Electron（`npm run start`） | 隔离开发 Electron（`npm run dev`） | 职责 |
| --- | --- | --- | --- |
| Gateway | http://localhost:48380 | http://localhost:49380 | 统一入口；代理 API、SSE 与前端资源 |
| Server | http://localhost:48381 | http://localhost:49381 | 会话、Kit、插件运行时、消息和存储 |
| Client | http://localhost:48382 | http://localhost:49382 | 基于 Vite 的工作台前端 |
| Notification Host | http://127.0.0.1:48383 | http://127.0.0.1:49383 | 接收本机通知、维护未读状态并驱动桌面提示 |

Gateway 会把 `/api/*` 和 `/sse/*` 转发给 Server，并把其他请求转发到 Client 开发服务。需要直接在浏览器中调试时运行 `npm run dev:web`，再访问 [http://localhost:49380](http://localhost:49380)。

### Electron 与 Kit 直达

```bash
npm run start
```

`npm run start` 是日常使用的稳定桌面入口；`npm run electron` 保留为兼容入口。稳定端口为 Gateway 48380、Server 48381、Client 48382 和 Notification Host 48383；`npm run dev`
是隔离开发入口，使用 Gateway 49380、Server 49381、Client 49382 和 Notification Host 49383，因此可与稳定实例并行运行。默认只显示 Kit 托盘；使用 `--kit` 代表已经显式
选择，服务就绪后只自动打开指定 Kit，但 Tray 与 Catalog 仍保留其他 Kit，菜单继续使用统一
的多 Kit 聚合形式：

```bash
npm run dev -- --kit ./kits/sqlite
```

### Agent 通知

Harbors Electron 已内置 `notify-user` Skill。若希望本机所有项目中的 Codex Agent 都能使用它，
打开主菜单 **APP → Install or Update Codex Notification Skill…**。Harbors 会直接把
软件内置版本安装到 `~/.codex/skills/notify-user`，不需要网络、GitHub 或外部安装器。

安装、更新、已经是最新版本或同名冲突都会通过桌面通知反馈。Harbors 不覆盖用户自定义的同名
Skill；安装成功后，`notify-user` 从下一轮 Codex 对话开始可用。仅启动 `npm run dev:web` 时没有
Electron 内置资源，因此不能执行菜单安装。

安装后，Agent 会先定位 Skill 自身目录，再执行其中的脚本，因此不要求当前项目是 Harbors。
实际调用等价于：

```bash
node "<skill-directory>/scripts/notify.mjs" \
  --title "Task completed" \
  --body "Build and tests passed" \
  --level success
```

其中 `<skill-directory>` 是已安装 `SKILL.md` 所在目录，不是需要原样输入的文本。
需要用户处理的事项可添加 `--persistent`。通知会进入 Notification Center 历史和未读计数；
临时弹窗消失不会自动标记为已读。仅启动 `npm run dev:web` 时没有桌面 Host，发送命令会明确失败。

## 常用命令

### 主程序发布

桌面主程序使用 `app/v<semver>` Tag、**Developer ID Application** 签名和受保护的
`app-publish-v1` 工作流。开发构建、精确发布确认、Preview/Stable 环境门禁、签名产物验收与不可变
Release 恢复见[主程序构建、发布与验收](docs/guides/app-releases.md)；本地未签名目录包只可做结构验收。

```bash
# 构建插件类型、前端、服务端和全部插件
npm run build

# 清理可再生构建产物和开发缓存
npm run clean

# 运行服务端与前端测试
npm test

# 构建并校验全部插件产物
npm run plugins:build
npm run plugins:check

# 构建或校验单个插件
node scripts/ce-plugin.mjs build plugins/menu
node scripts/ce-plugin.mjs check kits/default/plugins/log

# 只启动 Web 开发栈
npm run dev:web

# 使用指定 Kit 目录启动 Electron
npm run dev -- --kit ./kits/default

# 校验、封装并检查可发布 Kit 制品
npm run kit -- validate ./path/to/kit
npm run kit -- pack ./path/to/kit --output ./dist/example.hkit
npm run kit -- inspect ./dist/example.hkit --json

# 聚合并远程验证 Registry（通常由 GitHub Actions 调用）
mkdir -p ./dist/registry
GITHUB_TOKEN=<token> npm run kit:publish -- aggregate \
  --repository-root "$PWD" \
  --repository itharbors/harbors \
  --policy-file ./registry/policy.json \
  --revocations-file ./registry/revocations.json \
  --output ./dist/registry/index.v1.json \
  --generated-at 2026-07-24T00:00:00.000Z
```

Kit Manager 默认读取 `https://itharbors.github.io/harbors/index.v1.json`。受控开发环境可通过
`HARBORS_KIT_REGISTRY_URL` 指定其他 HTTPS Registry；publisher policy 与自动更新发布者也可用
`HARBORS_KIT_PUBLISHER_POLICIES_JSON`、`HARBORS_KIT_AUTO_UPDATE_PUBLISHERS` 显式配置，非法配置
会阻止市场服务启动。

SQLite、MySQL、Notifications 分别维护在 `kits/sqlite`、`kits/mysql`、`kits/notifications`。
Framework 与 Kit 变更都通过 PR 合入 `main`，但 Kit 使用仓库本地 `kit-workflow` 从
`origin/main` 创建 `kit-change/<name>/<type>/<slug>` 隔离 worktree，并只检查目标 Kit。普通合并
不会发布 Kit 或 Framework。

发布者在与远端完全一致的干净 `main` 上确认并推送 `kit/<name>/v<semver>`。GitHub Actions 只构建
对应目录，将 `.hkit` 作为独立 Release Asset 上传；随后自动扫描可信、不可变 Release，依据
`registry/policy.json` 与 `registry/revocations.json` 重建并部署 `index.v1.json`。每次发版不需要
提交 Registry entry。具体版本、频道、签名和首次启用要求见
[Kit 制品与 Registry 指南](./docs/guides/kit-artifacts.md)。

可用 `HARBORS_GATEWAY_PORT`、`HARBORS_SERVER_PORT`、`HARBORS_CLIENT_PORT` 和
`HARBORS_NOTIFICATION_PORT` 分别覆盖四个端口；每个值必须是 1–65535 的整数，且四个端口不得重复。
`npm run kill` 只会强制释放开发 Web 端口 49380、49381 和 49382，不会关闭稳定 Electron 实例或 Notification Host；使用前仍请确认这些进程确实属于本项目。

## 架构概览

```text
浏览器 / Electron
        │
    Gateway (:48380)
      ├─ /api、/sse ───────► Server (:48381)
      │                         ├─ Application Runtime（启动插件）
      │                         ├─ 会话运行时（按需创建）
      │                         ├─ Kit 加载器
      │                         └─ 插件与消息路由器
      └─ 其他请求 ─────────► Vite Client (:48382)
```

### Kit

Kit 同时声明两类能力：`startup.plugins` 是进程级、无界面的应用启动插件，`plugin` 是用户
首次打开该 Kit 时随 Session 加载的普通插件。普通插件仍构成会话能力边界，拥有窗口、Panel、
布局和 Session 消息；启动插件只有应用服务、服务端消息、全局菜单和宿主信息。切换 Kit 时，
运行时会卸载旧 Kit 的普通插件并清理其 owner 贡献，Application Runtime 不随 Session 切换。

### 插件

插件在 `package.json` 中静态声明面板、消息映射、菜单和公开资源，并通过 `editor.plugin.define()` 注册运行时行为与生命周期。

运行时只加载构建后的 `dist/` 文件。插件目录约定如下：

```text
my-plugin/
├── package.json
├── main/
│   ├── src/index.ts
│   └── dist/index.js
└── panel.example/
    ├── src/index.html
    └── dist/index.html
```

最小 manifest 示例：

```json
{
  "name": "@example/my-plugin",
  "type": "module",
  "main": "./main/dist/index.js",
  "ce-editor": {
    "contribute": {
      "panel": {
        "example": { "entry": "./panel.example/dist/index.html" }
      }
    }
  }
}
```

浏览器面板通过 `editor.message.request()` 和 `editor.message.broadcast()` 通信；不要绕过服务端消息中枢直接调用其他面板。

## 目录结构

```text
packages/
├── client/        浏览器工作台与 UI 组件
├── gateway/       开发入口与反向代理
├── plugin-types/  共享插件协议与类型
└── server/        会话、运行时、Kit、插件和 API 路由
kits/
├── default/       内置默认 Kit 及其外部插件
├── sqlite/        SQLite Kit
├── mysql/         MySQL Kit
└── notifications/ Notifications Kit
plugins/           内置插件（配置、菜单、消息、面板）
scripts/           开发栈、Electron 宿主和插件构建工具
docs/              架构约束、操作指南和历史记录
```

## 文档

- [文档入口](./docs/README.md)
- [核心原则](./docs/architecture/core-principles.md)
- [系统架构](./docs/architecture/system-overview.md)
- [核心运行流程](./docs/architecture/runtime-flows.md)
- [插件运行时模型](./docs/architecture/plugin-runtime-model.md)
- [Kit 与会话模型](./docs/architecture/kit-and-session-model.md)
- [布局模型](./docs/architecture/layout-model.md)
- [UI 系统](./docs/architecture/ui-system.md)
- [开发工作流](./docs/guides/development-workflow.md)
- [插件与 Kit 开发指南](./docs/guides/developing-plugins-and-kits.md)
- [Kit 制品与本地安装](./docs/guides/kit-artifacts.md)
- [架构决策记录](./docs/decisions/README.md)

`docs/architecture/` 和 `docs/guides/` 描述当前行为；`docs/decisions/` 解释重要取舍；`docs/superpowers/` 仅保留文档设计和实施过程，不属于产品文档主线。

## 开发原则

- 保持 Framework 的通用性；不要在其中硬编码产品专属插件或业务逻辑。
- 新能力应优先建模为插件贡献点，再考虑新增 Framework API。
- Panel 资源只能从 manifest 显式声明、且归属该插件的公开目录中提供。
- 工作台的结构性区域应使用布局模型表达，而不要使用临时容器绕过布局语义。
- 修改插件后运行 `npm run plugins:build` 和 `npm run plugins:check`；提交前应运行相关测试。

## 贡献

欢迎贡献。请通过 Issue 或 Pull Request 提交清晰、聚焦的变更说明。提交前请构建受影响的包、校验修改过的插件，并运行相关测试。

## 许可证

仓库当前尚未包含许可证文件。在将 ITHARBORS 作为开源包分发前，请补充明确的许可证。
