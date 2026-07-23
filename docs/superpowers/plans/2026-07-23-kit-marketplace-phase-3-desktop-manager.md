# Kit Marketplace Phase 3：Desktop Kit Manager 实施计划

> 本计划承接 Phase 2 已交付的 Registry、Resolver、Downloader 和远程安装服务。本阶段把它们
> 接入 Electron main/preload 与独立 Renderer 窗口，并补齐真实 GitHub Artifact Attestation
> 验证和重启激活闭环。GitHub 发布 workflow、Registry Pages 生成及 Kit 产品分支仍由下一阶段
> 实现。

## 官方信任模型依据

- GitHub 的 repository attestation API 可按 `sha256:<digest>` 查询公开制品 bundle，但
  [GitHub 官方文档](https://docs.github.com/en/rest/repos/attestations#list-attestations)明确要求
  客户端密码学验证签名、时间戳和 signer identity，不能把 API 返回本身视为可信。
- GitHub 的[离线验证指南](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
  说明 bundle 与 trusted root 是验证输入，且 trusted root 需要持续更新。
- [Sigstore JavaScript 客户端](https://docs.sigstore.dev/language_clients/javascript/)支持验证
  Sigstore bundle。Electron 31 的 Node 版本要求使用兼容的 `sigstore@3.1.0`，不追踪要求更新
  Node 的最新主版本。

## 固定约束

- Kit Manager 是独立 `file://` BrowserWindow，不由 Server/Gateway 提供，不拥有 Node 权限。
- Preload 只暴露 `list/refresh/install/activate/rollback`，不暴露 URL、文件路径、摘要、shell 或
  通用 IPC。
- Main process handler 同时校验 sender 是当前 Kit Manager window，其他 Kit 页面不能调用。
- Registry 与 publisher policy 由 main 配置；Renderer 永远不能覆盖。
- GitHub verifier 只接受与 `repository + sha256` 派生 API URL 一致的 attestation URL，限制 API
  和 bundle 响应大小、超时与重定向。
- Sigstore 必须验证 GitHub OIDC issuer、精确 workflow certificate identity、transparency log，
  再解析 DSSE in-toto/SLSA statement 对比 subject name/digest、repository、Commit 与 workflow。
- 安装不自动激活。运行中的桌面应用只可把版本标记为 pending，并提示重启。
- 启动时在 Framework 和 Catalog 之前应用 pending；新版本 Catalog 失败时标记 bad、回滚
  previous，并用恢复后的 active Catalog 继续启动，避免无限重启。
- 本阶段先支持安装、待重启激活和回滚；卸载在版本目录引用与 workspace 策略明确后实现，UI
  必须明确显示“暂不支持卸载”，不能提供无效按钮。

## Task 1：生产 GitHub Artifact Attestation Verifier

**文件**

- 修改：`package.json`
- 修改：`package-lock.json`
- 新增：`scripts/lib/kit-registry/github-attestation.mjs`
- 新增：`scripts/lib/kit-registry/github-attestation.test.mjs`

**Red**

测试派生 API URL、拒绝任意 attestation host/path、API/bundle 大小与超时、无 bundle、Sigstore
失败、错误 certificate identity、错误 DSSE payload type、subject、repository、Commit 和 workflow。
测试使用注入的 `verifyBundle`，不在单元测试访问公网。

**Green**

安装固定 `sigstore@3.1.0`。实现 `GitHubArtifactAttestationVerifier.verify(expected)`：

1. 从 `owner/repo` 与 digest 派生 `https://api.github.com/repos/.../attestations/sha256:...`。
2. 要求 release `attestationUrl` 与派生 URL 完全一致。
3. 请求 `predicate_type=provenance&per_page=100`，限制 1 MiB。
4. 逐个获取 HTTPS `bundle_url`，每份限制 5 MiB。
5. 调用 Sigstore `verify`，issuer 固定 GitHub Actions OIDC，certificate URI 为精确 workflow。
6. 解码 DSSE statement，验证 subject、SLSA external parameters 和 gitCommit。
7. 任一 bundle 完整匹配即返回 claims；全部失败只返回稳定错误，不泄露 bundle 内容。

提交：

```bash
git commit -m '[Feature] 验证 GitHub Kit 制品来源证明'
```

## Task 2：Pending 激活与启动回滚服务

**文件**

- 修改：`scripts/lib/kit-store/state.mjs`
- 修改：`scripts/lib/kit-store/state.test.mjs`
- 修改：`scripts/lib/kit-registry/manager.mjs`
- 修改：`scripts/lib/kit-registry/manager.test.mjs`
- 新增：`scripts/lib/kit-store/startup.mjs`
- 新增：`scripts/lib/kit-store/startup.test.mjs`

**Red**

覆盖：`activate` 只设 pending；重复选择幂等；bad 版本必须显式重试；rollback 设置 previous 为
pending；启动应用 pending 后 active/previous 正确；Catalog 校验失败时 markBad + rollback；恢复
版本也失败时禁用该 Kit；每个 pending 每次启动最多尝试一次。

**Green**

Manager 新增 `activate({id,version})` 和 `rollback(id)`，均返回 `requiresRestart=true`。实现
`prepareInstalledKitsForStartup({store, validateCatalog})`，在 Electron 启动 Framework 前处理
pending，返回可交给 `discoverKits` 的 active source；回滚结果写审计。Store 增加必要的
`clearActive/clearPending` 受校验状态迁移，不直接暴露任意 state 写入。

提交：

```bash
git commit -m '[Feature] 支持 Kit 待重启激活与启动回滚'
```

## Task 3：受限 Electron IPC 与服务工厂

**文件**

- 新增：`scripts/lib/kit-manager-service.mjs`
- 新增：`scripts/lib/kit-manager-service.test.mjs`
- 新增：`scripts/lib/kit-manager-ipc.mjs`
- 新增：`scripts/lib/kit-manager-ipc.test.mjs`
- 新增：`scripts/kit-manager-preload.cjs`
- 新增：`scripts/lib/kit-manager-preload.test.mjs`

**Red**

覆盖默认 Registry/publisher policy、环境配置非法时 fail closed、完整服务组合；每个 IPC method
输入 shape、sender ownership、handler 去重/注销、错误序列化；preload 只暴露五个方法并用固定
channel。

**Green**

服务工厂组合 Cache、Client、真实 GitHub verifier、Resolver、Downloader、Installer、Store、
Audit 和 Manager。IPC controller 接收 `getManagerWindow()`，只有 sender id 匹配才调用服务；
错误只向 Renderer 返回 `code/message`。Preload 使用独立全局 `harborsKitManager`，不复用普通
Kit 页面 `electronMenu` bridge。

提交：

```bash
git commit -m '[Feature] 提供受限 Kit Manager Electron IPC'
```

## Task 4：独立 Kit Manager Renderer

开始本 Task 前读取并遵循 `frontend-design` Skill。

**文件**

- 新增：`scripts/kit-manager.html`
- 新增：`scripts/kit-manager.css`
- 新增：`scripts/kit-manager-renderer.mjs`
- 新增：`scripts/lib/kit-manager-view.mjs`
- 新增：`scripts/lib/kit-manager-view.test.mjs`
- 修改：`package.json`
- 修改：`package-lock.json`

**Red**

用 `jsdom` 测试加载、空/离线/错误、stable/preview、installed/active/pending/bad、权限与 native
code 提示、刷新、安装、激活、回滚、并发按钮禁用、错误恢复和键盘可达性。静态测试检查 CSP、
无 inline script/style、无远程资源和语义 landmarks。

**Green**

实现一个克制的桌面管理界面：顶部显示 Registry 新鲜度和刷新动作；Kit 卡片展示 publisher、
版本、channel、安装/激活状态与权限风险；主要动作只有安装、重启后激活、回滚。Preview 默认
折叠；离线缓存明确标记 stale；未实现卸载明确说明原因。所有文本和 DOM 属性用安全 API 写入，
不使用远端 HTML。

提交：

```bash
git commit -m '[Feature] 实现桌面 Kit Manager 界面'
```

## Task 5：Electron 生命周期接线

**文件**

- 修改：`scripts/electron.mjs`
- 修改：`scripts/lib/electron-launcher.mjs`
- 修改：`scripts/lib/electron-launcher.test.mjs`
- 新增：`scripts/lib/kit-manager-window.mjs`
- 新增：`scripts/lib/kit-manager-window.test.mjs`

**Red**

覆盖：Tray 固定包含 `Kit Manager…`；窗口单例、恢复/聚焦、严格 webPreferences、拒绝导航和
新窗口；启动先处理 pending 再构建 Catalog/Framework env；Manager 关闭时注销 IPC；安装后
刷新快照，激活后显示重启提示；退出顺序不丢审计/Store 写入。

**Green**

在 app ready 后创建服务但不阻塞 Tray；延迟刷新 Registry。点击 Tray 打开 Manager。窗口只
加载本地 HTML，`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`，禁止导航与
`window.open`。pending 处理发生在 `discoverKits` 前。Manager 操作后重读 installed state；真正
切换 active 仍只在受控重启发生。

提交：

```bash
git commit -m '[Feature] 将 Kit Manager 接入 Electron 生命周期'
```

## Task 6：文档与全链路验收

**文件**

- 修改：`docs/guides/kit-artifacts.md`
- 修改：`docs/architecture/kit-and-session-model.md`
- 修改：`readme.md`
- 新增：`scripts/lib/kit-manager-acceptance.test.mjs`
- 修改：`package.json`

**验收**

自动测试使用 fixture Registry、fixture attestation verifier 和 fake BrowserWindow 打通：打开
Manager → 刷新 → 安装 → 标记 pending → 模拟重启 → Catalog/Server 发现 → 回滚。另用真实
Sigstore fixture bundle 验证 production verifier 的签名与 identity 路径；若生成可重复 fixture
需要外部签名服务，则将官方 bundle 固定为只读测试资源并记录来源。

运行：

```bash
npm run check
npm audit --omit=dev
git diff --check
```

文档必须区分：桌面市场已可用；官方 Registry 在下一阶段 Pages 发布前可能为空；GitHub 自动
发布、Registry 聚合和 Kit 分支 Skill 尚未交付。

提交：

```bash
git commit -m '[Feature] 完成桌面 Kit Manager 验收与文档'
```

## 阶段完成条件

- 普通 Kit Renderer 无法调用 Manager IPC，Manager Renderer 无法提交任意 URL/路径/摘要。
- 真实 GitHub attestation 的密码学验证、certificate identity 与 SLSA claims 缺一不可。
- 安装不会热替换运行中代码；pending 只在重启时应用，坏版本自动回滚且不循环。
- Manager 在在线、离线、空市场、失败、已安装、pending、bad 和 rollback 状态下均可理解。
- 全仓检查与生产依赖审计通过。
