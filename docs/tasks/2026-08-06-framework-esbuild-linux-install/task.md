# 修复 Linux 隔离构建缺少 esbuild 平台包

Task ID: `2026-08-06-framework-esbuild-linux-install`
Type: `bug`

## 背景与问题

修复 Linux 通用 CI 在官方 Kit 隔离安装测试中构建 Notifications Kit 失败的问题。测试生成的隔离仓库在调用 esbuild 时缺少当前平台的 `@esbuild/linux-x64` 可选依赖，导致 `npm run test:framework` 失败；该失败已在 PR #59 和合并前的 `main` CI 中复现。

- PR #59 的 Agent Guard 专属检查全部通过，但通用 `check-tests (22.18.0)` 失败。
- 失败套件为 `packages/server/tests/application/official-startup-plugin-process.test.ts`。
- 隔离安装器把框架 `node_modules` 注入临时运行仓库后，Notifications Kit 构建无法找到 esbuild 的 Linux 平台包。
- 同样失败从引入官方 Kit 隔离启动测试的变更后出现在 `main`，与 Agent Guard 页面改动无关。

## 目标

- 找出隔离 Kit 安装/框架快照中丢失当前平台 esbuild 包的确定原因。
- 补齐根、Vite 嵌套和 Client workspace 三个 esbuild 版本的 Linux x64 包，使 Linux CI 能稳定安装依赖并构建所有官方 Kit。
- 增加覆盖该依赖投影或平台可选依赖行为的回归测试。

## 范围

- `scripts/lib/kit-install.mjs` 及其聚焦测试。
- 官方 Kit 隔离启动测试中与依赖安装、框架快照注入直接相关的测试代码。
- 如确有必要，修正与上述逻辑直接相关的锁文件或 CI 配置。
- 修正 PR #59 合并后仍引用 Agent Guard `0.1.0-preview.4` 的 Kit 检查与 monorepo 测试预期。

## 非目标

- 修改 Agent Guard 的进程识别、流量归因或页面布局功能。
- 修改 Notifications Kit 的产品行为。
- 绕过或跳过官方 Kit 隔离启动测试。

## 验收标准

- Linux 环境下，隔离运行仓库中的 esbuild 能解析当前平台二进制包。
- `npm run test:framework` 通过，尤其是 `official-startup-plugin-process.test.ts`。
- `scripts/lib/kit-install.test.mjs` 的相关回归测试通过。
- 不降低安装器对缓存隔离、路径边界和依赖完整性的检查。

## 约束

- 从 PR #59 合并后的 `origin/main` 创建独立 bug 分支和 worktree。
- 不通过硬编码 Linux-only 路径破坏 macOS、Windows 或其他架构支持。
- 不依赖手工预装可选依赖或 CI 重跑作为修复。

## 需求变更

完整 ready gate 发现 `scripts/lib/kit-check.test.mjs` 和 `scripts/lib/kit-monorepo.test.mjs` 仍期待 Agent Guard `0.1.0-preview.4`，而 PR #59 合并后的正式版本为 `0.1.0-preview.6`。为恢复 `main` 的完整检查，在本 Task 中增加仅更新这些测试预期的收口修正，不修改 Agent Guard 产品代码。

PR 首轮 Ubuntu CI 显示根 `@esbuild/linux-x64@0.28.0` 会被 Vite 内嵌的 esbuild 0.21.5 错误解析；需求扩展为同时锁定 Vite 与 Client workspace 各自版本匹配的 Linux x64 包，避免嵌套 esbuild 回退到根二进制。

PR 第二轮 Ubuntu CI 已通过依赖安装与架构边界，但暴露两个既有的跨平台测试假设：Agent Guard 的已安装 watchdog 使用 macOS 专属的 `ps`、`date -j` 和 `base64 -D` 语义，却在 Linux 上执行其端到端恢复验收；另一个并发 Server 测试首次导入 Electron 时会延迟下载二进制，使共享状态快照误报 `node_modules/electron/dist` 和 `path.txt` 为隔离测试泄漏。需求继续收口为仅在 macOS 执行 watchdog 端到端恢复验收，并从共享状态不变性断言中排除这两个 Electron 官方延迟安装产物；官方 Kit 的隔离安装、构建和启动验收仍在 Ubuntu 完整运行。
