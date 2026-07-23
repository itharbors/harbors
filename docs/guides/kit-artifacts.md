# Kit 制品、Registry 与本地安装

Harbors 定义了可独立发布的 `.hkit` 制品、兼容性规则、本地 Installed Kit Store 和 GitHub
自动发布链路。
`.hkit` 是根目录固定、条目排序和时间戳固定的 ZIP；同一输入应产生完全相同的字节和
SHA-256。制品只包含 Kit shell、声明插件的运行时 `dist/`、公开资源、可选生产
`node_modules`、`checksums.json` 和 SPDX 2.3 SBOM。

## 构建工具

首次使用先构建共享协议和 CLI：

```bash
npm run build -w @itharbors/kit-core
npm run build -w @itharbors/kit-cli
```

校验、封装和检查：

```bash
npm run kit -- validate ./path/to/kit
npm run kit -- pack ./path/to/kit --output ./dist/example.hkit
npm run kit -- inspect ./dist/example.hkit --json
```

`validate` 要求 Kit 根同时包含发布用 `kit.json` 和运行时 `package.json`。两者的 `id/name`
与 `version` 必须一致；插件 main 和 Panel entry 必须指向真实 `dist` 文件。源码、测试目录、
符号链接、目录逃逸和未声明插件不会进入制品。

## `kit.json` 与目标

`kit.json` schemaVersion 当前固定为 `1`，声明 stable/preview channel、发布者、Harbors 与
Kit API SemVer 范围、协议版本、权限和目标。通用包必须使用 `platform=any`、`arch=any`
且省略 `nodeAbi`。包含 `native-code` 的平台包必须写明 platform、arch 和实际承载插件的
Framework Node 模块 ABI（不是 Electron 主进程 ABI）；安装端会同时检查 Framework、Kit API、
协议、平台、架构和 ABI。

## Registry 与 Release

远程市场入口是严格校验的 `index.v1.json`。索引只声明 Kit 展示信息、stable/preview 最新
版本、每个 channel 的权限投影、不可变 `release.json` URL 和 digest 级 revocation，不直接包含
可执行代码。Release
manifest 再声明平台资产 URL、整包 SHA-256、字节数、源仓库、Commit、caller workflow、
reusable signer workflow 和 attestation URL。所有协议 URL 必须是 HTTPS；测试可通过显式注入的 loopback transport
访问本地 fixture，但不会放宽发布对象。

`KitRegistryClient` 使用 ETag / `If-None-Match`，默认六小时刷新一次，限制索引为 1 MiB 并
设置整体超时。只有完整 schema 校验成功的索引才会原子替换
`<userData>/kit-store/registry/` 缓存；`metadata.json` 绑定 index SHA-256，能识别崩溃造成的
文件代际错配。刷新失败时使用同一 Registry URL 的上一份已验证缓存，没有缓存则返回空市场，
不影响 built-in 或已安装 Kit。

`KitReleaseResolver` 只接受当前快照中的 `id + version + channel`，逐层核对 Registry、Release、
资产 manifest、权限集合、publisher policy、revocation 和来源证明 claims。Renderer 不能提供
URL、路径、摘要或发布者身份。生产 `GitHubArtifactAttestationVerifier` 从仓库与 SHA-256 派生
唯一 GitHub API URL，使用 `sigstore@3.1.0` 验证 GitHub Actions OIDC issuer、精确 reusable
signer workflow certificate identity、CT/Rekor transparency log，再核对 DSSE in-toto/SLSA
subject、repository、Commit 和 caller workflow。任何一步失败都不会降级为可信安装。

GitHub Release 的下载端点会跳转到资产 CDN。Resolver、Registry 聚合器和 Downloader 只允许
规范的 `https://github.com/<owner>/<repo>/releases/download/...` 初始 URL，并只跟随到 GitHub
控制的 `*.githubusercontent.com` 内容域；跳转到其他域、URL 凭据、查询注入和非 Release 路径
都会拒绝。最终制品仍必须通过大小、SHA-256 和 Sigstore 来源证明。

