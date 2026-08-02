# Kit 自包含功能单元设计

## 背景

Harbors 已经把产品源码集中到 `kits/<slug>`，并以 Kit 作为运行、安装和发布单元，但源码所有权仍然跨越
Kit 目录。最近新增 Agent Guard、TraceWeave、Scheduler 和 Skill Manager 时，除各自 Kit 外分别修改了
10 至 38 个非文档、非锁文件路径。重复出现的耦合包括：

- 根 `package.json` 手工维护 Kit 测试名单；
- `packages/<kit>-contracts` 保存只被单个 Kit 使用的协议；
- 构建图、CI 选择器、发布正则和测试重复维护官方 Kit 名单；
- `registry/policy.json` 同时承载信任治理、展示信息和 CI runner；
- Agent Guard 的数据目录和环境变量进入 Electron、Server 与桌面启动代码；
- Notifications 的 Skill 资源构建使用 Kit 外专属脚本；
- SQLite 与 MySQL 通过仓库源码包共享可变的 Relationship Graph 实现；
- 根锁文件包含所有 Kit 的产品依赖。

这些耦合使 Kit 虽然是发布单元，却不是功能修改单元。修改一个 Kit 的协议、依赖、构建或宿主集成时，
仍需要理解并修改 Framework 文件，而且名单漂移已经产生实际缺陷：TraceWeave 发布标签未被发布正则接受，
TraceWeave contracts 变更也不会触发对应 Kit CI。

## 目标

1. 每个 `kits/<slug>` 是完整的功能源码所有权边界。
2. 普通 Kit 功能变更，包括协议、依赖、资源、测试、构建和产品文档，只修改当前 Kit 目录。
3. 根构建、测试、CI、开发和发布工具通过发现与 manifest 工作，不手工登记 Kit 名称或专属路径。
4. Kit 只依赖稳定的 Framework 公共接口，不依赖其他 Kit 或 Kit 外的产品专属源码。
5. 桌面专属能力通过通用、权限约束的宿主 API 提供，不把 Kit 名称或专属环境变量写入宿主。
6. 自动化门禁同时验证源码边界、依赖边界、变更路径和隔离构建。
7. 全部现有 Kit，包括 builtin Default Kit，都迁移到同一套目录契约。

## 非目标

- 不把 Kit 拆成独立 Git 仓库。
- 不取消 `main` 作为唯一长期源码分支。
- 不改变 `.hkit` 的签名、摘要、安装、激活、回滚或撤回信任模型。
- 不允许 Kit 自行修改市场信任、发布者或 signer policy。
- 不要求 Kit 在没有 Harbors SDK 和通用构建工具的环境中独立运行。
- 不在本次整理中新增用户可见产品功能或重新设计 Kit UI。
- 不通过长期兼容层保留新旧两套 Kit 发现、依赖或宿主参数机制。

## 需求摘要与成功定义

“只修改当前 Kit”按 Git 变更路径定义，而不是按运行时结果或开发者意图定义。一个普通 Kit 功能分支从
基线到 HEAD 的所有受版本控制文件必须位于 `kits/<slug>/**`。以下两类工作是明确例外，但必须成为独立
Framework 或治理变更，不能与 Kit 功能提交混合：

1. 新增或修改真正通用的 Framework 公共能力；
2. 新 Kit 的一次性市场准入、发布者或 signer 治理。

依赖升级、协议调整、测试夹具、构建参数、CI runner、smoke 脚本和产品文档都不属于例外。修改这些内容
必须只触碰当前 Kit。

最终成功需要同时满足：

- `kit-workflow` 拒绝单 Kit 分支中的 Kit 外变更；
- 每个 Kit 可以在隔离临时目录中完成依赖安装、构建、测试、打包和 inspect；
- 根工具和 Framework 生产代码中不存在 Kit 专属名称、路径、协议或环境变量，治理文件除外；
- 新增一个不在测试夹具名单中的临时 Kit，无需修改根代码即可被开发、构建、测试和 CI 选择；
- 修改一个 Kit 的任意自有文件只选择并验证该 Kit，修改公共 Framework 接口才选择全部受影响 Kit；
- 完整构建、测试以及 Web/Electron 对应验收通过。

