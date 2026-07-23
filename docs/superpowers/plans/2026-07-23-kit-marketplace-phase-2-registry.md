# Kit Marketplace Phase 2: Registry 与远程安装实施计划

> 本计划承接 `2026-07-23-kit-marketplace-design.md` 和 Phase 1 已交付的 `.hkit`、
> `InstalledKitStore`、`KitArtifactInstaller`。本阶段只完成受控 Registry 的发现、缓存、
> Release 解析、可信下载和本地安装服务；Renderer UI、GitHub 发布 workflow 与产品分支迁移
> 由后续计划实现。

## 目标

Harbors 能从一个显式配置的受控 Registry 获取经严格校验的市场快照，在离线或刷新失败时
回退到上一份已验证缓存，并且只能根据该快照中的 `id + version + channel` 下载匹配资产。
下载必须流式写入 Store 的 `downloads/`，验证大小、SHA-256、Release 身份、来源策略、
兼容性和撤回状态后，复用 Phase 1 安装事务写入不可变版本目录。任何失败均不改变 active。

## 固定约束

- Registry schema、Release schema 和 revocation schema 均严格拒绝未知字段。
- 第一版只接受 HTTPS；测试允许显式开启 loopback HTTP，不提供任意 URL 安装入口。
- index 只包含 Release manifest URL；`.hkit` URL 只能来自已验证 Release manifest。
- Registry 缓存只在完整解析和策略校验通过后原子替换。
- `304` 更新缓存元数据但不改 index；失败使用旧缓存，没有旧缓存则返回空远程市场。
- 单个 index/release manifest 上限 1 MiB，`.hkit` 上限 512 MiB。
- 下载使用临时文件、流式 SHA-256、有限重试；摘要/身份/兼容性/撤回失败不重试。
- Registry snapshot 中 `(id, channel, version)` 唯一，Release 与 asset 身份必须逐层一致。
- 安装请求只接受 `id/version/channel`，不接受 Renderer 提供 URL、摘要、路径或来源声明。
- 来源策略至少绑定 publisher、repository、workflow；加密 attestation 验证器使用可注入接口，
  默认官方远程安装必须提供并通过验证，fixture 测试使用确定性的 verifier。
- 本阶段安装后不自动 activate；active 只能由既有 Store 状态机显式切换。

## Task 1：Registry、撤回与来源证明协议

**文件**

- 修改：`packages/kit-core/src/model.ts`
- 修改：`packages/kit-core/src/schema.ts`
- 修改：`packages/kit-core/src/index.ts`
- 修改：`packages/kit-core/tests/schema.test.ts`

**Red**

先写测试覆盖：合法 index；稳定/预览 channel；重复 Kit ID；channel 版本与 Release URL；
非法时间、HTTP URL、未知字段；revocation 的 id/version/digest/reason/action；Release source 的
repository/workflow/attestation；Release 与 index 身份不一致。

运行：

```bash
npm run test -w @itharbors/kit-core
```

预期：新增 parser 尚不存在，编译或断言失败。

**Green**

新增并导出：

```ts
interface KitRegistryIndex {
  schemaVersion: 1;
  generatedAt: string;
  kits: RegistryKit[];
  revocations: KitRevocation[];
}

interface ReleaseManifestSource {
  repository: string;
  commit: string;
  workflow: string;
  attestationUrl: string;
}
```

实现 `parseKitRegistryIndex`，并扩展 `parseReleaseManifest`。URL parser 默认只接受 HTTPS；
loopback HTTP 的放宽留给网络层测试配置，不放宽协议对象。保持完整 identity cross-check。

提交：

```bash
git commit -m '[Feature] 定义 Kit Registry 与来源证明协议'
```

## Task 2：原子 Registry 缓存

**文件**

- 新增：`scripts/lib/kit-registry/cache.mjs`
- 新增：`scripts/lib/kit-registry/cache.test.mjs`
- 修改：`package.json`

**Red**

测试空缓存、有效快照、ETag/刷新时间、原子写权限、并发更新、损坏 index/metadata 隔离、
写入未验证对象拒绝，以及失败写入不覆盖旧缓存。

运行：

```bash
node --test scripts/lib/kit-registry/cache.test.mjs
```

**Green**

实现 `KitRegistryCache`：目录为 `<store>/registry`；`read()` 同时解析 index 和 metadata；
`writeVerified()` 先严格解析，分别写唯一临时文件、fsync、rename；损坏文件改名为
`.corrupt-*` 后视为无缓存。metadata 只记录 URL、ETag、validatedAt 和 schemaVersion。

提交：

```bash
git commit -m '[Feature] 支持 Kit Registry 原子缓存'
```

## Task 3：带缓存降级的 Registry Client

**文件**

- 新增：`scripts/lib/kit-registry/client.mjs`
- 新增：`scripts/lib/kit-registry/client.test.mjs`
- 修改：`package.json`

**Red**

用本地 HTTP fixture 测试：首次 `200`；带 `If-None-Match` 的 `304`；刷新间隔跳过；响应
超过 1 MiB；非 JSON/非法 schema；HTTP 错误和超时回退缓存；无缓存时返回空 snapshot；
配置 URL 与缓存 URL 不一致时不复用旧缓存。显式 `allowLoopbackHttp` 只允许
`127.0.0.1/localhost/[::1]`。

**Green**

