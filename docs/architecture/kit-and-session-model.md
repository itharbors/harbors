# Kit 与会话模型

Kit 决定 Web 工作台具有哪些产品能力，session 负责隔离这些能力与运行时状态。Harbors Server 可在同一进程中承载多个 session，浏览器只渲染当前 session 的投影。

## Session 与 Editor

Session 的持久元数据存在 SQLite，运行时对象由 `SessionRuntimeRegistry` 在 Server 内存中管理。每个 Editor 独立持有 PluginModule、PanelModule、MessageModule、MenuModule、KitModule、WindowManager、config store 与 i18n 状态。路由可读取注册表的只读视图，但不得维护第二份运行时 map。

Web Host 的最小身份关系为 `User 1:N AuthorizedDevice` 与 `User 1:N Session`。`userId` 是 Server 生成的稳定 opaque ID，显示名只用于展示且允许重名；设备授权把远程设备绑定到一个 User，撤销设备不会删除 User 或 Session。Session 的 `ownerUserId` 是 HTTP、SSE、Panel asset 与消息路由的统一访问依据，Kit 复合 runtime ID 通过 `SessionRuntimeRegistry` 保存的 `runtimeId -> baseSessionId` 索引回到基础 Session，不允许把字符串拆分结果当作安全事实。

Session owner 只约束 Framework 的 Session/runtime HTTP 与 SSE 访问，不构成 Project、workspacePath 或文件系统级隔离，也不授予多人协作、目录沙箱或跨 Session 文件权限。需要工作区或文件系统安全边界时必须另行设计，不能从 `ownerUserId` 推导。

请求身份只有本地主机管理员、已授权设备对应的 User 与匿名三类。Gateway 会删除客户端提供的 `X-Forwarded-For`，再用真实入站 socket 地址覆盖；Server 仅在立即上游 socket 为 loopback 时接受这个单值合法 IP。远程直连 Server 时请求头不能覆盖真实 socket，也不能提升权限；本地经 Gateway 访问仍保持管理员身份。远程请求不能提交 `userId` 改变身份，只能访问 owner 与设备 User 匹配的 Session；无 owner 的旧 Session 仅在本地工作台显示，并可被管理员一次性归属。

SQLite 升级只增建 `users` 表并为授权设备、Session 增加 nullable owner 列。既有授权设备会获得独立兼容 User，既有 Session 保持未分配，原授权期限、Session 内容和运行数据都不删除。工作台通过 `/api/workbench/context` 获取不含本地路径的公开投影，通过 Server 分配的新 opaque Session ID 继续或新建工作台。

session 下的每个 Kit runtime 都拥有独立 Editor；同一基础 Session 可以同时具有多个 Kit runtime，但它们共享同一个 Session owner。URL 中后续出现其他 Kit 参数不会触发已存在 runtime 的隐式切换。空闲 session 由注册表统一回收，应用停止时先停止接受新请求，再逆序卸载插件。

## Kit descriptor 与 manifest

每个 Kit 目录同时拥有打包用 `kit.json` 和运行时 `package.json` descriptor。两者的 id/name 与 version 必须一致。`distribution=builtin` 的 descriptor 参与本地装配，且只能有一个声明 default 角色；`distribution` 是本地装配和打包元数据，不触发远程分发。

`ce-editor.kit` 必须定义 `menuRoot`、含 `default` 的 layouts、window entries、普通插件列表与可选的 application-scope `startup.plugins`。同一 package name 不能同时出现在启动插件和 session 插件中。插件的权限由 Kit permission 和插件 capability 共同约束。

`KitPackageManifest.legacyKitIds` 是可选的顶层字段，按声明顺序记录可迁移数据的旧 Kit ID。每个 ID
必须通过现有 Kit ID 规则校验；空值、非法值、重复值以及等于当前 `id` 的值都会被拒绝。声明顺序
具有确定性语义：配置和凭据迁移遇到多个旧来源时按该顺序处理，后续来源不能覆盖已经存在的当前值。

## 本地解析

Web host 从显式 Kit sources 构建 Catalog。默认稳定入口装配 `kits/default`；开发入口可扫描动态发现的 builtin Kit 目录，但仍以 descriptor 而非硬编码 slug 决定身份。Server 会重新校验运行时 manifest，不从任意 URL 或未声明目录加载代码。

`GET /api/kits` 只返回 Catalog 的公开投影，不暴露本地路径、manifest 位置或插件列表。裸根页面渲染 Kit 选择器，`/kits/<menuRoot.id>` 进入现有 `?kit=<package-name>` 加载路径。

### Kit 身份迁移与兼容边界

Kit descriptor 可声明 `legacyKitIds`，表示只用于配置 namespace 和 Credential Vault 的数据迁移来源，
不属于入口兼容列表。Framework 以通用规则执行迁移：新 namespace 已有值时优先，旧配置行、旧 credential
profile 与旧 secret account 成功迁移后保留，重复执行保持幂等；迁移失败不得删除或破坏旧数据。配置迁移
只处理持久化 SQLite layer，内存 layer 不迁移；每个 backend 独立完成事务，不承诺跨 layer 或跨文件的
总事务。凭据迁移由首次数据操作惰性触发，复制 profile 与 secret，并在 source/target scope 与 profile
ID 锁及 pending/recovery 语义下保证失败可重试。Harness 的 `model-service` 是当前首个消费者，但该
契约属于通用 Kit/Framework 能力，不是 Model Service 专属协议。

该字段不参与 Catalog、URL、CLI、resolver、`runtimeKit` 或公开 Bootstrap，因此不会为旧 ID 形成 alias、
重定向或默认 Kit 回退。旧数据清理不属于本 Task，必须另行授权。

Credential Vault 的 scope digest 包含当前 `kitId` 与 Plugin 名称，因此迁移必须同时复制 profile 和
Keyring secret，而不能只复制数据库记录。`list`、`get`、`put`、`delete` 的首次数据操作前才触发
lazy migration；`capability` 和 `available` 不触发写操作。当前 scope 中任意同 ID 记录（包括 pending、
deleting）都视为新值并优先保留；旧来源按 `legacyKitIds` 顺序处理。迁移在 source/target scope 与
profile ID 锁内创建 pending、写入新 secret account 并激活，既有 recovery 机制负责进程中断后的残留。
迁移 Promise 被拒绝时会从 cache 清除，下一次操作可以重试；Keyring 或数据库失败不得降级为空凭据，
且旧 profile 与旧 account 始终保留。

Kit 重命名不迁移浏览器布局缓存；新窗口入口使用新 Kit 的布局和窗口 ID，并从默认布局开始恢复。

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
