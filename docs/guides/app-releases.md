# 主程序构建、发布与验收

ITHARBORS 主程序用 updater 可直接解析的 `v<semver>` Tag 发布；受保护的 `app-publish-v1` 可复用工作流以
**Developer ID Application** 身份签名、notarize、attest 并发布。

## 本地开发与结构验收

先在干净工作树运行：

```bash
npm run check
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:dir
file dist/desktop-release/mac-arm64/ITHARBORS.app/Contents/MacOS/ITHARBORS
npx --no-install asar list \
  dist/desktop-release/mac-arm64/ITHARBORS.app/Contents/Resources/app.asar
```

确认可执行文件为 `arm64`、`app.asar` 含桌面入口而不含产品 Kit、
`Contents/Resources/runtime/kits` 仅含 `default`，并确认原生 `better-sqlite3` 位于 asar 解包位置。
An unsigned local package supports isolated structural and runtime-smoke acceptance only; it is not signing, notarization, update, or Release acceptance.

启动目录包必须隔离真实状态并关闭更新检查：

```bash
acceptance_user_data=$(mktemp -d "${TMPDIR:-/tmp}/harbors-package-acceptance.XXXXXX")
HARBORS_DISABLE_UPDATE_CHECKS=1 \
  dist/desktop-release/mac-arm64/ITHARBORS.app/Contents/MacOS/ITHARBORS \
  --user-data-dir="$acceptance_user_data"
```

等待 Framework health、Default Kit/Kit Manager 可用；通过真实本地 installer 安装临时 fixture Kit，
正常退出并重启后确认状态持久化。headless 验收可向主进程发送 `SIGTERM` 或 `SIGINT`；它们会进入与托盘
“Quit ITHARBORS”相同的 `app.quit()` 有序关闭路径，而不是强制终止。不要复用真实 userData 或使用 `kill -9`。仅在确认变量仍指向这次
`mktemp -d` 创建的目录后删除它。签名、Gatekeeper、stapling 与更新验收只能针对 GitHub 签名产物。

## Apple 凭据边界

- `MAC_CSC_LINK` 是 **Developer ID Application** 证书 `.p12`（或其受控链接），
  `MAC_CSC_KEY_PASSWORD` 是该证书导入密码；它只用于应用签名。
- **App Store Connect Team API Key** 是 `.p8` 私钥内容，分别由 `APPLE_API_KEY`、
  `APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 提供；工作流把它写入受限临时文件供 electron-builder
  notarization 使用，随后删除。

发行物为 DMG 和 ZIP，不生成 PKG，所以 **Developer ID Installer** is not required。`APPLE_TEAM_ID`
仅用于验证签名的 Team Identifier，不能替代私钥。

## 发布确认与 GitHub 门禁

本地干净 `main`、已获取的 `origin/main`、`packages/desktop/package.json` 与 `v<semver>` 必须一致，
且 Tag 不能已存在。先运行：

```bash
npm run app:release -- <semver>
```

脚本会打印发布身份字段（Tag、版本、Commit、渠道），并给出唯一的精确确认 token
`v<semver>@<40-char-commit>`。获得对该 Commit/Tag 的明确确认后，再按输出设置
`HARBORS_APP_RELEASE_CONFIRM` 重跑。An implementation approval or merge approval is not an exact release confirmation.

`v*` wrapper 仅调用 `app-publish-v1`；必须先从已合并、已审查的 Commit 创建并保护
`app-publish-v1` Tag，再允许任何 `v*` Tag。禁止创建 `app-publish-v1` 同名分支，并保护
`v*` 与 `app-publish-v1` Tag，禁止未审查的创建、更新或删除。仓库 Actions 策略只允许审核过的
GitHub 官方 Actions，并要求第三方 Action 使用完整 Commit SHA；工作流内的 checkout、setup-node 和
attest 也固定到已审核 SHA。
普通 SemVer 进入 `app-stable` environment；带 prerelease 段的 SemVer 进入 `app-preview` environment。
六个 Apple Secret 只保存在这两个 environment 中，caller 不使用 `secrets: inherit`。Stable 审批与
Preview 权限都由 GitHub 环境门禁控制，不能由本地脚本绕过。

如果 Tag push 失败而只留下本地 Tag，先用 `git ls-remote --refs --tags origin refs/tags/v<semver>`
证明远端不存在，再核对本地 Tag 指向预期 Commit，最后才可执行 `git tag -d v<semver>` 后重试；远端
已存在时不得删除或重建。如果工作流清理 Draft 失败，只能先读取 Release 的精确 ID，确认它仍为
`draft: true` 且 `tag_name` 完全一致，再按该 ID 删除。不得按可变 Tag 盲删，也不得修改已发布 Release。

## 发布物验证与恢复

工作流拒绝修改已有 Release，先建立 Draft，并始终按本次创建的 Release ID 上传、核对和发布 DMG、ZIP、
ZIP blockmap、`latest-mac.yml`、
`checksums.txt` 和 SPDX SBOM 后才一次发布。下载资产后：

```bash
gh attestation verify ITHARBORS-<semver>-arm64.dmg --repo itharbors/harbors
```

再核对 `checksums.txt`，并以 `codesign`、`spctl`、`xcrun stapler validate` 验收签名包。Release 与资产
不可替换；问题必须通过 higher version（higher SemVer）修复，不能覆盖已有 Tag、资产或已发布版本。