## 当前状态

### 目录与依赖

根 npm workspace 当前包含 `kits/*`。所有 Kit 共享根 `package-lock.json`，因此 Kit 增删第三方依赖必然修改
Kit 外文件。CSV、SQLite、MySQL、Agent Guard 和 TraceWeave 的私有 main/panel 协议位于根
`packages/*-contracts`；构建器在 `scripts/lib/build-tasks.mjs` 中逐个注册这些 workspace 和依赖关系。

SQLite 与 MySQL 还共同引用 `packages/relationship-graph`。这使关系图内部修改天然成为多产品变更，无法把
任一数据库 Kit 作为独立功能所有者。

### 发现、测试与发布

`OFFICIAL_KIT_SLUGS`、Registry policy、CLI usage、发布标签正则、CI 测试夹具和根 test script 重复保存
Kit 集合。CI 选择器还需要手工维护 Kit 外 contracts 到消费者 Kit 的映射。

`kit.json` 已声明兼容版本、平台、ABI 和权限，但展示摘要和 CI runner 位于中央 policy。根文档与文档测试
也维护产品清单，新增 Kit 时必须同步修改多个 Kit 外文件。

### 宿主能力

Application plugin 与 Session plugin 的通用 request 接口已经存在，并被多个 Kit 使用，应继续作为
Framework API。相反，`HARBORS_AGENT_GUARD_DATA_DIR` 和 `agentGuardDataDir` 只服务 Agent Guard，却贯穿
Electron、desktop framework 和 Server 参数。Notifications 的资源准备也由根专属脚本识别固定插件路径。

## 方案比较

### 方案 A：只消除静态名单

保留根 workspace、根锁文件、外置 contracts 和专属宿主参数，仅将官方 Kit 名单改为目录扫描。

优点是改动小、迁移快。缺点是依赖、协议和宿主变更仍跨目录，只解决表面登记成本，不满足目标。

### 方案 B：Monorepo 内聚但共享根依赖锁

把 contracts、测试与专属脚本迁入 Kit，并将工具改成动态发现，但继续让 `kits/*` 属于根 workspace。

该方案能消除大部分代码耦合，却无法让依赖变更局限于 Kit：npm 必须更新根 `package-lock.json`。它适合把
“只改当前 Kit”解释为只改手写源码，但不符合本设计采用的 Git 路径定义。

### 方案 C：严格产品胶囊

每个 Kit 是独立 npm workspace root，拥有自己的锁文件、内部 packages、脚本、测试和资源。根工具只消费
通用 Kit 契约，宿主只提供通用 capability。市场治理仍在根目录，但只在准入或信任变化时修改。

该方案迁移成本最高，也会增加本地安装和缓存管理复杂度，但它是唯一能直接证明目标成立的方案，因此采用。

## 总体架构

目标目录结构为：

```text
kits/<slug>/
├── kit.json
├── package.json
├── package-lock.json
├── layout.json
├── main.html
├── secondary.html
├── packages/
│   ├── contracts/
│   └── <kit-local-library>/
├── plugins/
├── resources/
├── scripts/
├── tests/
└── README.md
```

每个 Kit 根 `package.json` 是一个独立 npm workspace root，按需要声明 `packages/*` 与 `plugins/*`。Kit 内部
协议和库可以使用 package name，但只能由同一 Kit 的 workspace 提供。根 `package.json` 不再把 `kits/*`
纳入 workspaces，根锁文件也不再包含 Kit 产品依赖。

Framework 与 Kit 的关系是“平台与插件产品”，而不是一个共享源码 workspace：