实现 `KitRegistryClient.refresh({ force })` 和 `snapshot()`。使用 `fetch`、AbortSignal 总超时、
响应流大小限制和 ETag；只有新 index 完整验证后写缓存。返回值包含 `source`（network/cache/
none）、`stale`、`validatedAt` 和公开市场对象，不泄露缓存路径。

提交：

```bash
git commit -m '[Feature] 支持 Kit Registry 刷新与离线降级'
```

## Task 4：Release 选择、撤回与来源策略

**文件**

- 新增：`scripts/lib/kit-registry/resolver.mjs`
- 新增：`scripts/lib/kit-registry/resolver.test.mjs`
- 修改：`package.json`

**Red**

覆盖：只能选择当前 snapshot 中精确版本；preview 不混入 stable；Release URL/身份/版本/
publisher 不匹配；资产不兼容；重复兼容资产；被撤回的版本或 digest；repository/workflow 不在
publisher policy；attestation subject digest/source/commit/workflow 不匹配。

**Green**

实现 `KitReleaseResolver.resolve({ id, version, channel, runtime })`：受限获取 release manifest，
严格解析，验证 index 到 release 的身份链，使用 `selectCompatibleAsset` 选唯一资产，执行
revocation 与 publisher policy。定义 `provenanceVerifier.verify({...})` 接口，并返回安装端所需的
冻结 `ResolvedRegistryAsset`；调用者无法覆盖 URL、digest 或 source。

提交：

```bash
git commit -m '[Feature] 验证 Kit Release 来源并选择兼容资产'
```

## Task 5：流式可信下载与审计日志

**文件**

- 新增：`scripts/lib/kit-registry/downloader.mjs`
- 新增：`scripts/lib/kit-registry/audit.mjs`
- 新增：`scripts/lib/kit-registry/downloader.test.mjs`
- 新增：`scripts/lib/kit-registry/audit.test.mjs`
- 修改：`package.json`

**Red**

覆盖：流式下载成功；长度头和实际长度上限；下载中断清理；网络/5xx 有限重试；摘要或大小
不符不重试；临时文件私有权限；并发文件名不冲突；审计记录刷新、安装、拒绝和失败且不写入
本地绝对路径或响应正文。

**Green**

`KitArtifactDownloader.download(asset)` 仅接受 resolver 返回的品牌化对象，写入 Store
`downloads/` 唯一临时文件并边写边计算 SHA-256，成功后返回路径。`KitAuditLog.append()` 使用
NDJSON、受控事件 schema 和串行追加；错误消息规范化，不记录任意远端正文。

提交：

```bash
git commit -m '[Feature] 支持 Kit 制品流式下载与安装审计'
```

## Task 6：远程 Kit 安装服务

**文件**

- 新增：`scripts/lib/kit-registry/manager.mjs`
- 新增：`scripts/lib/kit-registry/manager.test.mjs`
- 修改：`scripts/lib/kit-store/state.mjs`
- 修改：`scripts/lib/kit-store/state.test.mjs`
- 修改：`package.json`

**Red**

以本地 Registry + Release + `.hkit` fixture 打通 refresh/list/install；断言 Renderer 形态输入
只有 id/version/channel；安装后版本存在但 active 不变；重复安装幂等；同一 Kit 操作串行；
撤回、来源失败、摘要篡改、离线无缓存均拒绝；失败保留旧 active 并写审计。

**Green**

实现 application-scope `KitRegistryManager`，组合 client、resolver、downloader、installer、store、
audit。`list()` 返回 sanitized snapshot；`install()` 解析 Registry 资产后下载并调用
`KitArtifactInstaller.installFromFile`，成功更新 `autoUpdate` 默认值但不激活。为 Store 增加
受校验的 `setAutoUpdate()`，不改变既有状态迁移语义。

提交：

```bash
git commit -m '[Feature] 打通 Registry 到本地 Store 的 Kit 安装链路'
```

## Task 7：文档与阶段验收

**文件**

- 修改：`docs/guides/kit-artifacts.md`
- 修改：`docs/architecture/kit-and-session-model.md`
- 修改：`docs/README.md`
- 新增：`scripts/lib/kit-registry/acceptance.test.mjs`
- 修改：`package.json`

**验收**

永久集成测试启动本地 fixture Registry，完成：

```text
首次刷新 -> ETag 304 -> Release/来源校验 -> 流式下载 -> 本地安装
-> 显式激活 -> Server /api/kits 发现 -> 离线缓存可列出
-> 篡改下载被拒绝 -> revocation 被拒绝 -> active 保持不变
```

随后运行：

```bash
npm run check
npm audit --omit=dev
git diff --check
```

更新文档，明确本阶段已有远程发现/下载服务但 Renderer UI、GitHub workflow 和真实 GitHub
attestation verifier 仍由下一阶段接入；不得把测试 verifier 描述为生产级来源证明。

提交：

```bash
git commit -m '[Feature] 补充 Kit Registry 与远程安装文档'
```

## 阶段完成条件

- 所有网络输入均经过大小限制、超时和严格 schema。
- 用户输入无法携带任意 URL、路径、摘要或来源身份进入安装器。
- Registry 刷新失败不影响 built-in/installed Kit，合法缓存可离线读取。
- 远程安装失败不改变 active，下载和 staging 临时文件被清理。
- Registry、Release、asset、attestation 和本地 manifest 的身份链可被测试逐层破坏并拒绝。
- 仓库级 `npm run check` 与生产依赖审计通过。