`KitArtifactDownloader` 将可信 Resolver 结果流式写入私有 `downloads/`，同时计算字节数和
SHA-256。网络错误和 5xx 进行有限指数退避；大小、摘要、4xx 和策略失败不重试。随后
`KitRegistryManager` 复用本地安装事务，安装成功仍不会自动 activate；官方 stable publisher
可配置为默认 `autoUpdate=true`。`itharbors` 是保留 publisher，其官方 repository、caller 与
signer policy 不允许被环境配置覆盖；自定义 policy 只能新增其他 publisher。对外 list/refresh 结果不包含 Release URL、本地路径、摘要、
Commit 或 Store 来源详情，刷新与安装结果写入受限字段的 `audit.ndjson`。

## 本地 Store

Electron 在 `<userData>/kit-store` 保存：

```text
installed.json
downloads/
staging/
kits/<encoded-kit-id>/<version>/
```

安装会先校验整包大小与 SHA-256，再受限解压并逐文件核对 `checksums.json`，最后校验
运行时 manifest。版本目录不可变：相同 `id + version` 只有摘要相同才允许幂等重放。
install 不会自动 activate；Kit Dock 的激活与回滚操作只写入 pending 并提示重启。Electron 下次
启动会先将 pending 暂存为 active 并做 Catalog 校验；Framework 就绪后还会检查该 Kit 的
application-scope 插件状态，并创建一次可回收 Session 真实加载普通插件。只有两层都成功才
清除 pending 并提交激活；首次真实加载失败会用一次原子状态转换标记 bad，并把 previous 重新
置为 pending 后重启。previous 也必须重新通过 Catalog 与真实加载；再次失败则原子禁用该 Kit，
避免重启循环。`installed.json` 使用同目录临时文件、fsync 和 rename。

Electron 启动时只读取完成 pending 校验后的 active 版本，并通过 `HARBORS_INSTALLED_KITS`
把绝对目录快照传给 Server。Server 不扫描 Store 根，也不猜测版本；环境变量必须是非空
绝对路径组成的 JSON 数组。目录变化在下一次桌面启动时生效。

## Desktop Kit Manager

Electron 托盘中的 **Kit Manager…** 打开独立本地 `file://` Kit Dock。窗口使用 sandbox、
context isolation 和独立 preload，只暴露 `list/refresh/install/activate/rollback` 五个方法；main
process 同时校验调用 sender。Stable 默认展开，Preview 默认折叠；离线缓存、权限、native-code
风险、installed/active/pending/bad 和 previous rollback 都会明确展示。暂不支持卸载，因为尚未
确定版本目录与 workspace 引用的安全回收规则。

默认 Registry 是 `https://itharbors.github.io/harbors/index.v1.json`。在 `kit-registry` 首次推送
并且至少一个 Kit 发布前，它可能返回空市场。开发或受控部署可使用 `HARBORS_KIT_REGISTRY_URL`、
`HARBORS_KIT_PUBLISHER_POLICIES_JSON` 和 `HARBORS_KIT_AUTO_UPDATE_PUBLISHERS` 覆盖配置；非法或
非 HTTPS 配置会 fail closed。

## GitHub 自动发布

产品线拆为独立历史的 `kit/sqlite`、`kit/mysql` 与 `kit/notifications`；市场源数据单独位于
`kit-registry`。Framework 的 `main` 只维护协议、宿主、安装器、市场客户端和版本化发布工具链，
业务 Kit 后续发版不要求合并回 `main`。

Kit 产品分支使用 [caller 模板](../../.github/kit-templates/publish-kit.yml)，固定调用
`itharbors/harbors/.github/workflows/publish-kit-reusable.yml@kit-publish-v1`。caller 只响应两类
事件：

```text
push kit/<name>                 -> Preview（仅当 kit.json channel=preview）
tag  kit/<name>/v<semver>       -> Stable（要求 kit.json channel=stable）
```

Stable manifest 提交到产品分支但尚未打 Tag 时会安全跳过 Preview，不会把 Stable 内容误发为
prerelease。reusable workflow 使用 Node.js 22.18.0 和锁文件执行 `npm ci`、`npm test`、
`npm run build`，再从固定 `kit-publish-v1` ref 构建发布工具链。`kit-publish.mjs prepare` 负责
validate、pack、离线 inspect，并生成 canonical `.hkit`、`release.json`、`registry-entry.json`
和 SPDX SBOM；同一输出目录不会覆盖。