- Framework 提供版本化 Kit manifest schema、plugin API、构建器、测试 harness 和宿主 capability；
- Kit 通过 manifest 和公共接口消费这些能力；
- Framework 可以扫描、启动和验证 Kit，但不拥有 Kit 的协议、产品依赖或专属数据；
- Kit 不能引用 Framework 私有源码路径，只能使用公开 package 或测试 harness 接口。

`harbors-kit` 命令由 Framework runner 以精确版本注入 Kit 生命周期的 `PATH`，角色类似编译器，而不是
Kit 产品依赖。Kit lockfile 只锁定 Kit 内部 workspace 与第三方产品依赖。runner 在执行前把自身版本与
`kit.json.requires` 校验，并把该版本纳入构建缓存键；Kit 不能通过 manifest 提交任意 CLI 路径或覆盖 runner。
仓库内验证使用当前分支构建出的 runner 制品，隔离验收显式挂载同一制品，不通过相对路径读取 Framework 源码。

## 详细设计

### Kit 自描述元数据

Kit 的运行和发布元数据继续放在 `kit.json`；只影响仓库开发的元数据放在 Kit 根 `package.json` 的
`harbors` 字段。目标结构为：

```json
{
  "name": "@itharbors/kit-example",
  "private": true,
  "workspaces": ["packages/*", "plugins/*"],
  "scripts": {
    "build": "harbors-kit build",
    "test": "harbors-kit test",
    "smoke": "harbors-kit smoke"
  },
  "harbors": {
    "ci": { "runner": "ubuntu-latest" },
    "docs": { "summary": "Example Kit" }
  }
}
```

`harbors.ci.runner` 必须属于 Framework 支持的 runner 集合。目标平台和 ABI 仍由 `kit.json.target` 决定；
runner 只是仓库验证环境，不能放宽制品 target。产品 label 从 runtime manifest 的 menu root 读取，市场摘要从
Kit 本地元数据读取。中央 policy 不再复制 label、summary 或 runner。

Default Kit 使用相同契约，并在 manifest 中声明 builtin distribution。稳定构建、桌面 staging 和 Catalog
从该声明发现 builtin，不再维护 `BUILTIN_KITS` 常量。市场发布器拒绝 builtin distribution。

### 发现与身份

通用 loader 扫描 `kits/*/kit.json`，只接受真实目录、合法 slug、匹配的 `kit.json.id` 与 package name，
并返回不可变描述对象。不同消费者在该单一描述上施加自己的策略：

- 本地开发和完整 CI 使用所有合法 Kit；
- 稳定桌面构建只使用 builtin distribution；
- 发布仅接受 Tag 中的 slug、合法目录以及中央 policy 已批准身份的交集；
- Registry 只接受受 policy 信任的 Release，不因为仓库目录存在而自动建立市场信任。

发布标签解析改为通用 canonical slug 语法，再由 loader 和 policy 校验，不把 slug 集合编码在正则中。CLI usage
显示动态发现结果或通用 `<kit-slug>`，测试使用临时 Kit fixture 证明没有静态名单。

### 独立依赖与构建

根安装只安装 Framework workspace。Kit 安装器按 Kit 根执行严格 lockfile 安装，并使用由 Kit lock hash、平台、
架构和 Node ABI 构成的缓存键。一个 Kit 安装失败只使该 Kit 不可构建，不污染其他 Kit 的 `node_modules`。

根构建编排器发现 Kit 后调用统一生命周期，不解析产品依赖名称：

1. 验证 Kit manifest、package metadata 和 lockfile 一致；
2. 准备或复用该 Kit 的隔离依赖目录；
3. 调用 Kit 自己声明的 build/test/smoke script；
4. 使用通用 pack/inspect 工具验证 `.hkit`；
5. 将结果按 Kit identity 汇总。

Kit 内部 contracts 迁到 `packages/contracts`。现有 `packages/agent-guard-contracts`、
`packages/csv-contracts`、`packages/mysql-contracts`、`packages/sqlite-contracts` 和
`packages/traceweave-contracts` 从根 workspace 删除。插件只解析同 Kit workspace、第三方依赖与公开 Framework
SDK；构建器拒绝未声明或指向 Kit 根外的本地 file/workspace dependency。

