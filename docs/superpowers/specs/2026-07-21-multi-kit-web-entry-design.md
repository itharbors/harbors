# 多 Kit Web 入口设计

## 背景

Electron 多 Kit 模式已经通过托盘维护 Kit Catalog，并为每个 Kit 创建稳定的 Workspace、
Session 和窗口。不过 Web 入口仍把裸地址 `/` 当作普通编辑器页面：客户端自动生成 session，
服务端在没有显式 Kit 时加载 `defaultKit`。因此外部浏览器访问 8080 端口只能看到默认 Kit，
既不能发现其他 Kit，也没有稳定、可分享的 Kit 地址。

服务端本身已经支持同一端口上的多个 Kit session；缺口只在 Catalog 暴露、Web 路由和入口 UI。

## 目标

1. 多 Kit 模式访问 `/` 时显示 Kit 选择页，不创建默认 Kit session。
2. 每个 Kit 提供稳定的 `/kits/<menu-root-id>` 直达地址。
3. Electron 窗口已有的 `?session=<id>&kit=<name-or-path>&menuMode=<mode>` 地址继续直接进入编辑器。
4. 单 Kit 模式访问 `/` 时继续直接进入显式指定的 Kit，不增加选择步骤。
5. Kit 选择和直达都沿用现有 session 隔离；一个 session 首次创建后只对应一个 Kit。

## 非目标

- 不改变 Electron 托盘、窗口持久化或菜单聚合方式。
- 不在 Web 选择页管理已有 Workspace 或历史 session。
- 不提供在线安装、删除或升级 Kit。
- 不为每个 Kit 分配独立端口或独立 Server 进程。
- 不向浏览器暴露 Kit 的绝对目录、manifest 路径或插件清单。

## 方案选择

### 方案 A：只保留 `?kit=<package-name>`

实现成本最低，但裸 8080 地址仍加载默认 Kit，用户无法发现可用 Kit，不能解决入口问题。

### 方案 B：Catalog API、选择页和稳定路径（采用）

Server 暴露经过裁剪的 Kit Catalog，客户端根据运行模式决定显示选择页还是编辑器，
`/kits/<id>` 由 Server 解析后重定向到现有 `?kit=` 创建流程。它复用当前 session/runtime
模型，不引入第二套 Kit 加载逻辑。

### 方案 C：每个 Kit 使用独立端口

地址直观，但会复制 Gateway、Server、端口发现、生命周期和资源管理，不符合当前每 session
隔离的架构。

## 运行模式传播

`scripts/dev.mjs` 必须显式向 Server 传递运行模式：

- 有 `--kit`：`CE_KIT_MODE=single`，并继续传递 `CE_DEFAULT_KIT`。
- 无 `--kit`：`CE_KIT_MODE=multi`。

Server 将模式规范化为 `single | multi`。测试和嵌入调用未传模式时保持兼容：设置了
`defaultKit` 视为 `single`，否则视为 `multi`。默认 assembly 的 `defaultKit` 仍只作为 session
创建的回退值，不再决定多 Kit Web 根页面。

## Kit Catalog

Server 在 assembly 的 `builtinKitsDir` 和 `kitsDir` 中扫描一级目录，读取有效
`package.json`，并复用现有 Kit manifest 的必要约束。重复目录去重；非法 manifest 被忽略，
重复 package name 或 `menuRoot.id` 视为配置错误。

公开响应只包含浏览器入口需要的字段：

```ts
type KitHostMode = 'single' | 'multi';

interface PublicKitCatalogEntry {
  id: string;
  name: string;
  label: string;
}

interface KitCatalogResponse {
  mode: KitHostMode;
  kits: PublicKitCatalogEntry[];
}
```

`GET /api/kits` 在多 Kit 模式返回全部有效 Kit；单 Kit 模式只返回显式指定的 Kit。
目录和 manifest 路径只保留在 Server 内部。

## Web 路由

