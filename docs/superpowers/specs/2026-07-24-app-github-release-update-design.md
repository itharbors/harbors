# 主程序 GitHub Release 打包与更新设计

## 背景

ITHARBORS 当前只能从源码启动 Electron。稳定入口仍会通过 npm 启动开发 Web 栈，仓库没有
桌面应用版本源、生产运行时、安装包配置、主程序发布工作流或客户端更新器。Kit 已经使用
独立的 `kit/<name>/v<semver>` Tag、GitHub Release 和市场索引发布，因此主程序发布必须与
Kit 发布隔离，不能重新把产品 Kit 的发布节奏绑定到 Framework。

## 目标

1. 从 GitHub Tag 可重复地构建、签名、公证并发布可安装的 ITHARBORS 主程序。
2. 已安装的主程序能够从 GitHub Release 发现、下载并安装更新。
3. Stable 用户不接收 Preview，Preview 用户可以继续接收 Preview 或更高版本。
4. 打包后的程序不依赖用户电脑安装 Node.js、npm、TypeScript 或 Vite。
5. 主程序 Release 与 Kit Release 在 Tag、工作流、产物和版本生命周期上完全隔离。
6. 首发平台为 macOS Apple Silicon；产物模型保留扩展 Intel Mac 和 Windows 的能力。

## 非目标

- 本阶段不发布 Intel Mac、Windows 或 Linux 安装包。
- 不实现独立更新服务器、增量发布控制台或跨版本数据迁移框架。
- 不把 SQLite、MySQL、Notifications 等产品 Kit 固化为主程序的一部分。
- 不允许客户端绕过平台签名验证，自行替换应用目录。
- 不在没有正式签名和公证凭据时发布可自动更新的 Stable 版本。

## 方案选择

采用 `electron-builder` 生成 macOS DMG、ZIP 和更新元数据，采用 `electron-updater` 消费
GitHub Release。相比迁移到 Electron Forge，这一方案对现有入口和 monorepo 的重构范围更小；
相比自研 ZIP 更新器，它复用 Squirrel.Mac、平台签名验证、摘要校验、下载状态和重启安装事务。

主程序新增独立的 `packages/desktop` 应用包。根 workspace 仍负责开发和全仓检查，desktop
package 负责应用版本、Production Runtime 构建、打包配置和更新依赖。Electron 版本继续由
根仓库锁定，应用版本只在 desktop package 中声明一次，并通过 `app.getVersion()` 注入运行时。

## 发布身份与版本规则

主程序 Tag 使用：

```text
app/v<semver>
```

示例：

```text
app/v0.1.0-preview.1
app/v0.1.0
```

规则如下：

- Tag 必须指向远端 `main` 上的 Commit。
- Tag 中的 SemVer 必须与 `packages/desktop/package.json` 的 `version` 完全一致。
- 版本必须是 canonical SemVer，不允许 build metadata。
- 普通 SemVer 对应 Stable；包含 prerelease 段的 SemVer 对应 Preview。
- Preview GitHub Release 必须标记为 prerelease；Stable Release 不得标记为 prerelease。
- 已发布的 `app/v*` Tag 和 Release 不允许覆盖、删除或替换资产。
- Kit 继续使用 `kit/<name>/v<semver>`；两个发布入口不得互相响应。

本地发布入口由仓库级 change/release skill 控制，至少检查当前分支、远端一致性、工作区洁净、
版本一致性和远端 Tag 不存在，并在实际创建 Tag 前要求精确确认。实现或合并 PR 的确认不等于
发布确认。

## 应用包与资源边界

`packages/desktop` 是 electron-builder 的 app directory，包含最小生产依赖和生成后的入口。
构建过程把运行所需内容收敛为明确白名单：

- Electron 主进程、preload 和 Framework 子进程入口；
- 编译后的 Server 与 Client 静态资源；
- Framework 级插件及其构建产物；
- Default Kit，作为离线首次启动和 Kit Manager 的最小载体；
- Kit Registry 客户端、安装事务和必要运行依赖；
- 图标、entitlements、更新配置等桌面资源。

SQLite、MySQL、Notifications 产品 Kit 不进入主程序文件白名单。它们继续从 Kit 市场安装，
从而可以只发布 Kit Tag 而不更新主程序。已安装 Kit 位于 Electron `userData/kit-store`，应用
升级不得覆盖该目录。

`better-sqlite3` 等原生模块必须针对目标 Electron ABI 和 arm64 重建，并从 ASAR 解包。
打包测试必须检查目标架构与 ABI，避免把开发机 Node ABI 的二进制带入安装包。

## Production Runtime

开发模式保持现有流程：Electron 启动 Gateway、Server 和 Vite，支持热更新和隔离开发端口。