### 共享产品代码

“多个 Kit 使用”不自动意味着代码属于 Framework。共享代码只能采用以下一种所有权模型：

1. 稳定平台能力：具有独立公共契约、版本和兼容策略，Kit 只升级依赖，不与功能提交同步修改；
2. Kit 本地实现：代码复制或按产品需求分别实现，修改只影响当前 Kit。

`relationship-graph` 当前承载数据库产品 UI，且 SQLite/MySQL 会随产品需求共同修改，不满足稳定平台能力条件。
迁移时在两个数据库 Kit 内分别建立本地 package。允许短期代码相同，但禁止源码级跨 Kit import。未来只有在其
API 和发布生命周期真正稳定后，才能通过独立设计将其重新提升为公共 SDK。

### 通用宿主 capability

宿主 API 按能力命名，不按 Kit 命名。每个 application/session plugin context 提供基于真实插件身份派生的
私有存储目录：

```ts
interface PluginPaths {
  readonly data: string;
  readonly cache: string;
  readonly temp: string;
}

interface PluginContext {
  readonly paths: PluginPaths;
}
```

宿主创建目录、拒绝符号链接逃逸并控制权限；路径只交给对应 main plugin，不进入 Panel bootstrap 或公开 Catalog。
Agent Guard 使用 `context.paths.data`，删除 `HARBORS_AGENT_GUARD_DATA_DIR`、`agentGuardDataDir` 及全部宿主专名。

原生通知等桌面能力通过 permission-gated application capability 暴露。Kit 提交声明能力请求，宿主根据
`kit.json.permissions`、plugin owner 和当前 host 类型决定是否提供；Web host 返回明确的 unsupported capability
错误或使用已定义的 Web 实现。宿主 API 不识别 Notifications Kit 名称。

Kit 专属资源由 `kit.json` 或 Kit 本地 build metadata 声明。通用打包器复制声明资源并执行路径安全检查，删除
Notifications 固定路径和 Agent Guard 专属 smoke 根脚本。

### 工作流与变更边界

`kit-workflow` 的 start 仍从 `origin/main` 创建 `kit-change/<kit>/<type>/<change-slug>` 分支。finish 在任何构建或 push
前计算基线到 HEAD 的受版本控制路径，并要求每个路径位于 `kits/<slug>/`。符号链接、submodule、重命名来源或
目标越界都拒绝。即使 Kit build 和测试通过，路径违规仍不能完成 PR。

需要新宿主能力时必须拆成两个变更：

1. Framework 变更在普通 `<type>/<slug>` 分支增加通用 API、测试和文档；
2. Framework 合并后，Kit 分支只在自身目录消费已存在 API。

新增 Kit 时，产品目录和一次性中央 policy 修改也必须分开审查。policy 变更仅批准 identity、publisher、repository
与 signer/workflow 信任，不承载产品展示或 CI 元数据。

### 文档边界

根文档只描述通用 Framework、Kit 契约和发现方式，不枚举当前产品。每个 Kit 的功能、使用、限制、验证命令和
产品架构保存在自身 README。需要展示产品集合的页面从 manifests 生成，生成产物不作为手工维护的源码。

文档测试验证通用规则以及每个发现 Kit 的 README 契约，不保存 slug 数组或 Kit 专属文案。

## 数据设计

本次不改变用户业务数据 schema。迁移只改变开发依赖与 plugin storage path：

- 每个 Kit 新增自己的 lockfile 和依赖安装目录；
- plugin data/cache/temp 路径由稳定 plugin identity 计算；
- Agent Guard 现有数据目录需迁移到新通用路径，优先采用同文件系统原子 rename；
- 目标已存在、权限异常或迁移失败时保留旧数据并拒绝覆盖，记录可操作诊断；
- 成功迁移后保留兼容读取一个版本窗口，但所有新写入只进入新路径；兼容窗口结束另行删除旧数据，不在本次
  自动删除用户文件。

