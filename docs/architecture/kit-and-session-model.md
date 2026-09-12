# Kit 与会话模型

Kit 决定 Web 工作台具有哪些产品能力，session 负责隔离这些能力与运行时状态。Harbors Server 可在同一进程中承载多个 session，浏览器只渲染当前 session 的投影。

## Session 与 Editor

Session 的持久元数据存在 SQLite，运行时对象由 `SessionRuntimeRegistry` 在 Server 内存中管理。每个 Editor 独立持有 PluginModule、PanelModule、MessageModule、MenuModule、KitModule、WindowManager、config store 与 i18n 状态。路由可读取注册表的只读视图，但不得维护第二份运行时 map。

Session SQLite 默认位于 `~/.harbors/harbors.db`。`--data-root` / `HARBORS_DATA_ROOT` 会同时切换 Session 数据库、Kit 配置和 Plugin 持久数据，因此同一根在 Dev 与稳定入口间可见相同工作状态；它不会新增 Project 或文件系统隔离，也不隔离 OS Keychain secret。

Framework Session 数据库只保存 Session 元数据。Harness Conversation 内容由 `agent-context-store` 在 Plugin owner data 目录中使用一个共享、版本化 SQLite 保存，并以 `conversation_id` 隔离；不会为每个 Conversation 建立独立 SQLite。详见 [Agent Context Store](./agent-context-store.md)。

Web Host 的最小身份关系为 `User 1:N AuthorizedDevice` 与 `User 1:N Session`。`userId` 是 Server 生成的稳定 opaque ID，显示名只用于展示且允许重名；设备授权把远程设备绑定到一个 User，撤销设备不会删除 User 或 Session。Session 的 `ownerUserId` 是 HTTP、SSE、Panel asset 与消息路由的统一访问依据，Kit 复合 runtime ID 通过 `SessionRuntimeRegistry` 保存的 `runtimeId -> baseSessionId` 索引回到基础 Session，不允许把字符串拆分结果当作安全事实。

Session owner 只约束 Framework 的 Session/runtime HTTP 与 SSE 访问，不构成 Project、workspacePath 或文件系统级隔离，也不授予多人协作、目录沙箱或跨 Session 文件权限。需要工作区或文件系统安全边界时必须另行设计，不能从 `ownerUserId` 推导。

请求身份只有本地主机管理员、已授权设备对应的 User 与匿名三类。Gateway 会删除客户端提供的 `X-Forwarded-For`，再用真实入站 socket 地址覆盖；Server 仅在立即上游 socket 为 loopback 时接受这个单值合法 IP。远程直连 Server 时请求头不能覆盖真实 socket，也不能提升权限；本地经 Gateway 访问仍保持管理员身份。匿名远程设备仅可读取精简用户目录，并提交一次“当前设备申请绑定指定 `userId`”的待审批请求；这不会赋予 Session 权限。批准后设备身份固定，已授权远程请求不能再提交 `userId` 改变身份，只能访问 owner 与设备 User 匹配的 Session。

新的 Device、Session 与 Config Storage 数据库直接创建当前 schema，不执行历史列回填或旧表复制。`AuthorizedDevice.userId` 与 `Session.ownerUserId` 均为必填；不符合当前 schema 的旧数据库应在启动时明确失败，而不是隐式迁移。工作台通过 `/api/workbench/context` 获取不含本地路径的公开投影，并通过 `/api/workbench/session` 为明确选择的 User 创建新的 opaque Session ID。

session 下的每个 Kit runtime 都拥有独立 Editor；同一基础 Session 可以同时具有多个 Kit runtime，但它们共享同一个 Session owner。URL 中后续出现其他 Kit 参数不会触发已存在 runtime 的隐式切换。空闲 session 由注册表统一回收，应用停止时先停止接受新请求，再逆序卸载插件。

## Kit descriptor 与 manifest

每个 Kit 目录同时拥有打包用 `kit.json` 和运行时 `package.json` descriptor。两者的 id/name 与 version 必须一致。`distribution=builtin` 的 descriptor 参与本地装配，且只能有一个声明 default 角色；`distribution` 是本地装配和打包元数据，不触发远程分发。

`ce-editor.kit` 必须定义 `menuRoot`、含 `default` 的 layouts、window entries、普通插件列表与可选的 application-scope `startup.plugins`。同一 package name 不能同时出现在启动插件和 session 插件中。插件的权限由 Kit permission 和插件 capability 共同约束。

## 本地解析

Web host 从显式 Kit sources 构建 Catalog。默认稳定入口装配 `kits/default`；开发入口可扫描动态发现的 builtin Kit 目录，但仍以 descriptor 而非硬编码 slug 决定身份。Server 会重新校验运行时 manifest，不从任意 URL 或未声明目录加载代码。

`GET /api/kits` 只返回 Catalog 的公开投影，不暴露本地路径、manifest 位置或插件列表。裸根页面渲染 Kit 选择器，`/kits/<menuRoot.id>` 进入现有 `?kit=<package-name>` 加载路径。

### Kit 身份边界

Kit identity 只由当前 descriptor 定义。Framework 不自动复制旧 Kit namespace 的配置、Credential
profile、Keyring secret 或浏览器布局缓存；重命名后的 Kit 使用自己的当前 ID 和默认布局。

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
- [`kits/harness/`](../../kits/harness/)