| 模式 | 请求 | 行为 |
| --- | --- | --- |
| 多 Kit | `/`，且无 `session`、`sessionId`、`kit` | 显示 Kit 选择页，不创建 session |
| 多 Kit | `/?kit=<name-or-path>` | 直接进入编辑器，客户端生成新 session |
| 多 Kit | `/?session=<id>` | 恢复已有 session，session 中的 Kit 为准 |
| 多 Kit | Electron 原有完整查询参数 | 直接进入编辑器 |
| 单 Kit | `/` | 直接进入显式 Kit，保持当前行为 |
| 任意模式 | `/kits/<id>` | `302` 到 `/?kit=<encoded-package-name>` |
| 任意模式 | 未知 `/kits/<id>` | 返回 `404 KIT_NOT_FOUND` |

稳定路径使用 manifest 的 `menuRoot.id`，例如 `/kits/default`、`/kits/sqlite`、
`/kits/mysql`。重定向不携带 session，因此每次从选择页打开会创建独立浏览器 session；
重载重定向后的最终 URL 会复用客户端写入的 session 参数。

## 客户端启动边界

客户端入口先渲染轻量加载状态并请求 `/api/kits`：

1. 单 Kit 模式直接挂载 `<editor-app>`。
2. 多 Kit 模式且 URL 已明确 session、Kit 或开发页面时挂载 `<editor-app>`。
3. 多 Kit 裸根地址渲染 Kit 选择页。
4. Catalog 请求失败时显示明确错误和“重新加载”操作，不偷偷进入默认 Kit。
5. Catalog 为空时显示配置空状态，不创建 session。

选择页与 EditorApp 相互独立，选择页不导入 Kit 插件、不创建 SSE，也不调用 session API。

## 选择页视觉与交互

页面是开发者工作台入口，不做营销式首屏。视觉沿用现有深色工作台，但避免高饱和绿色：

- `Harbor Ink #111722`：页面背景。
- `Dock Slate #182231`：卡片和顶栏。
- `Channel Blue #5B8DEF`：主焦点与选中反馈。
- `Signal Ice #A9C7F7`：次级强调。
- `Mist #D8E2F0`、`Steel #8D9BAF`：主次文字。

版式采用紧凑的“工作台停泊位”列表：顶部说明当前是多 Kit 主机，下方每张卡片显示 Kit
名称、package name 和“打开工作台”动作。卡片整体可点击，支持键盘焦点；小屏切为单列。
动效只用于短距离 hover/focus 位移，并遵循 `prefers-reduced-motion`。

## 错误和边界处理

- Catalog API 只接受 `GET`；其他方法返回 `405`。
- `/kits/<id>` 对 id 做 URL 解码和精确匹配，不把输入拼接为文件路径。
- Catalog 配置冲突返回 500，并在服务端记录具体冲突；公开响应不包含本地路径。
- 选择页加载失败保留在入口状态，给出可重试动作。
- 已存在 session 与 URL 中 `kit` 冲突时，继续沿用现有规则：已存在 runtime 为准，不执行隐式切换。

## 测试策略

1. Server 单元测试覆盖 Catalog 扫描、去重、非法 manifest、冲突和公开字段裁剪。
2. Server 路由测试覆盖 `/api/kits` 的单/多 Kit 响应、`/kits/<id>` 重定向和未知 Kit。
3. Client 测试覆盖入口判定：多 Kit 裸根显示选择页，显式 Kit/session 和单 Kit 显示编辑器。
4. Client 测试覆盖选择页链接、加载失败、空 Catalog、键盘语义和 reduced-motion CSS。
5. 启动脚本测试覆盖 `CE_KIT_MODE` 与 `CE_DEFAULT_KIT` 的传播。
6. 完整仓库检查后分别实际启动多 Kit 和单 Kit：验证根页面、三个稳定地址、session 生成、
   Electron 原有地址以及单 Kit 直达行为。

## 验收标准

1. 多 Kit 模式打开 `http://localhost:8080/` 只显示 Kit 选择页，Server 中不新增默认 session。
2. `/kits/default`、`/kits/sqlite`、`/kits/mysql` 分别进入正确 Kit。
3. 外部浏览器可以在同一 8080 端口同时打开多个 Kit，且 session、菜单和 Panel 不串线。
4. 单 Kit 模式裸根地址仍直接进入指定 Kit。
5. Electron 托盘打开、懒加载和已有窗口 URL 行为无回归。
