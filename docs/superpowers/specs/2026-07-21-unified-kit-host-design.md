# 统一 Kit 主机设计

## 背景

多 Kit Web 入口已经提供 Catalog 选择页和 `/kits/<id>` 稳定路径，但当前实现仍把
`--kit` 解释为一套独立的单 Kit 主机模式。该模式会改变 Server Catalog、Web 根页面和
Electron 菜单语义，导致同一套加载能力保留两条启动分支。稳定 Kit 路径已经能够承担直接
调试职责，因此不再需要独立的单 Kit 主机。

## 目标

1. Server 和 Web 客户端只保留统一 Kit 主机，不再传播或判断 `single | multi` 模式。
2. 裸根页面 `/` 始终显示 Kit 选择页，且不创建 session。
3. `/kits/<menuRoot.id>` 和 `/?kit=<name-or-path>` 始终直接进入指定 Kit。
4. `--kit <name-or-path>` 保留为启动快捷方式，不再过滤 Catalog 或切换主机模式。
5. 仓库外的显式 Kit 路径临时追加到 Catalog，并可被直达和 Electron 托盘选择。
6. Electron 无参数启动仍只创建 Tray；带 `--kit` 时仍只自动打开目标 Kit，其他 Kit 继续
   保持懒加载。

## 非目标

- 不删除 assembly 的 `defaultKit`；它仍是没有显式 Kit 的开发页和底层 session API 回退值。
- 不改变一个 session 只能绑定一个 Kit 的隔离规则。
- 不在 Web 选择页展示或恢复 Electron Workspace。
- 不让开发脚本唤起系统默认浏览器；内置浏览器仍由开发者或自动化打开打印出的直达地址。
- 不引入 Kit 热切换、安装、卸载或独立端口。

## 方案比较

### 方案 A：完全删除 `--kit`

运行模型最简单，但失去确定性调试、外部 Kit 路径和 Electron 启动直达能力。

### 方案 B：统一主机，`--kit` 仅作为 Catalog 增量和启动目标（采用）

Server 始终发布完整 Catalog，Web 根页面始终显示选择页。显式 Kit 若在 Catalog 内只定位该
条目，若在仓库外则验证后追加。Electron 仍可在服务就绪后自动打开目标 Kit，但托盘保留完整
Catalog。该方案删除主机模式分支，同时保留开发效率和外部 Kit 能力。

### 方案 C：保留模式字段，只让客户端忽略

改动最小，但 Server 仍有过滤 Catalog、环境变量解析和默认行为分叉，无法真正降低维护成本。

## 统一 Catalog

公开协议删除 `KitHostMode` 和 `KitCatalogResponse.mode`：

```ts
interface PublicKitCatalogEntry {
  id: string;
  name: string;
  label: string;
}

interface KitCatalogResponse {
  kits: PublicKitCatalogEntry[];
}
```

Server 的 `discoverKitCatalog(assembly)` 执行以下步骤：

1. 扫描去重后的 `builtinKitsDir` 与 `kitsDir` 一级目录。
2. 读取并验证 Kit manifest，忽略扫描到的无效条目。
3. 解析 `assembly.defaultKit`；若其目录不在扫描结果中，将其作为显式外部 Kit 追加。
4. 对最终集合按真实目录去重，再校验 package name 与 `menuRoot.id` 唯一性并排序。

开发脚本只有显式 `--kit` 时才用该值覆盖 `CE_DEFAULT_KIT`；否则清除父进程遗留值，让 Server
使用仓库默认 Kit。`CE_KIT_MODE` 被删除并从子进程环境中清理，避免旧 shell 环境恢复已移除
的分支。

## Web 入口

客户端不再依赖 Catalog 模式。入口只由 URL 决定：

