# Kit 与会话模型

Kit 决定 Web 工作台具有哪些产品能力，session 负责隔离这些能力与运行时状态。Harbors Server 可在同一进程中承载多个 session，浏览器只渲染当前 session 的投影。

## Session 与 Editor

Session 的持久元数据存在 SQLite，运行时对象由 `SessionRuntimeRegistry` 在 Server 内存中管理。每个 Editor 独立持有 PluginModule、PanelModule、MessageModule、MenuModule、KitModule、WindowManager、config store 与 i18n 状态。路由可读取注册表的只读视图，但不得维护第二份运行时 map。

session 一旦建立，其 Kit 就是该 session 的权威状态。URL 中后续出现其他 Kit 参数不会触发隐式切换。空闲 session 由注册表统一回收，应用停止时先停止接受新请求，再逆序卸载插件。

## Kit descriptor 与 manifest

每个 Kit 目录同时拥有打包用 `kit.json` 和运行时 `package.json` descriptor。两者的 id/name 与 version 必须一致。`distribution=builtin` 的 descriptor 参与本地装配，且只能有一个声明 default 角色；`distribution` 是本地装配和打包元数据，不触发远程分发。

`ce-editor.kit` 必须定义 `menuRoot`、含 `default` 的 layouts、window entries、普通插件列表与可选的 application-scope `startup.plugins`。同一 package name 不能同时出现在启动插件和 session 插件中。插件的权限由 Kit permission 和插件 capability 共同约束。

## 本地解析

Web host 从显式 Kit sources 构建 Catalog。默认稳定入口装配 `kits/default`；开发入口可扫描动态发现的 builtin Kit 目录，但仍以 descriptor 而非硬编码 slug 决定身份。Server 会重新校验运行时 manifest，不从任意 URL 或未声明目录加载代码。

`GET /api/kits` 只返回 Catalog 的公开投影，不暴露本地路径、manifest 位置或插件列表。裸根页面渲染 Kit 选择器，`/kits/<menuRoot.id>` 进入现有 `?kit=<package-name>` 加载路径。

## 本地发现与打包

所有 Kit 的源码位于 `kits/<name>`。开发与打包只使用本地目录；合并源码不会自动创建制品、发布版本或变更版本。版本字段仍是 descriptor 与制品校验所需的静态元数据。

可使用 `npm run kit -- validate`、`npm run kit -- pack` 和 `npm run kit -- inspect` 在本地校验、打包和检查 `.hkit` 制品。运行时不安装或执行远程代码，也不包含桌面 Kit Store、热切换、回滚或本地 Kit Manager。

## 插件范围与布局

Server 启动时创建无 session 的 `ApplicationRuntime`，对 Catalog 中的 `startup.plugins` 按真实路径去重。启动失败会按 owner 回滚并进入 `degraded`，不阻止普通 Kit 创建 session。Web Client 通过 application bootstrap 与 SSE 读取状态；菜单意图由普通 Web API 进入 Server 的 owner-bound 调度链。

Kit 的 `plugin` 列表按顺序解析，内置贡献点保证 Panel、Message、Menu 与 Config 模块可用。layout 仅描述容器树和 Panel 实例，window entry 是 Web 工作台路由与布局的命名入口，不映射原生窗口。Panel 在 sandboxed iframe 中运行，只能通过公开协议请求数据。

## 源码索引

- [`packages/server/src/session/`](../../packages/server/src/session/)
- [`packages/server/src/application/`](../../packages/server/src/application/)
- [`packages/server/src/kit/`](../../packages/server/src/kit/)
- [`packages/kit-core/src/`](../../packages/kit-core/src/)
- [`kits/default/`](../../kits/default/)
