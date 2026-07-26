# 未签名主程序线上构建设计

## 背景与目标

在尚未加入 Apple Developer Program 的阶段，团队仍需要从 GitHub Actions 手动构建并下载可运行的 macOS ARM64 主程序，用于内部体验、演示和功能验证。

未签名构建不是正式发行版。它不进行 Apple Developer ID 签名或 notarization，不创建 Git Tag 或 GitHub Release，不进入 `electron-updater` 自动更新通道，也不改变现有 `app-publish-v1` 正式发布链路。将来配置 Apple 凭据后，正式发布仍按现有 `npm run app:release -- <semver>` 流程执行。

## 非目标

- 不绕过或弱化现有正式发布工作流的身份、Secret、Environment、审批、签名、公证、证明或 Release 门禁。
- 不让未签名产物冒充可公开分发或可被 Gatekeeper 信任的安装包。
- 不支持 Intel/x64、Windows 或 Linux 构建。
- 不通过 Push、Pull Request 或版本 Tag 自动触发未签名构建。
- 不长期保存未签名产物，也不将其写入仓库、Pages、Package Registry 或 GitHub Release。
- 不为未签名包建立自动更新能力。

## 方案选择

采用独立的手动 GitHub Actions 工作流和独立的显式打包命令。

不在 `publish-app.yml` 或 `publish-app-reusable.yml` 中增加 unsigned 分支，因为正式发布工作流的职责是生成经过签名、公证、证明和原子发布的 Release。把两类产物放进同一发布状态机会扩大权限和误操作面。

