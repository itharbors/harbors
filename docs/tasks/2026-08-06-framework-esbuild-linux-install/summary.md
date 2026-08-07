# 修复 Linux 隔离构建缺少 esbuild 平台包 实现总结

## 最终结论

已修复 Ubuntu 通用 CI 在官方 Kit 隔离安装测试中构建 Notifications Kit 失败的问题。根项目现在显式锁定 Linux x64 的 esbuild 平台包，隔离环境执行 `npm ci --ignore-scripts` 时不再依赖安装脚本兜底下载二进制。

## 需求完成情况

- Linux x64 的 esbuild 平台包已作为根可选依赖固定版本并写入锁文件。
- 新增回归测试，持续校验包声明、锁文件根声明、下载地址、完整性和平台元数据。
- 官方 Kit 隔离启动聚焦测试和完整 Framework 测试均通过。

## 主要改动

- 在根 `package.json` 中增加 `@esbuild/linux-x64@0.28.0` 可选依赖。
- 在根 `package-lock.json` 中锁定根 esbuild、Vite 内嵌 esbuild 和 Client workspace esbuild 各自版本匹配的 Linux x64 包实体。
- 扩展 `scripts/lib/ci-workflow.test.mjs`，校验三个 esbuild 安装位置，防止 macOS 更新锁文件时再次丢失 Ubuntu 必需的平台包或让嵌套 esbuild 回退到错误版本的根二进制。
- 将 Kit 检查和 monorepo 测试中的 Agent Guard 版本预期同步到 PR #59 已发布的 `0.1.0-preview.6`。
- 将使用 macOS 专属 shell 命令的 Agent Guard watchdog 端到端恢复验收限定到 macOS；Linux 仍运行官方 Kit 隔离安装、构建、启动和进程监督验收。
- 共享状态快照忽略 Electron 首次导入时生成的 `dist` 与 `path.txt`，避免并发测试的官方延迟安装行为被误判为隔离仓库污染。

## 关键决定

沿用仓库对 Rollup Linux 原生包的既有处理方式，显式固定 CI 目标平台依赖；同时为不同版本的嵌套 esbuild 保留各自平台包，避免 Node 模块解析回退到版本不匹配的根二进制。不修改隔离安装器的安全边界。

## 验证结果

- `npm ci`：通过。
- `node --test scripts/lib/ci-workflow.test.mjs`：17/17 通过。
- `node --test scripts/lib/kit-check.test.mjs scripts/lib/kit-matrix.test.mjs`：28/28 通过。
- `node --test scripts/lib/kit-monorepo.test.mjs`：17/17 通过。
- `npm run test -w packages/server -- tests/application/official-startup-plugin-process.test.ts`：3/3 通过。
- `npm run test:framework`：完整 Framework 构建及测试通过；Server 59 个测试文件、686 个测试通过，Client 33 个测试文件、263 个测试通过，Kit Core 76 个测试通过，Kit CLI 58 个测试通过，Framework Node 测试 392 个通过。
- `git diff --check`：通过。

## 影响与风险

新增包仅在 Linux x64 上安装，在其他系统上仍按 npm 可选依赖规则跳过。版本与根 esbuild 的锁定版本一致，不改变运行时代码或官方 Kit 产品行为。

## 偏差与遗留

首次完整 Framework 测试期间，另一并发测试延迟下载 Electron 二进制，触发共享 `node_modules` 快照变化；该测试竞争已通过精准排除 Electron 自身的两个延迟安装产物消除。PR 首轮 Ubuntu CI 进一步发现 Vite 内嵌 esbuild 会回退到版本不匹配的根二进制，因此锁文件和回归测试已扩展到全部三个 esbuild 安装位置。第二轮 Ubuntu CI 已确认依赖安装通过，并进一步暴露 macOS watchdog 验收不应在 Linux 执行；现已按真实平台能力限定该子用例。本机 Docker daemon 未运行，Linux x64 的最终行为由 PR 的 GitHub Ubuntu CI 节点验证。

## 后续关注

关注 PR 的 Ubuntu `check-tests (22.18.0)`，确认官方 Kit 隔离安装测试不再报告缺少 `@esbuild/linux-x64`。

## 相关正式文档

无。