| URL | 行为 |
| --- | --- |
| `/` | 显示完整 Kit 选择页，不创建 session |
| `/?kit=<name-or-path>` | 挂载 Editor，并为指定 Kit 创建 session |
| `/?session=<id>` 或 `?sessionId=<id>` | 挂载 Editor，恢复既有 session |
| `/?page=<developer-page>` | 挂载现有开发页面入口 |
| `/kits/<id>` | Server 精确匹配 Catalog id 后重定向到 `/?kit=<package-name>` |

`GET /api/kits` 始终返回 `{ kits }`。失败和空 Catalog 继续停留在选择页状态，不回退到默认
Editor。

当 session 创建请求中的 Kit package name 命中 Catalog 时，Server 在内部把它映射为已验证
目录再交给 resolver。这样外部 Kit 的稳定 `/kits/<id>` 链接仍可使用 package name 重定向，
同时不会在 Catalog 响应或 Location header 中暴露本地路径。

## `--kit` 快捷方式

### Web 开发栈

`npm run dev:web -- --kit <name-or-path>` 启动同一个统一主机，并打印：

```text
Kit chooser    http://localhost:8080/
Requested Kit  http://localhost:8080/?kit=<encoded-name-or-absolute-path>
```

脚本不主动打开系统浏览器；自动化或开发者可将 Requested Kit 地址交给内置浏览器。

### Electron

Electron 始终发现仓库完整 Catalog。若 `--kit` 指向外部 Kit，验证后把它追加到 Catalog。
初始化顺序保持 Tray、framework、IPC；仅当存在 requested Kit 时，服务就绪后执行一次
`openKit()`。所有窗口 URL 使用 `menuMode=multi`，应用菜单始终按已加载 session 聚合 Kit 根，
不再存在单 Kit 平铺菜单分支。

## 错误处理与安全边界

- 显式 Kit 不存在或 manifest 无效时，启动失败并显示确定性错误。
- 外部 Kit 只通过现有路径解析器读取；Catalog API 仍不返回目录、manifest 路径或插件列表。
- 重复 package name 或 menu root id 仍是配置错误。
- 稳定路径只精确匹配已验证 Catalog id，不把 URL 片段解释为文件路径。
- 父进程遗留的 `CE_KIT_MODE` 和 `CE_DEFAULT_KIT` 不得意外改变无参数启动。

## 测试策略

1. 协议与客户端测试证明 Catalog 没有 mode，裸根永远选择页，显式 URL 永远进入 Editor。
2. Server Catalog 测试证明仓库 Kit 全量返回、显式仓库 Kit 不导致过滤、外部 Kit 被追加并去重。
3. Server 集成和路由测试证明 `GET /api/kits` 只返回 `{ kits }` 且不创建 session。
4. 开发启动测试证明移除 `CE_KIT_MODE`、清理遗留默认值并打印 Requested Kit 直达地址。
5. Electron 测试证明 `--kit` 不再产生 single mode、Tray 保留完整 Catalog、窗口始终使用多 Kit
   菜单语义，同时只自动打开 requested Kit。
6. 全量检查后实际启动无参数主机和外部/仓库 Kit 快捷启动，验证选择页、直达、Catalog、
   session 隔离和懒加载。

## 验收标准

1. 代码和运行环境中不存在 Web/Server `KitHostMode`、`kitMode` 或 `CE_KIT_MODE` 分支。
2. 无论是否通过 `--kit` 启动，访问 `/` 都只显示完整选择页且不新增 session。
3. 通过 `--kit @itharbors/kit-mysql` 启动后 Catalog 仍包含 Default、MySQL 和 SQLite，目标直达
   地址加载 MySQL。
4. 通过外部 Kit 路径启动后，Catalog 包含仓库 Kit 和该外部 Kit，目标地址可加载它。
5. Electron 带 `--kit` 时只自动创建目标 Kit 的窗口/session，但 Tray 仍可选择其他 Kit。
6. `npm run check` 通过，现有 Electron Tray、稳定路径和三种内置 Kit 无回归。