打包模式不再调用 npm：

1. Electron 从 `process.resourcesPath` 解析只读应用资源。
2. Electron 使用随应用携带的运行时启动独立 Framework 子进程。
3. Framework 在 `127.0.0.1` 的动态端口启动生产 Server。
4. Server 同时提供 API、SSE、Client 静态资源和 SPA fallback，不启动 Vite。
5. 子进程通过受控就绪消息或健康检查把实际端口交给 Electron。
6. Electron 只在 Framework ready 后打开 Kit 窗口。
7. Electron 正常退出或更新重启前，先持久化 Workspace，再停止 Framework 和通知服务。

生产数据库、Workspace、Kit Store、缓存、审计日志和更新日志全部写入 `app.getPath('userData')`。
应用包和 ASAR 始终视为只读。Framework 只监听 loopback，不接受外部网卡连接。

开发与生产的差异由 `app.isPackaged` 和显式 runtime adapter 决定，而不是散落的环境变量分支。
启动器测试要分别覆盖源码模式和 packaged mode 命令、路径、环境和关闭行为。

## 应用版本与兼容性

`app.getVersion()` 是主程序运行时版本的权威来源。现有 `kitRuntime.harborsVersion` 硬编码值
替换为该版本；Kit API 和 protocol version 继续独立维护，避免每次应用 Patch 版本都改变 Kit
兼容契约。

构建前校验以下版本关系：

- Tag SemVer = desktop package version；
- Release 元数据 version = desktop package version；
- `app.getVersion()` = desktop package version；
- 更新文件名和 update manifest version = desktop package version。

## 客户端更新状态机

更新器只在 `app.isPackaged` 且应用具备正式发布配置时启用。开发构建、测试构建和未签名目录
构建不访问更新源。

```text
idle -> checking -> available -> downloading -> downloaded -> installing
                   \-> not-available
任意非 installing 状态 -> error -> idle
```

行为约束：

- 应用 ready 后延迟执行一次后台检查，避免阻塞首次窗口启动。
- APP 菜单提供“检查更新”，复用同一个并发检查事务。
- 同一时间只允许一次检查或下载，重复触发返回当前状态。
- Stable 构建设置 `allowPrerelease=false`。
- Preview 构建设置 `allowPrerelease=true`，由当前应用 SemVer 自动确定默认通道。
- 发现更新后允许后台下载，并在 UI/系统通知中展示状态。
- 下载完成后提示“立即重启”或“稍后”。
- “立即重启”先运行现有受控关闭流程，再调用 `quitAndInstall()`。
- “稍后”不打断工作；正常退出时由更新器安装已下载版本。
- 检查、下载或解析失败不退出应用，也不影响 Kit Registry；错误只暴露去敏后的用户信息。
- 不提供降级按钮。坏版本通过发布更高的修复版本恢复，已发布资产不原地替换。

更新状态由主进程持有。Renderer 只能通过窄化 preload 查询状态、触发检查/下载/重启，不能传入
任意 feed URL、资产 URL 或本地路径。

## GitHub 工作流

新增两个工作流层次：

- `publish-app.yml`：只响应 `app/v*`，负责最小调用入口。
- `publish-app-reusable.yml`：固定在受保护的 `app-publish-v1` 工具链 Tag，执行所有校验、
  构建、签名、公证、验证和发布。

reusable workflow 必须验证 caller repository、caller workflow、Tag、Commit、版本和 channel，
并限制最小权限。`app-publish-v1` 与 `app/v*` 都加入 Tag ruleset，禁止更新和删除。

macOS arm64 job 使用 GitHub arm64 macOS runner，步骤为：

1. checkout 精确 Tag Commit；
2. 安装锁文件依赖并运行完整 `npm run check`；
3. 构建 Production Runtime；
4. 重建 Electron ABI 原生依赖；
5. 构建并签名 `.app`；
6. 提交 Apple notarization 并 staple ticket；
7. 生成 DMG、ZIP、blockmap 和 `latest-mac.yml`；
8. 对解包后的 `.app` 执行离线启动与健康检查；
9. 使用 `codesign`、`spctl`、`stapler` 校验签名和公证；
10. 生成 SHA-256 checksums、SBOM 和 GitHub Artifact Attestation；
11. 创建不可见 Draft Release，上传并复核完整资产集合后一次性发布。

预期 Release 资产至少包含：

```text
ITHARBORS-<version>-arm64.dmg
ITHARBORS-<version>-arm64-mac.zip
ITHARBORS-<version>-arm64-mac.zip.blockmap
latest-mac.yml
checksums.txt
sbom.spdx.json
```

