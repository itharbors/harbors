# Electron 多 Kit 工作台设计

## 目标

ITHARBORS 默认由 Electron 启动，同时提供全部可用 Kit。每个 Kit 使用独立的
Workspace、Session、Editor、插件、Panel、消息与菜单管线；系统托盘负责打开或聚焦 Kit
窗口。保留 `--kit` 单 Kit 模式，并把所有插件包名从 `@ce/*` 统一为
`@itharbors/*`。

## 运行模式

| 模式 | 入口 | 窗口 | 菜单 |
| --- | --- | --- | --- |
| 多 Kit | `npm run dev` / `npm run electron` | 启动后创建全部 Kit 的独立窗口，默认 Kit 可见，其余窗口预热隐藏 | `APP / <Kit A> / <Kit B>` |
| 单 Kit | `npm run dev -- --kit <name-or-path>` | 只创建指定 Kit 窗口 | 忽略 Kit 根名称，平铺现有组合菜单 |
| Web 调试 | `npm run dev:web` | 保留现有浏览器工作台 | 单 Session 菜单 |

系统托盘在所有桌面平台常驻。点击 Kit 时显示并聚焦已有窗口；关闭窗口只关闭载体，Server
中的 Workspace Runtime 保持，重新点击可使用相同 Session 恢复。退出托盘应用时统一释放。

## 核心模型

- **KitCatalogEntry**：从 `kits/` 或 `--kit` 指定路径读取的静态 Kit 信息，包含 package
  name、label、menu root 和路径。
- **WorkspaceRecord**：Electron 用户目录中的持久记录，保存 Kit name、稳定 sessionId、窗口
  bounds 和最近访问时间，不保存密码或插件内存。
- **KitWindow**：一个 BrowserWindow 绑定一个 Workspace；URL 明确携带 session、kit 和菜单模式。
- **SessionRuntime**：沿用 Server `SessionRuntimeRegistry`。不同 Workspace 创建不同 Editor，
  因而拥有独立插件/Panel/Message/Menu/Window/SSE 管线。

内置 Panel、Message、Menu、Config 插件仍由每个 Editor 分别装载。移除 Config 的进程级可变
store 例外；Electron KitCatalog、Tray 和窗口注册表才属于 Application scope。

## Kit manifest

每个 Kit 在 `ce-editor.kit` 中必须声明：

```json
{
  "menuRoot": {
    "id": "sqlite",
    "label": "SQLite"
  }
}
```

`id` 在 Kit 目录内唯一；`label` 用于托盘和多 Kit 菜单。`ce-editor`、`--ce-*` 和 `ce-*`
Web Component 是协议标识，本次不改名。

## 菜单

Server MenuModule 同时生成三份视图：

1. `menuTree`：默认菜单与 Kit 贡献合并，保持现有单 Kit 行为；
2. `applicationMenuTree`：仅内置 Menu 默认项；
3. `kitMenuTree`：仅保留 Kit 插件动作及其必要父级结构。

Bootstrap、SSE 和 Electron IPC 携带这三份树及 `kitMenuRoot`。单 Kit 模式使用 `menuTree`；多
Kit 模式将 `applicationMenuTree` 包在 `APP` 根下，将各 Workspace 的 `kitMenuTree` 包在对应
Kit 根下。Kit 菜单动作始终发送到该 Kit 的稳定 session；触发隐藏 Kit 菜单时先显示窗口。

## 命名迁移

所有 package/plugin 标识 `@ce/*` 迁移为 `@itharbors/*`，包括内置插件、默认 Kit 插件、
`plugin-types`、源码 owner 常量、布局 Panel 名、测试、文档和 lockfile。IPC channel、manifest
键、CSS token 与 DOM tag 不属于 package/plugin 标识，不在本次迁移范围。

## 失败与兼容

- Kit 目录忽略非法 manifest，并在托盘中把已持久化但缺失的 Kit 标记为不可用。
- 一个窗口加载失败不关闭其他 Kit；托盘仍可重试该 Kit。
- Workspace 写入使用临时文件加原子 rename，损坏文件回退为空状态。
- Server 现有 HTTP/SSE API 继续使用 `sessionId`，无需新增第二套路由。
- `npm run electron` 保持可用；`npm run dev:web` 提供原浏览器开发栈。

## 验收

1. 仓库受管源码、manifest、测试和文档中不存在插件级 `@ce/*`。
2. 默认 `npm run dev` 启动 Electron，多 Kit 模式托盘列出全部有效 Kit。
3. SQLite、MySQL、Default Kit 分别拥有独立 session 和窗口；消息与 Config 不串线。
4. `--kit` 只创建指定 Kit，并使用平铺菜单。
5. 多 Kit 菜单顶层为 `APP` 和各 Kit 根，动作路由到正确窗口/session。
6. 关闭并从托盘重开 Kit 时复用 Workspace session；应用重启后恢复 session 与 bounds。

## 非目标

- 跨进程恢复数据库连接或任意 Panel DOM 内存；
- 在线安装/升级 Kit；
- 自动休眠与 Runtime 序列化；
- 修改 `ce-editor`、CSS token 或 Web Component 前缀。

