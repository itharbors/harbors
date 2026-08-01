# MySQL 本机凭据库设计

## 背景

MySQL Kit 当前由 `mysql-core` 独占 `mysql2` 连接池。连接 Panel 将 host、port、user、password、
database 和 TLS 选项发送给 core；请求发出后立即清空表单中的密码。密码不会写入 Session 数据库、
浏览器存储或配置文件，但连接存续期间会存在于 Server 进程和驱动连接池内。用户每次重新启动
Harbors 后仍需重新输入密码。

Harbors 同时有 Electron 和 Web 宿主。两者的 Kit main 都运行在 Node.js Framework/Server 进程；
差异不在于是否能够访问 Node，而在于部署身份：Electron 明确属于当前操作系统用户，Web 既可能是
本机单用户进程，也可能经反向代理供远程多人访问。一次请求的来源地址不能证明部署身份；远程请求
经过本机反向代理后，Server 看到的来源也可能是 `127.0.0.1`。

本设计为 Electron 与显式本机 Web 模式增加安全的连接记忆能力。远程多人凭据存储需要先建立用户
认证、租户隔离和服务端密钥管理，不在本次实现中提前模拟。

## 目标

- 允许用户保存 MySQL 连接配置和密码，并在后续启动中显式选择连接。
- 密码只进入操作系统凭据库，不把加密密钥、密码或可独立解密密码的材料写入仓库和应用数据文件。
- Electron 与本机 Web 复用同一套 Framework 凭据能力和 MySQL 协议。
- 只有显式本机单用户模式能够保存、读取或使用本机凭据。
- Kit 权限、当前 Kit 和调用插件共同约束凭据命名空间，其他 Kit 或插件不能猜测 ID 后读取 MySQL 密码。
- Panel 永远不读取已保存密码；使用已保存连接时，密码只在 Server 内部进入 `mysql-core` 和 `mysql2`。
- 安全后端不可用时拒绝保存和读取，不降级到明文、固定密钥或弱文件加密。

## 非目标

- 不为远程或多人 Web 部署实现登录、用户目录、租户、KMS、HSM 或 Secret Manager。
- 不支持跨设备同步、导入、导出或备份密码；普通连接配置可以备份，密码必须在目标设备重新录入。
- 不自动连接数据库，不在应用启动、Kit 装载或 Panel mount 时使用已保存密码。
- 不保护已经控制当前操作系统用户、Harbors 进程或 MySQL 服务端的攻击者。
- 不隐藏连接所必需的进程内秘密；活动连接期间，驱动必然需要在内存中持有认证材料。
- 不把数据库 TLS 与本机密码存储混为同一保障；两者分别保护网络链路和本机静态秘密。

## 威胁模型

本次设计防止以下泄露：

- 开源仓库、构建产物或安装包中出现通用解密密钥；
- 应用数据目录、Session SQLite、浏览器 localStorage、日志或错误响应泄露明文密码；
- 只复制 Harbors 普通数据文件或连接配置后，在另一台机器或另一个操作系统账户下恢复密码；
- 未声明凭据权限的 Kit，或同一 Kit 中未获授权的插件，调用宿主凭据能力；
- 远程 Web 请求因为经过 loopback 反向代理而误获本机凭据能力。

以下风险明确保留：

- 已控制当前用户账户或 Harbors 进程的恶意程序可能观察运行时内存、调用系统凭据能力或操纵 UI；
- Windows 等平台的系统凭据保护可能主要隔离不同登录用户，而不能隔离同一用户下的所有应用；
- 用户主动连接后，拥有该 Harbors 会话完整操作权的主体能够在数据库权限范围内执行操作。

## 方案比较与决定

### 方案一：按请求来源地址开启凭据

当 HTTP 请求来自 `127.0.0.1` 时允许保存和使用密码。实现量最小，但反向代理会让远程请求也呈现为
loopback，来源头可以被伪造，而且它不能限制 Kit/plugin 调用者。该方案不采用。

### 方案二：显式本机模式与系统凭据库

宿主在进程启动时确定不可变的凭据模式。Electron 使用 `local`；Web 只有显式请求 `local` 且所有
公开监听点实际绑定 loopback 时才能使用。Framework 提供 owner-bound 凭据能力，底层直接访问当前
操作系统用户的 Keychain、Credential Manager 或 Secret Service。该方案没有仓库密钥，不要求改造
现有用户系统，并为未来远程实现保留替换适配器的边界，因此采用。