路径映射属于宿主内部状态，不向 Renderer、Registry 或 `.hkit` 暴露用户绝对路径。

## API 与接口

### Kit descriptor

通用 loader 输出至少包含：

```ts
interface RepositoryKitDescriptor {
  readonly slug: string;
  readonly directory: string;
  readonly id: string;
  readonly distribution: 'builtin' | 'market';
  readonly target: KitTarget;
  readonly permissions: readonly KitPermission[];
  readonly ciRunner: SupportedRunner;
  readonly summary: string;
  readonly scripts: Readonly<{
    build: string;
    test: string;
    smoke?: string;
  }>;
}
```

`directory` 只供仓库工具和宿主内部使用，不进入公开 API。所有字段在 loader 边界标准化并冻结。

### 构建生命周期

通用命令保持面向 slug：

```text
npm run kit:install -- <slug>
npm run kit:build -- <slug>
npm run kit:test -- <slug>
npm run kit:check -- <slug> --output-directory <absolute-path>
npm run kit:boundary -- <slug> [--base <commit> --head <commit>]
```

未知、无效或未锁定 Kit 返回非零状态。命令不接受任意 build command、环境变量或 Kit 外输出目录声明。

### 宿主 capability 错误

通用错误至少区分：

- `CAPABILITY_UNSUPPORTED`：当前 Web/Electron host 不提供能力；
- `CAPABILITY_NOT_PERMITTED`：manifest 未声明所需权限；
- `PLUGIN_STORAGE_UNAVAILABLE`：安全创建或验证 plugin 目录失败；
- `RESOURCE_DECLARATION_INVALID`：资源缺失、越界或类型不合法。

错误不包含其他 Kit 路径、用户目录结构或宿主内部 token。

## 权限、安全与隐私

- Kit 本地 workspace dependency 必须解析到当前 Kit 真实目录内；拒绝 `file:` 越界、符号链接和路径穿越。
- lockfile 必须与 package manifests 一致，CI 与发布只使用 `npm ci`，不在检查过程中隐式更新 lockfile。
- capability 以加载时验证的 Kit/plugin owner 绑定，Renderer 不能伪造 Kit id 或提交文件路径。
- storage path 由宿主计算，不接受 Kit 提供的绝对路径；目录权限沿用现有用户数据安全要求。
- 中央 policy 继续是市场信任根，目录扫描不能自动授权发布或安装。
- boundary checker 使用 Git 的 NUL 分隔路径记录并校验 rename 两端，避免控制字符、空格或路径规范化绕过。
- 隔离构建不读取其他 Kit 的源码或 `node_modules`，防止未声明依赖在开发机上偶然成功。

## 可靠性与失败处理

- 单个 Kit manifest、lockfile 或 install 失败时，定向命令失败；完整矩阵报告该 Kit，但继续收集其他 Kit 结果。
- stable runtime 遇到损坏的非 builtin 开发 Kit 时保持现有隔离语义；builtin 无效则在启动前失败。
- 构建缓存只在 lock hash、工具链版本、平台、架构和 ABI 全部匹配时复用；不完整写入通过临时目录和原子发布避免。
- capability 不支持或无权限时只回滚对应 plugin load，不修改其他 Kit runtime。
- Agent Guard 数据迁移失败时不删除旧目录、不创建部分成功标记，允许下一次启动安全重试。
- 发布在发现、policy、版本、lock、build、test、pack、inspect 任一步失败时不创建 Release。
- 迁移分支最终一次性删除旧入口；不会在合入 `main` 后保留根锁与 Kit 锁、专属 env 与通用 paths 两套可写机制。

## 性能与容量

独立 Kit 安装会增加首次开发准备时间和磁盘中的重复依赖。通过按 Kit lock hash 的内容缓存和并发安装互不相关的
Kit 控制成本。定向 Kit 变更只安装和验证一个 Kit，预期显著快于当前根 `npm test` 全串行矩阵。

