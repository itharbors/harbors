# 插件系统独立 npm 包总结

## 最终结论

插件系统核心已独立为 workspace npm 包 `@itharbors/magnet`，位于 `packages/plugin`。Server 已改为
消费该包，npm tarball 也已在临时外部 consumer 中完成安装和运行验证。

## 需求完成情况

- `packages/plugin`：完成。
- 独立 npm 包构建、类型、测试、打包和外部导入：完成。
- Server 移除内部插件实现并依赖新包：完成。
- 原插件行为与 Framework 构建门禁：完成验证。

## 主要改动

- 新增 workspace npm 包 `@itharbors/magnet`，公开 Manifest schema、插件与贡献类型、
  `PluginModule`、生命周期状态机、Session/Application runtime host 合约、凭据 facade 和 owner
  私有存储路径。
- 将原 `packages/server/src/framework/plugin` 的实现迁入新包；Server 改为通过 workspace 依赖
  消费，不再保留内部转发副本。
- 将插件 Manifest schema 从 Kit Core 迁入新包；Kit Core 仅保留兼容转发，依赖方向调整为
  `plugin -> plugin-types/kit-core -> server` 构建链中的插件核心优先。
- 将原 `plugin-types` 中属于服务端插件系统的定义和凭据合约归并到新包；`plugin-types` 对旧
  类型入口保留 type-only 兼容转发，不在浏览器运行时加载 Node 插件实现。
- 新包只打包 `dist`，并修正 Node ESM `.js` 内部引用；已用真实 tarball 在仓库外临时 consumer
  中安装和导入。
- 更新 Framework/Kit 构建图、CI、矩阵测试、架构文档和源码索引。

## 关键决定

- 新包拥有插件核心和 Manifest schema；Server 只保留 Session、Kit、UI、消息及子进程宿主能力。
- `plugin-types` 和 Kit Core 通过 type-only/Manifest 子路径保留旧入口兼容，依赖方向不形成循环。
- 延续仓库所有 Framework workspace 的 `private` 约定，本次不直接发布 registry 版本；npm tarball
  本身可独立安装。

## 验证结果

- `npm test -w @itharbors/magnet`：12/12 通过。
- Magnet tarball 临时 consumer：`npm pack`、安装后通过 `@itharbors/magnet` 与
  `@itharbors/magnet/manifest` 导入 `PluginModule`、`parsePluginPackageManifest`、
  `createPluginPaths`，输出 `PACKAGED_MAGNET_IMPORT_OK`。
- `npm exec vitest run -- --config packages/server/vitest.config.ts packages/server/tests/framework/plugin.test.ts packages/server/tests/framework/plugin-runtime.test.ts packages/server/tests/framework/plugin-paths.test.ts packages/server/tests/application/runtime.test.ts`：64/64 通过。
- Build/CI/Kit 命名与依赖顺序聚焦脚本测试：69/69 通过。
- `npm test -w @itharbors/server`：60 个测试文件、703/703 通过。
- `node scripts/build.mjs all --force`：全部 Framework workspace 与内置插件构建通过。
- `npm run test:preflight`：169 个检查通过。
- Build/CI/Kit 聚焦脚本测试：73/73 通过。
- `npm run plugins:check:framework`：通过。
- `git diff --check`：通过。

## 影响与风险

- 包依赖顺序发生变化，CI、Kit matrix 和 clean-checkout 构建命令已同步并有回归测试。
- Application 子进程与 Session runtime 的行为保持原样，完整 Server 测试通过。

## 偏差与遗留

无功能偏差。公共 registry 发布、版本策略和取消 `private` 不在本次范围内。

## 后续关注

若后续正式发布到 npm registry，需要单独确定版本、访问级别、许可证和发布自动化；不要在本次
结构拆分中隐式启用发布。

## 相关正式文档

- `docs/architecture/plugin-runtime-model.md`
- `docs/architecture/core-principles.md`
- `docs/decisions/0001-plugin-first-architecture.md`
- `docs/guides/development-workflow.md`