workflow 必须在发布前验证资产白名单、版本、架构、摘要和 Release 类型。目标 Release 已存在时
失败关闭，不对既有 Release 追加或替换文件。工作流只能删除本次运行创建且尚未发布的 Draft；
上传或校验失败时清理该 Draft，更新器始终看不到半完整 Release。Stable job 使用受保护的
production environment；Preview 使用独立 preview environment 或直接发布 prerelease，但仍要求
相同签名与公证。

## 签名、公证与供应链安全

macOS 自动更新要求应用使用 Developer ID Application 签名。GitHub Actions 需要以下 secrets：

```text
MAC_CSC_LINK
MAC_CSC_KEY_PASSWORD
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
APPLE_TEAM_ID
```

证书、密码和 Apple API Key 不进入仓库、日志、Artifact 或 Release。workflow 在缺少任何凭据时
必须失败，不得自动降级为 unsigned Stable Release。

安全边界包括：

- GitHub HTTPS provider 和固定仓库身份；
- update manifest 中的 SHA-512 资产摘要；
- macOS 平台代码签名校验；
- notarization 与 stapled ticket；
- GitHub Artifact Attestation 绑定 repository、workflow、Tag Commit 和产物摘要；
- 不可变 Tag 和 GitHub Release；
- Renderer 不可配置更新源或直接安装文件。

## 失败处理

- Production Runtime 启动失败：不打开业务窗口，展示可诊断错误并允许退出，不回退到开发栈。
- Client 静态资源缺失：构建或冒烟测试失败，不生成 Release。
- 原生模块 ABI 不匹配：打包测试失败，不生成 Release。
- 签名或公证失败：workflow 失败且不创建 Release。
- GitHub Release 创建失败：清理本次运行创建的 Draft，保留 Actions 日志和临时 Artifact，不生成
  半完整正式 Release。
- 更新检查失败：当前版本继续运行，稍后或手动重试。
- 更新下载失败：删除不完整临时文件，当前版本继续运行。
- 更新安装前关闭失败：不调用 `quitAndInstall()`，避免强制终止仍在写入的数据。

## 测试与验收

### 自动化测试

- Tag 解析、canonical SemVer、版本一致性和 Stable/Preview 推导。
- app workflow 只匹配 `app/v*`，Kit workflow 只匹配 `kit/*/v*`。
- Production Runtime 的资源路径、动态端口、就绪、超时和关闭。
- Server 正确提供 hash 资源、SPA fallback、API、SSE 和安全路径校验。
- packaged mode 不生成 npm、tsx 或 Vite 子进程命令。
- `app.getVersion()` 正确进入 Kit runtime compatibility。
- 更新状态机的并发抑制、错误恢复、Preview 策略和受控安装。
- preload/IPC 拒绝未声明参数、任意 URL 和 Renderer 越权调用。
- electron-builder 文件白名单不包含产品 Kit、测试、源码和开发工具。
- workflow 权限、固定 reusable Tag、环境门禁和资产白名单契约测试。

### 安装包验收

1. 在干净 macOS arm64 环境安装 DMG。
2. 在没有 Node.js/npm 的环境启动应用并打开 Default Kit 与 Kit Manager。
3. 从市场安装 Kit，重启后仍可用。
4. 验证 `.app`、DMG、ZIP 的 arm64 架构、签名、公证和 Gatekeeper 状态。
5. 从较低 Preview 安装包发现、下载并升级到较高 Preview。
6. Stable 安装不发现 Preview Release。
7. 从较低 Stable 安装包升级到较高 Stable，Workspace 与 Kit Store 保持不变。
8. 模拟离线、404、损坏 metadata 和下载中断，确认当前版本仍可启动。
9. 使用 GitHub CLI 验证所有公开二进制资产的 Artifact Attestation。
10. 确认 `app/v*` 不触发 Kit workflow，`kit/*/v*` 不触发 app workflow。

## 推进顺序

1. 建立 desktop package、版本模型和构建边界。
2. 建立 Production Runtime 与静态资源服务。
3. 接入 electron-builder 并完成 unsigned 本地目录/DMG 冒烟测试。
4. 接入 updater 状态机、菜单和受控重启。
5. 增加 app Tag 校验、发布 workflow、provenance 和发布文档。
6. 配置 GitHub environments、Tag ruleset 与 Apple secrets。
7. 发布两个连续 Preview 版本，完成真实安装与更新验收。
8. 验收通过后发布首个 Stable。

## 外部前置条件

代码和 workflow 可以在没有 Apple 凭据时完成并通过非发布测试，但真实自动更新闭环只有在仓库
配置 Developer ID 和 notarization secrets 后才成立。凭据缺失不允许用 unsigned Release 代替
验收。