### 方案三：立即建设多人服务端凭据系统

使用登录用户、租户授权和云 KMS envelope encryption 保存所有密码。它是未来远程部署的正确方向，
但当前仓库还没有相应身份模型；先做会产生虚假隔离或把产品绑定到未决定的基础设施，因此不采用。

## 部署模式与启动约束

新增不可变的 `credentialMode`：

| 模式 | 使用场景 | 本次行为 |
| --- | --- | --- |
| `off` | 默认 Web、远程 Web | 不注册凭据能力，MySQL 保持手工输入 |
| `local` | Electron、显式本机 Web | 注册本机系统凭据库 |
| `multi-user` | 未来远程部署 | 保留枚举值，本次启动时明确报未实现 |

Electron 装配固定传入 `local`。Web 默认 `off`；只有显式配置才能请求 `local`。请求 `local` 时，
Gateway、Server 和任何直接承载应用 API 的监听地址都必须解析为 `127.0.0.1` 或 `::1`。未指定监听
地址、`0.0.0.0`、`::`、主机名或非 loopback 地址均不合格，进程必须在打开端口前失败。判断不读取
`remoteAddress`、`Host`、`Forwarded` 或 `X-Forwarded-For`。

运行模式和只读可用性进入宿主 bootstrap 投影，Panel 只得到
`available | unavailable` 与稳定错误代码，不得到后端名称、操作系统路径或账户标识。

## 宿主凭据能力

Framework 新增 application-owned `CredentialVault`，但不通过当前通用
`application.request(plugin, method)` 暴露。`createPluginRuntime` 已知 owner plugin，因此为获准插件创建
绑定调用者的 facade：

```ts
type CredentialProfile = {
  id: string;
  label: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
};

type PluginCredentialVault = {
  available(): Promise<boolean>;
  list(): Promise<CredentialProfile[]>;
  get(id: string): Promise<{ profile: CredentialProfile; secret: string }>;
  put(input: {
    id?: string;
    label: string;
    metadata: CredentialProfile['metadata'];
    secret: string;
  }): Promise<CredentialProfile>;
  delete(id: string): Promise<void>;
};
```

实际 facade 不接受 namespace、Kit 名、plugin 名、用户 ID、服务名或系统账户名。Framework 根据当前
Kit、owner plugin 和本机 principal 派生内部 scope。首版只向同时满足以下条件的调用者提供 facade：

1. 当前 Kit 的 `kit.json` 声明新增 `credentials` 权限；
2. 当前 Kit 是调用插件的 owner Kit；
3. 调用插件自己的 `package.json` 在 `ce-editor.capabilities` 中声明 `credentials`；MySQL 只有
   `@itharbors/mysql-core` 声明该 capability；
4. 宿主 `credentialMode` 为 `local`。

权限不满足时，运行时不提供 facade；不能靠返回空列表伪装授权成功。`credentials` 属于高风险权限，
必须进入 Kit Registry 权限投影、安装提示、校验、attestation 和审计规则。权限只允许访问由宿主派生
的调用者命名空间，不允许枚举其他 scope。

## 本机后端

`LocalCredentialVault` 位于 Framework/Server，而不是 MySQL Kit。Electron 与本机 Web 的 Kit main
本来就在该 Node.js 进程中，因此两种宿主直接复用同一个实现，不新增 Renderer IPC，也不让 Panel
接触 Electron API。

本机适配器使用固定版本并纳入锁文件、SBOM 与发布审计的 `@napi-rs/keyring`，直接调用：

- macOS Keychain；
- Windows Credential Manager；
- Linux Secret Service。

适配器不得调用 shell 命令，也不得提供文件后端、CLI fallback、固定密钥、环境变量密钥或
`basic_text` fallback。原生模块缺失、系统凭据服务未启动、凭据库锁定或平台不受支持时，vault 为
`unavailable`。读取、写入和删除返回稳定的通用错误，不把原生错误文本、secret、系统账户或路径
发送给 Panel。

系统 service 名固定为 `com.itharbors.credentials.v1`。scope 摘要是 canonical
`kitId + NUL + pluginName + NUL + local` 的完整 SHA-256 十六进制值；系统 account 固定为
`<scopeDigest>:<profileId>:<secretVersion>`。普通数据文件只保存 account 的不透明引用，不能从中
获得密码。scope 摘要不是授权凭据；每次访问仍先执行 runtime owner 与 capability 检查。

## 元数据与一致性