也不只依赖开发者本地执行 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:dir`，因为这不能满足团队从线上统一构建、下载和复现同一 Commit 产物的目标。

## 架构

### 独立打包配置

保留 `electron-builder.config.mjs` 作为正式签名构建的唯一配置来源。新增未签名配置，从正式配置继承应用标识、版本来源、资源白名单、asar、目标架构和 DMG/ZIP 命名规则，只覆盖以下签名相关字段：

- `mac.identity: null`
- `mac.notarize: false`

这样可以显式关闭签名和公证，同时避免复制并漂移应用打包结构。正式配置不得为了未签名构建而关闭或放宽任何门禁。

桌面打包脚本新增 `unsigned` 模式，并暴露根命令 `npm run desktop:unsigned`。该模式继续复用现有的生产资源准备、Electron ARM64 原生模块重建和 Node ABI 恢复逻辑，但交给未签名配置生成 DMG 和 ZIP，且永不执行 publish。

### 手动 Actions 工作流

新增 `Build Unsigned App` 工作流，满足以下约束：

- 唯一触发器是 `workflow_dispatch`。
- 仅接受 `refs/heads/main`；从其他 Ref 手动触发时在构建前失败。
- 仅授予 `contents: read`，不授予 `contents: write`、`id-token: write`、`attestations: write`、`packages: write` 或 `deployments: write`。
- 不引用 GitHub Environment，不读取任何 Secret。
- 使用与正式构建一致的 macOS 15 ARM64 runner、Node.js 22.18.0 和 npm 10.9.3。
- GitHub 官方 Actions 固定到已审核的完整 Commit SHA。
- Checkout 精确的 `github.sha`，并在打包前确认当前 Ref 是 `main`、当前 Commit 与触发 Commit 一致、runner 架构是 `arm64`。

工作流依次执行锁定依赖安装、完整 `npm run check`、`npm run desktop:unsigned`、产物验证和隔离启动冒烟测试。任何一步失败都不得上传部分产物。

## 构建与验证流程

1. 验证手动触发的 Ref、Checkout Commit、只读执行上下文和 ARM64 runner。
2. 使用 lockfile 安装依赖并运行仓库完整检查。
3. 以未签名配置构建 ARM64 `.app`、DMG 和 ZIP。
4. 验证 `.app` 与主可执行文件存在，主可执行文件架构为 `arm64`，且外层应用不存在 `Developer ID Application` 签名身份。
5. 使用一次性 `userData` 目录并设置 `HARBORS_DISABLE_UPDATE_CHECKS=1` 启动打包后的主程序，等待 Framework health 成功后正常退出。
6. 将 DMG 和 ZIP 复制到独立上传目录，并在文件名中插入 `unsigned`，避免与正式 Release 资产混淆。
7. 生成 `checksums.txt` 和 `UNSIGNED-BUILD.txt`。
8. 仅当上传目录中的四个文件都存在且非空时，上传一个 Actions Artifact。

启动冒烟测试的临时目录只能从 runner 的临时目录创建，并在进程正常退出后删除。测试必须关闭更新检查，不能连接或修改真实用户状态。

## Artifact 契约

Actions Artifact 名称包含 `unsigned`、桌面版本和 GitHub Run ID。Artifact 保留 7 天，并且只包含：

- `ITHARBORS-<version>-unsigned-arm64.dmg`
- `ITHARBORS-<version>-unsigned-arm64-mac.zip`
- `checksums.txt`
- `UNSIGNED-BUILD.txt`

`checksums.txt` 记录 DMG、ZIP 和说明文件的 SHA-256。`UNSIGNED-BUILD.txt` 记录桌面版本、40 位 Commit SHA、GitHub Run URL，并明确说明：

- 该产物没有 Apple Developer ID 签名和 notarization；
- Gatekeeper 可能阻止或警告启动；
- 该产物仅供内部测试，不得作为正式版本分发；
- 该产物不受自动更新和正式 Release 完整性契约保护。

不上传 `latest-mac.yml`、blockmap、SBOM 或 provenance attestation。前两项会让未签名包看起来像自动更新源，后两项属于正式发布证明链路；未签名 Artifact 仅使用 `checksums.txt` 做传输后人工校验。

## 错误处理与安全边界

- 非 `main` Ref、非 ARM64 runner、Commit 不一致、依赖或测试失败、打包失败、发现 Developer ID 身份、冒烟失败、缺少预期文件或出现额外上传文件时，工作流失败且不上传 Artifact。
- 未签名工作流不得创建、更新或删除 Tag、Release、Draft、Environment、Attestation 或远端分支。
- 未签名工作流不得复用 `app-preview`、`app-stable` 或任何 Apple Secret。
- Artifact 名称和内部说明必须始终包含 `unsigned`，避免人工下载后误认为正式版本。
- 现有 `v*` Tag 触发、`app-publish-v1` 固定引用和六个 Apple Secret 要求保持不变。

## 测试策略

### 打包单元测试

扩展桌面打包测试，先证明 `unsigned` 模式使用独立配置、目标仍为 macOS ARM64、发布模式仍为 `never`，并继续执行原生模块重建与 Node ABI 恢复。验证未签名配置继承正式打包结构，但明确把 `identity` 设为 `null`、把 `notarize` 设为 `false`，同时验证正式配置仍要求 notarization。

### 工作流契约测试

新增针对未签名工作流的静态契约测试，至少锁定：

- 仅有 `workflow_dispatch`，拒绝 Push、Pull Request 和 Tag 触发；
- 只读权限、`main` Ref 和精确 Commit 校验；
- 不存在 Environment、Secret、Tag、Release、Attestation 或发布命令；
- runner、Node、npm 与正式构建一致；
- 外部 Actions 使用完整 SHA；
- 执行完整检查、显式未签名构建、ARM64/签名身份检查和隔离冒烟测试；
- 上传文件严格等于 Artifact 契约，保留期为 7 天；
- Artifact 名称和说明文件明确包含 `unsigned`。

### 文档测试

更新主程序发布指南，分别说明“本地未签名目录包”“线上未签名测试 Artifact”“正式签名 Release”三种产物的用途和边界。测试必须防止文档把未签名 Artifact 描述成正式发布、自动更新或 Gatekeeper 验收依据。

## 运维使用

合并后，团队成员在 GitHub Actions 中选择 `Build Unsigned App`，从 `main` 手动运行。成功后在该 Run 的 Artifacts 区域下载带 `unsigned` 名称的压缩包，在内部测试机上核对 `checksums.txt` 后使用。

未签名构建不需要版本 Tag，也不要求修改 `packages/desktop/package.json`。同一版本可以从不同 Commit 生成多个短期 Artifact；Commit SHA 和 Run URL 是它们的精确身份。

获得 Apple Developer Program 和六个 Environment Secret 后，不需要迁移未签名 Artifact。正式发布继续使用已有版本确认脚本推送 `v<semver>` Tag，未签名工作流可以保留作为内部诊断工具，或通过后续独立维护变更删除。