完整 CI 可以并行运行 Kit matrix；同一 runner 内不共享可变 `node_modules`。构建器发现只读取一层 `kits/*` 的
小型 manifests，不递归扫描任意目录。运行时 Catalog 继续消费经过验证的来源快照，不在请求路径动态安装依赖。

## 可观测性

仓库工具为每个 Kit 输出结构化阶段记录：identity、install、build、test、smoke、pack、inspect 和 boundary。
记录包含 slug、阶段、耗时、缓存命中和归一化错误码，不输出用户绝对路径、环境凭据或依赖 registry token。

CI summary 明确列出选择原因，例如 `changed:kits/sqlite/**` 或 `framework-api-change`。boundary 失败列出仓库相对违规
路径。宿主 capability 日志记录 capability 名和不透明 owner identity，保持现有敏感路径约束。

## 测试计划

### 契约与单元测试

- loader 使用临时目录验证动态发现、identity、builtin/market、runner 和非法 manifest 拒绝。
- 发布标签测试使用未预登记在测试源码中的临时 slug，证明正则与代码无名单。
- build graph 从 Kit 本地 workspace manifests 推导依赖，覆盖未知依赖、循环、越界和 lock 漂移。
- boundary checker 覆盖普通文件、rename、符号链接、空格、控制字符、多个 Kit 和 Kit 外路径。
- capability 测试覆盖权限、owner 绑定、Web unsupported、路径创建和安全错误脱敏。

### Kit 隔离验收

对每个发现到的 Kit：

1. 只复制目标 `kits/<slug>` 到临时目录；
2. 通过显式提供的 Framework SDK/toolchain 执行该 Kit 的 `npm ci`；
3. 构建 Kit 内部 packages 与 plugins；
4. 运行 Kit 单元、集成和 smoke tests；
5. pack 并离线 inspect `.hkit`；
6. 搜索产物，确保没有绝对仓库路径、其他 Kit 源码或未打包 workspace dependency。

Framework compatibility tests 使用公开测试 harness 加载制品，不允许 Kit 测试直接 import `packages/server/src/**`。

### 选择与变更面验收

- 只修改 `kits/<slug>/**` 时只选择该 Kit。
- 修改任意 Kit 本地 contracts、lockfile、资源或脚本时仍只选择该 Kit。
- 修改公共 Framework API 时选择完整兼容矩阵。
- 新增临时 Kit 目录后，根 build/test/CI/CLI 不修改源码即可发现并验证它。
- 根生产代码和通用测试中搜索 Kit slug、`@itharbors/kit-*` 专名与 Kit 专属 env；仅治理文件和明确 fixture 可出现。

### 运行时验收

普通 Kit 共享行为以 `npm run dev:web` 和浏览器为默认验收。Agent Guard storage、Notifications native capability、
Tray/BrowserWindow 或桌面 IPC 相关迁移必须补充 Electron 验收。完整迁移最终同时验证 Web 选择、Kit session 加载、
application plugin、桌面启动、Kit Manager 安装/激活/回滚和 stable builtin 启动。

## 迁移与发布计划

迁移在一个隔离的仓库级 refactor 分支完成，但按可审查阶段提交：

1. 建立动态 descriptor、boundary checker 和失败测试，不迁移产品代码；
2. 使根 build/test/CI/publish/docs 从 descriptor 派生，删除静态名单；
3. 将所有 Kit contracts、专属脚本和资源迁回所属目录；
4. 将每个 Kit 改成独立 npm workspace root 和 lockfile，移除根 `kits/*` workspace；
5. 将 Relationship Graph 分别归入 SQLite/MySQL，清除 Kit 间可变源码依赖；
6. 增加通用 plugin paths/capability，迁移 Agent Guard 与 Notifications，删除宿主专名；
7. 迁移 Default Kit builtin 声明，删除 builtin 静态名单；
8. 更新通用文档并执行全部静态、隔离、Web 和 Electron 验收。