非秘密 profile 元数据写入应用 SQLite，而不是 Session runtime 或浏览器存储。每条记录包含：

- 随机 UUID `id`；
- 宿主派生的 scope 摘要；
- 用户标签；
- 严格受限且可序列化的 metadata；
- 当前不透明 secret reference；
- `pending | active | deleting` 状态；
- 创建和更新时间。

MySQL metadata 固定为 `host`、`port`、`user`、`database` 和 `tls`，不接受 URL、password、任意附加
字段或调用者提供的 scope。列表只返回 `active` profile，并移除 scope、secret reference 和内部状态。

系统凭据库与 SQLite 不能组成同一事务，因此使用版本化 secret reference：

- 新建：先插入 `pending` 元数据，再写入新的系统 secret，最后把引用和状态原子切为 `active`；失败时
  删除 pending 行并尽力清理新 secret。
- 更新：写入新的 secret version，原子切换 active 引用，再删除旧 secret。切换失败不影响旧版本；
  旧 secret 清理失败进入仅含不透明引用的清理队列。
- 删除：先把 profile 标为 `deleting` 并从列表隐藏，删除系统 secret 后删除元数据。暂时失败保持
  `deleting` 并在下次启动重试。
- 启动恢复：清理超时 pending、继续 deleting 和孤立旧版本清理；恢复日志只记录操作、scope 摘要和
  profile ID，不记录 metadata 或原生错误详情。

## MySQL 协议与职责

`mysql-core` 仍是连接和数据库访问的唯一权威所有者。它新增以下公开方法：

- `getCredentialCapability()`：只返回 `available` 和稳定原因代码；
- `listConnectionProfiles()`：返回清理后的 MySQL profile；
- `connectSaved({ profileId })`：Server 内部读取 profile 与密码并连接；
- `saveCurrentConnection({ label })`：把最近一次成功手工连接的配置和密码保存为新 profile；
- `updateConnectionProfile(...)`：要求用户提供新密码并先验证新连接，再版本化更新；
- `deleteConnectionProfile({ profileId })`：断开使用该 profile 的当前连接后删除。

现有 `connect(input)` 保留为不持久化的手工连接入口。解析层继续严格校验连接字段，并为 profile ID、
标签和 metadata 增加长度与类型限制。`ConnectionSnapshot` 只新增当前 `profileId | null`，不包含密码、
secret reference 或“密码占位值”。

首次保存采用“先连接、后保存”：用户输入密码并成功连接后才能调用保存。认证或网络探测失败时不
创建 profile。保存失败不主动断开已成功建立的当前连接，但 UI 必须明确显示“已连接、保存失败”。

使用已保存连接时，core 按 profile ID 从绑定 vault 取出 secret，将其交给 `MysqlService` 创建 pool，
随后释放额外字符串引用。活动 pool 和为切换 database 所必需的会话内连接输入仍只保留到 disconnect、
Kit unload 或 Session 销毁。密码不得进入 connection snapshot、broadcast、公开错误 envelope 或日志。

## Panel 交互

连接 Panel 增加“手工连接”和“已保存连接”两个明确状态，但不自动发起连接：

- mount 时只读取 capability、profile 列表和现有连接快照；
- 已保存连接展示标签、endpoint、用户名、默认 database 和 TLS，不渲染密码 input 或密码占位字符；
- 用户选择 profile 后仍需点击“连接”；
- 手工连接成功后提供“保存此连接”操作并要求标签，不能在连接验证前勾选后静默落盘；
- 更新密码要求重新输入完整密码并重新连接验证；不支持显示、复制或恢复旧密码；
- 删除必须确认，并说明会删除本机保存的密码；删除当前连接使用的 profile 时先断开；
- vault 不可用时，保留现有手工连接表单并显示简短原因，不显示无效的保存控件。

Panel 发出保存、更新或删除请求后立即清空本地密码字段。异步结果继续使用当前
mount generation、action sequence 和 request sequence 规则拒绝过期结果。

## 错误与降级

新增稳定错误代码：

- `CREDENTIALS_DISABLED`：宿主模式不允许凭据；
- `CREDENTIALS_UNAVAILABLE`：系统安全后端不存在或暂时不可用；
- `CREDENTIALS_LOCKED`：系统凭据库需要用户解锁；
- `CREDENTIAL_PROFILE_NOT_FOUND`：profile 或 secret 已不存在；
- `CREDENTIAL_PROFILE_CONFLICT`：并发更新或删除冲突；
- `CREDENTIAL_OPERATION_FAILED`：无法安全归类的宿主失败。

