# Kit 制品与 Registry

Harbors 将可独立发布的 Kit 封装为 `.hkit`。制品是根目录、条目顺序和时间戳固定的 ZIP，包含 Kit shell、声明插件的运行时文件、公开资源、`checksums.json` 和 SPDX SBOM。

## 构建与校验

```bash
npm run build -w @itharbors/kit-core
npm run build -w @itharbors/kit-cli
npm run kit -- validate ./path/to/kit
npm run kit -- pack ./path/to/kit --output ./dist/example.hkit
npm run kit -- inspect ./dist/example.hkit --json
```

`validate` 要求 Kit 根目录同时包含 `kit.json` 和 `package.json` descriptor，两者的身份与版本必须一致。插件 main、Panel entry 和 public assets 必须指向真实文件；源码、测试、符号链接、路径逃逸和未声明插件不会进入制品。

`kit.json` 声明 channel、publisher、Harbors/Kit API SemVer 范围、协议版本、permissions 和平台目标。含 `native-code` 的制品必须声明真实平台、架构与 Framework Node ABI。permission 是风险声明，不会自动建立 OS 沙箱；宿主能力仍必须经过 Kit/Plugin owner 与 capability 策略检查。

## Registry 与信任链

远程索引是严格校验的 `index.v1.json`，默认发布地址为 `https://itharbors.github.io/harbors/index.v1.json`。索引只投影展示信息、stable/preview 版本、permission、`release.json` URL 和 digest revocation，不内嵌可执行代码。

Release manifest 声明平台资产、SHA-256、字节数、源仓库、Commit、caller workflow、固定 signer workflow 和 attestation URL。生产 `RegistryArtifactAttestationVerifier` 从已校验 Registry URL 与制品摘要派生唯一 `attestations/sha256/<digest>.json`，使用 Sigstore 验证 GitHub Actions OIDC 身份、transparency log 与 SLSA subject。任一环节失败都不降级为可信。

聚合器只接受规范的 GitHub Release Asset 路径和 GitHub 控制的下载 CDN，并以 `registry/policy.json` 约束 publisher/repository/workflow，以 `registry/revocations.json` 撤回精确的 id/version/digest。当前 Web host 不在运行时安装 Registry Kit；仓库保留可复现发布、索引聚合与信任验证链。

## GitHub 自动发布

每个市场 Kit 的发布源是 `main` 上的 `kits/<name>`，`distribution=market` 使 descriptor 进入自动 Release 投影。普通 PR 合并只更新代码；发布者从干净且与 `origin/main` 完全一致的 checkout 创建不可变 Tag：

```text
kit/<name>/v<semver>
```

`.github/workflows/publish-kit.yml` 验证 Tag、`kit.json`、`package.json` 和 `package-lock.json`，生成 `.hkit`、`release.json`、`registry-entry.json` 与 SBOM。`actions/attest@v4` 将资产绑定到精确 Commit、caller 和 signer。随后 Registry workflow 自动扫描可信 Release，选出最新 stable/preview 并部署到 GitHub Pages。

## 本地 Kit 工作流

Kit 变更与 Framework 一样使用 change-workflow：

```bash
bash .agents/skills/change-workflow/scripts/start-change.sh feature <slug>
bash .agents/skills/change-workflow/scripts/finish-change.sh "中文摘要" /absolute/path/to/pr-body.md
```

`start-change.sh` 固定从 `origin/main` 创建 `<type>/<slug>` 隔离 worktree；`finish-change.sh` 运行目标 Kit 完整检查并只创建 PR。不可变 Kit Tag 由合并后的自动工作流创建；若自动 Tag 缺失，需从干净且与 `origin/main` 完全一致的 `main` 手动创建 `kit/<name>/v<semver>` Tag 并推送，由 `publish-kit.yml` 完成发布，且不得替换已有 Tag 或不可变 Release。

所有动态发现的 builtin Kit 目录中必须恰好一个声明 default 角色。Framework 与市场 Kit 变更统一使用 change-workflow。