发布 job 通过官方 `actions/attest@v4` 同时证明 `.hkit` 与 `release.json`。证明证书绑定真正执行
签名步骤的固定 reusable workflow，SLSA source claims 另行绑定产品分支 caller 与 Commit；然后使用 GitHub CLI
创建不可变 Release。Preview 是 prerelease，Tag 为 `preview/<name>/<run>-<sha>`，自动更新
`kit-registry` 的 `preview.json` 并只保留最近 10 份。Stable 必须先通过受保护的 `kit-stable`
Environment，已存在 Release 会直接失败；发布后创建以 `kit-registry` 为 base 的元数据审核 PR，
不会直推 Stable 索引。

Registry 分支使用 [Pages workflow 模板](../../.github/kit-templates/registry-pages.yml)。PR 只执行
远端 Release 对账和 schema 校验；`kit-registry` push 通过后才使用
`actions/upload-pages-artifact@v4` 与 `actions/deploy-pages@v4` 部署 GitHub Pages。
聚合器读取：

```text
registry/
  entries/<base64url-kit-id>/stable.json
  entries/<base64url-kit-id>/preview.json
  revocations.json
```

每个 entry 都必须与远端 `release.json` 的 id、version、channel、publisher、permissions、仓库、
workflow、Tag、资产 URL 和 attestation URL 一致。revocation 还必须附带历史 Stable
`releaseManifestUrl` 作为摘要证据，聚合后才移除内部证据字段并写入公开 `index.v1.json`。

仓库维护者首次启用时需要完成以下 GitHub 设置：

1. 在已审核工具链 Commit 上创建并保护 `kit-publish-v1` ref。
2. 初始化 `kit-registry` 分支，放入 `registry/` 与 Pages workflow 模板。
3. 将 Pages Source 设置为 **GitHub Actions**。
4. 创建受保护的 `kit-stable` Environment，并配置 Stable 审批人。
5. 允许 GitHub Actions 创建 Pull Request，并给 caller 声明的最小写权限生效。

## 产品分支迁移与本地工作流

迁移器从当前已审核 Framework Commit 生成可复现的独立目录，并在 provenance 文件中记录该 Commit：

```bash
node scripts/migrate-kit-product.mjs --kit sqlite --output /absolute/path/to/sqlite-product
node scripts/migrate-kit-product.mjs --kit mysql --output /absolute/path/to/mysql-product
node scripts/migrate-kit-product.mjs --kit notifications --output /absolute/path/to/notifications-product
node scripts/migrate-kit-registry.mjs --output /absolute/path/to/kit-registry
```

产品快照包含自己的 lockfile、构建/测试/validate/pack 命令、薄 caller workflow 和仓库本地
`kit-workflow` Skill；SQLite 使用匹配原生制品目标的 macOS arm64 runner，其他两个产品生成通用包。
Registry 快照只包含 entry、revocation、Pages workflow 和治理说明。迁移命令拒绝覆盖已有目录，且
不会创建或推送 Git 分支，避免生成快照时意外触发 Preview Release。

日常 Kit 变更必须通过产品分支中的 `kit-workflow`：

```bash
bash .agents/skills/kit-workflow/scripts/start-kit-change.sh sqlite feature add-import
bash .agents/skills/kit-workflow/scripts/finish-kit-change.sh sqlite "添加数据导入" /absolute/path/to/pr-body.md
bash .agents/skills/kit-workflow/scripts/release-kit.sh sqlite 1.2.0
```

start 固定从 `origin/kit/<kit>` 创建 `kit-change/<kit>/<type>/<slug>` 隔离 worktree；finish 只允许
向对应 `kit/<kit>` 创建 PR。release 首次运行只显示不可变发布身份，只有用户对该 Tag 与精确
Commit 明确确认后，才能通过二者组合的确认 token 推送。Framework 变更仍使用
`change-workflow`，不能拿 `main` 作为 Kit 基线。

## 当前交付状态

桌面市场、受限 Electron IPC、生产 GitHub attestation verifier、安装、重启激活、自动回滚、
Server Catalog、automated GitHub Release、Registry Pages aggregation、`kit-workflow`、产品快照
迁移器与 Registry 快照迁移器均已交付。SQLite、MySQL、Notifications 和 Registry 的本地独立
分支可以从这些快照初始化；推送 `kit-publish-v1`、产品分支与 `kit-registry` 会改变 GitHub 状态并
触发 Actions，因此首次远端启用仍按上节逐项审核执行。远端初始化和首次发布前，官方 Registry
可以为空。
