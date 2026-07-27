# Kit 来源统一与启动模式设计

## 背景

Harbors 当前同时存在仓库 Kit 与 Kit Manager 安装 Kit 两条来源。Electron 的 Catalog 会扫描
`rootDir/kits/*`，再追加 InstalledKitStore 的 active 目录。由于本地 `npm run start` 的 `rootDir`
就是仓库根目录，它会把 CSV、SQLite、MySQL、Notifications 等开发源码全部识别为 builtin；这与
正式桌面包只内置 Default Kit、其余 Kit 由市场下载安装的产品语义不一致，也会让同 ID 的源码 Kit
与商城 Kit 在 Catalog 校验时冲突。

本设计不增加新的 npm 子命令。它统一 Kit 的来源描述、身份解析和 Catalog 构建，同时保留
`npm run dev` 的全 Kit 联合开发效率。

## 目标

1. Kit 只有一套发现、身份校验、冲突解析和 Catalog 构建机制。
2. `npm run start` 只发现内置 Kit，以及用户已经安装并激活的 Kit，不扫描普通仓库 Kit。
3. `npm run dev` 在相同机制上额外加入仓库 `kits/*` 开发源码。
4. 同一个 Kit ID 在一个进程中最多选择一个运行目录。
5. 内置 Kit 与商城 Kit 的 ID 永久互斥；Kit Manager 在安装前拒绝内置 ID。
6. 同一商城 Kit 可以保留多个不可变版本，但只有 `installed.json.active` 指向的版本参与启动。
7. 来源冲突只隔离冲突 Kit，不让一个异常安装阻止整个桌面应用启动。

## 非目标

- 不改变 `.hkit`、Registry、Release、签名、摘要与兼容性校验协议。
- 不新增 `start:prodlike`、`start --only-kit` 等入口。
- 不支持运行中热替换 Kit。
- 不在本次实现卸载或垃圾回收旧版本。
- 不允许市场版本更新或覆盖内置 Kit；内置 Kit 随 Framework 发布。

## 统一来源模型

所有来源先转换为同一种内部记录，再进入身份解析器：

```ts
type KitSourceKind = 'builtin' | 'installed' | 'development';

interface KitSourceCandidate {
  kind: KitSourceKind;
  directory: string;
  installed?: {
    id: string;
    version: string;
    digest: string;
    source: InstalledKitPublicationSource;
  };
}
```

解析器读取并验证候选目录中的 manifest，产生带 `id`、`version`、`menuRoot`、`directory` 和
`kind` 的统一条目。Catalog、Tray、Workspace、Session 和 Server 运行时只消费解析后的条目，不再
各自猜测目录来源。

来源目录如下：

| 来源 | 开发环境 | 正式安装包 |
| --- | --- | --- |
| builtin | 仓库中显式声明的内置目录 | `<resources>/runtime/kits/<slug>` |
| installed | `<userData>/kit-store/kits/<encoded-id>/<version>` | 同左 |
| development | 仓库 `kits/*` 中除内置目录外的合法 Kit | 不启用 |

内置 Kit 使用显式清单，而不是通过扫描仓库推断。首个版本的清单只包含 `default`；桌面打包和运行时
发现共同消费这份清单，防止“打包了什么”和“运行时认为内置了什么”分叉。

## 启动语义

### `npm run start`

`start` 使用 stable profile，但仍可从源码启动 Electron。它向统一解析器提供：

1. 显式内置 Kit 清单对应的目录；
2. InstalledKitStore 中完成 pending 校验后的 active 目录。

它不枚举仓库 `kits/*`。没有已激活商城 Kit 时，Tray 只显示内置 Kit；用户通过 Kit Manager 安装并
激活 Kit，重启后该 Kit 才加入 Catalog。

### `npm run dev`

`dev` 提供与 `start` 相同的 builtin、installed 候选，并额外扫描仓库 `kits/*` 作为 development
候选。这样开发者可以联合调试所有 Kit，不需要先从市场安装当前仓库源码。

development 候选只影响当前开发进程，不写入 `installed.json`，也不改变用户已安装版本的 active、
pending、previous 或 bad 状态。

### 正式桌面包

正式包与 `start` 使用相同来源策略。区别只在于 builtin 根目录位于只读的 packaged resources；
用户安装内容始终写入 Electron `userData/kit-store`。

## 身份冲突与选择规则

冲突按 Kit package ID 判断，最终 Catalog 仍要求 `menuRoot.id` 唯一。

正常产品规则是：

- builtin ID 不能从市场安装；
- installed 每个 ID 只读取 active 版本；
- development 不属于安装状态，只是当前开发进程的临时输入。

防御性选择顺序为：