公开消息使用固定中文文案，不透传原生异常。任何失败都不能回退到明文保存、浏览器保存、自制固定
密钥加密或继续使用过期 secret。profile metadata 存在但系统 secret 丢失时，连接失败并允许用户
重新输入密码修复或删除 profile。

## 远程多人演进边界

未来实现 `multi-user` 前必须先提供经过认证且不可伪造的 principal，并让每个 profile 同时受 tenant、
user 和数据库连接授权约束。远程适配器应使用云 KMS/HSM 或独立 Secret Manager，并采用 envelope
encryption；主密钥不得写入仓库、应用数据库或普通配置。审计记录保存、使用、更新和删除的主体、
profile ID、结果与时间，不记录密码。

`PluginCredentialVault` 的 owner-bound facade 保持不变，但远程 scope 必须由已认证 principal 派生，
不能接受请求参数中的 user ID，也不能把服务器操作系统钥匙串作为多用户共享秘密库。完成这些前，
`multi-user` 保持不可启动，远程 Web 只允许 `off`。

## 测试策略

### Framework 与权限

- Web 默认为 `off`；未指定地址、通配地址和非 loopback 地址不能以 `local` 启动。
- Electron 装配固定使用 `local` 且 Framework 仍只绑定 loopback。
- 反向代理产生的 loopback `remoteAddress`、伪造的 forwarded headers 和 Host 不能改变模式。
- 未声明 `credentials` 权限、非当前 Kit、非授权 owner plugin 和伪造 profile ID 均不能获得其他 scope。
- Registry policy、manifest 校验、权限提示、发布 metadata 和 attestation 覆盖新权限。

### Vault

- 使用 fake keyring 覆盖新建、读取、版本化更新、删除、并发冲突和不可用后端。
- 故障注入覆盖 SQLite 与 keyring 每个阶段，证明旧 secret 可继续使用或记录进入可恢复清理状态。
- 启动恢复覆盖 pending、deleting 和旧 secret 清理，且重复执行幂等。
- 日志、公开错误、数据库行、浏览器响应和快照均不包含测试密码。
- Linux 无 Secret Service、原生模块缺失或后端锁定时拒绝保存，不产生文件 fallback。

### MySQL Kit

- 手工连接保持现有行为，密码继续在请求发出后从 Panel 清空。
- 只有成功连接可以保存；保存失败不破坏当前已连接 pool。
- 已保存连接只向 Panel 暴露 metadata，连接时密码不出现在 Panel request/response 或 broadcast。
- 更新要求新密码和成功探测；失败保留旧 profile 和旧 secret。
- 删除当前 profile 先断开；删除失败显示稳定错误并允许重试。
- disconnect、Kit unload 和 Session 销毁释放连接状态；过期异步结果不能恢复密码或旧 profile。

### 验收

- `npm run dev:web -- --kit ./kits/mysql` 在默认 `off` 下完成手工连接烟测。
- 显式 loopback `local` Web 完成保存、重启、重新连接、更新和删除烟测。
- 非 loopback `local` 启动在监听前失败。
- Electron 完成同一流程，并验证系统凭据库中只有不透明 Harbors 条目、应用数据和日志无密码。
- 运行 Framework、Registry、MySQL Kit 专项测试、构建检查和仓库 `npm run check`。

## 验收标准

1. 开源仓库、安装包、应用 SQLite、Session 数据、浏览器存储和日志中不存在密码或通用解密密钥。
2. Electron 与显式 loopback 本机 Web 可以跨重启使用已保存连接，默认和远程 Web 不能使用本机 vault。
3. 请求地址、代理头和 profile ID 均不能扩大部署模式、principal、Kit 或 plugin 权限。
4. Panel 永远不能读取已保存密码，用户必须显式点击后才连接。
5. 安全后端不可用时功能安全关闭，现有不保存密码的手工连接仍可使用。
6. 凭据写入、更新、删除和恢复在部分失败后保持可重试且不会错误覆盖可用旧 secret。
7. 未来多人适配器可以替换本机后端，但在认证和 KMS 边界完成前不能启用 `multi-user`。

## 参考

- [Electron `safeStorage` 的平台安全语义](https://www.electronjs.org/docs/latest/api/safe-storage)
- [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring)
- [Kit 与会话模型](../../architecture/kit-and-session-model.md)
- [MySQL 插件化与关系图设计](./2026-07-20-mysql-plugin-graph-design.md)