阶段提交可以暂时包含尚未迁移的兼容测试，但合入 `main` 的最终状态不保留双机制。若完整分支无法通过验收，不拆分
合入产生半迁移状态；保留现有 `main` 并在分支继续修复。用户数据迁移不执行不可恢复删除。

## 风险与权衡

| 风险或代价 | 处理 |
| --- | --- |
| 多个 Kit lockfile 增加升级与磁盘成本 | lock hash 缓存、定向安装和自动依赖更新；以独立变更面优先于单锁便利性 |
| 本地 contracts package 迁移影响模块解析 | 先建立隔离构建失败测试，再逐 Kit 迁移并检查产物无 workspace 残留 |
| Relationship Graph 复制产生代码重复 | 明确产品所有权；只有形成稳定独立生命周期后才重新抽取公共 SDK |
| 通用 capability 可能被设计成 Kit 特例的改名 | API 评审禁止 Kit 名称，并要求通用权限、owner、Web/Electron 语义和独立测试 |
| 一次性迁移范围较大 | 细分提交、每阶段测试、最终原子合入，不保留长期双机制 |
| 产品清单从文档消失降低可发现性 | 从 manifests 生成展示，不让手写根文档成为源码注册点 |
| Kit 隔离测试耗时 | 定向 CI、matrix 并行和内容缓存；Release 仍执行完整目标 Kit 验证 |

## 被拒绝的替代方案

- 把根 lockfile 当作“生成文件例外”：它仍是受版本控制变更，无法满足可机械验证的路径边界。
- 为每个新 Kit 继续扩展中央名单：重复源已经导致发布和 CI 漏项。
- 将所有共享产品代码提升为 Framework：这会把功能所有权转移到更大的公共包，继续要求跨目录修改。
- 允许 Kit 直接读取宿主环境变量或用户目录：缺少 owner、权限和 host 兼容语义，也会把专名泄漏到宿主。
- 长期保留兼容入口：双机制会让新变更继续选择阻力更小的旧路径，边界无法真正收口。

## 需求覆盖矩阵

| 产品要求 | 技术覆盖 | 状态 | 说明 |
| --- | --- | --- | --- |
| Kit 是功能单元 | 独立 workspace root、内部 packages、资源、测试与 lockfile | Covered | 全部现有 Kit 包括 Default 统一迁移 |
| 功能修改只改当前 Kit | Git 路径定义、`kit-workflow` finish 门禁 | Covered | 协议、依赖、构建和文档均计入 |
| 根工具无需登记 Kit | descriptor 动态发现与消费者策略 | Covered | 发布信任仍由中央 policy 控制 |
| Kit 不依赖其他 Kit | 依赖边界检查、隔离复制构建 | Covered | Relationship Graph 本地化 |
| 宿主不包含 Kit 特例 | plugin paths 与 permission-gated capability | Covered | 删除 Agent Guard/Notifications 专名入口 |
| 修改公共能力时可改 Framework | 独立 Framework 变更流程 | Covered | 禁止与 Kit 功能提交混合 |
| 新 Kit 需要治理准入 | policy 只保存信任字段 | Covered | 一次性、单独审查的例外 |
| Web/Electron 行为保持 | 公共 harness、Web 默认和桌面专项验收 | Covered | 桌面能力必须补充 Electron |
| 迁移可恢复 | 分阶段提交、最终原子合入、数据保留 | Covered | 不自动删除旧用户数据 |
| 边界可持续执行 | static、diff、isolated build、CI selection 四层门禁 | Covered | 不依赖人工约定 |

## 已确认假设与决策

- “只修改当前 Kit”采用严格 Git 路径语义。
- 市场信任治理和真正通用的 Framework API 是仅有的 Kit 外例外，且必须单独提交。
- 采用严格产品胶囊方案，接受多 lockfile、局部重复和迁移成本。
- 公共工具链属于稳定平台依赖；功能单元自包含不等于复制 Framework SDK 源码。
- 当前没有阻塞实施的开放问题；若实现证据推翻某项技术可行性，必须回到设计评审，不能静默缩小目标。