```text
development > builtin > installed
```

该顺序不是商城覆盖机制，而是异常隔离策略：

- development 与 installed 同 ID 时，当前开发进程使用 development，并记录可见警告；
- builtin 与 installed 同 ID 时，使用 builtin，将 installed 标记为来源冲突并禁止启动；
- 同一 kind 出现两个不同目录但 ID 相同，两个候选都不进入 Catalog，并报告配置错误；
- 不按 SemVer 高低选择来源。

一个 Kit 的冲突不得删除任何文件或修改 active 指针。Kit Manager 展示冲突状态，用户仍可看到安装
记录和版本信息；后续卸载能力另行设计。

## 安装与激活边界

Kit Manager 在解析可信 Registry 条目后、开始下载前，使用同一份 builtin ID 集合做预检。目标 ID
属于 builtin 时返回稳定错误码 `BUILTIN_KIT_ID`，不创建下载文件、staging 目录或 installed 记录。

安装事务仍只负责把通过校验的版本写入：

```text
<userData>/kit-store/kits/<encoded-kit-id>/<version>/
```

安装成功不自动激活。激活仍写入 pending，并在重启时经过 Catalog 与真实 runtime 两层验证。来源
解析发生在 Catalog 校验之前，因此冲突的 installed Kit 不会进入 application-scope 插件或 Session。

## Catalog 与 Server 数据流

Electron 是桌面模式下的来源权威：

1. 收集当前 profile 允许的候选来源；
2. 统一解析 manifest 与 installed publication identity；
3. 应用冲突规则，生成 resolved entries 与 diagnostics；
4. Electron Tray 使用 resolved entries；
5. Framework 子进程接收同一份已解析目录快照，不再重新扫描仓库得到另一套集合；
6. Server 重新校验运行时 manifest，但不改变来源选择结果。

独立 `npm run dev:web` 没有 Electron，因此由开发启动器调用同一来源收集与解析模块，并把 resolved
目录快照交给 Server。Web 与 Electron 因而共享启动语义，而不是维护两套 Catalog 模式。

对外 `GET /api/kits` 仍只返回公开的 `id`、`name` 和 `label`，不暴露本地路径、来源元数据、摘要或
安装状态。

## 错误处理

- builtin manifest 无效：桌面启动失败，因为应用包自身损坏。
- installed manifest、identity 或摘要元数据无效：隔离该 Kit，保留其他 Kit 可用，并写审计记录。
- development manifest 无效：忽略该候选并输出带目录的开发日志，不污染用户安装状态。
- builtin/installed ID 冲突：builtin 继续可用，installed 显示 `BUILTIN_KIT_ID` 冲突。
- development/installed ID 冲突：development 进入 Catalog，installed 被临时遮蔽并输出警告。
- `menuRoot.id` 跨不同 Kit 冲突：隔离所有冲突条目，不任意选择其中一个。
- resolved Catalog 为空：保持现有确定性启动错误。

生产日志和公开 API 不输出用户 Store 绝对路径、Registry 下载 URL、digest 或 Commit。

## 测试与验收

### 来源解析

- stable profile 只收集显式 builtin 与 active installed，不枚举普通仓库 Kit；
- development profile 额外收集全部合法仓库 Kit；
- development 遮蔽同 ID installed，但不修改 InstalledKitStore；
- builtin 遮蔽异常的同 ID installed，并产生诊断；
- 相同 kind 重复 ID 和跨 Kit `menuRoot.id` 冲突被隔离；
- 结果顺序保持确定性。

### Kit Manager

- builtin ID 在下载前返回 `BUILTIN_KIT_ID`；
- 被拒绝安装不创建 download、staging、version 目录或 installed 记录；
- 普通市场 Kit 的 install、pending activation、真实加载和 rollback 保持通过。

### 启动入口

- `npm run start` 的 Catalog 在空 Store 下只包含 Default Kit；
- `npm run start` 能加载一个已激活的商城 Kit；
- `npm run dev` 能发现 Default、CSV、SQLite、MySQL 与 Notifications；
- 安装同 ID 市场 Kit 时，`dev` 使用仓库源码并保留用户状态；
- packaged smoke test 继续验证 Default、Kit Manager 和动态安装 fixture Kit。

### 完成标准

1. Electron、Framework 和 Web 不再各自决定不同的 Kit 来源集合。
2. stable 与 packaged 模式只因物理根目录不同，不因发现规则不同。
3. 同一 Kit ID 在每个进程中最多有一个运行目录。
4. 一个冲突的用户 Kit 不阻止内置 Kit和其他合法 Kit 启动。
5. 现有 Kit 制品验证、激活回滚和 Session 隔离测试继续通过。
