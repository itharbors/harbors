# 2026-08-15-web-only-host 实现总结

## 最终结论

Harbors 已收敛为单一 Web host，且该变更已吸收最新 `origin/main` 的四个上游提交。Electron 运行、打包、更新、桌面 Kit Manager 与桌面通知链路已移除；仓库只保留 default Kit、Web 运行时和 Kit 制品/Registry 发布工具。实现、文档、工作流与全量门禁已闭环。

## 需求完成情况

- `npm start` 现在以 Web 模式装配 `kits/default`，独立端口冒烟中 health 与首页均返回成功。
- 根 workspace 和锁文件已移除 Electron、electron-builder、desktop workspace 与已删 Kit，并恢复 Kit attestation 仍直接使用的 Sigstore/Snappy 依赖。
- `.data/` 和 `local-repos/` 已忽略，主检出里原有的运行数据没有迁入变更分支。
- 代码、单测、workflow 夹具和正式文档已与 Web-only 边界对齐，失效的桌面 Skill 与发布 workflow 已移除。
- Task 分支直接基于当时最新 `origin/main`，没有在用户的脏 `main` 上进行 merge、rebase、stash 或提交。

## 主要改动

- 新增 Server Web 稳定入口，将 `start`/`dev` 收敛到 Web 运行路径。
- 删除 desktop package、Electron/preload/IPC、打包、更新、桌面发布、Kit Store/Manager、Notification Host 及其 Skill 和测试。
- 删除七个非默认 Kit 及其专属包，将 descriptor、Registry policy、CI 矩阵与 Kit workflow 身份收敛为 slug `default`。
- 修复机械批量修改造成的重复测试、旧身份断言、私有 npm registry 锁定和失效文档保证。
- 新增 Web-only ADR，并更新根 README、架构、UI、Kit、插件和开发工作流文档。

## 关键决定

- 使用最新 `origin/main` 创建隔离 worktree，再把原始脏变更按路径迁移并手工融合重叠文件，从而保留主检出原状。
- 保留 Kit Release、Registry 聚合与 attestation 工具，因为它们是发布信任链，不等同于已删除的桌面安装器。
- 发布身份统一采用 descriptor slug，不再将旧的 `@itharbors/kit-*` 包名当作 Registry ID。

## 验证结果

- `npm run check`：通过，包含全部 Framework、Client、Server、Kit、插件与 workflow 门禁。
- `bash scripts/lib/kit-workflow/kit-workflow.test.sh`：31 个场景全部通过。
- `node --test scripts/lib/kit-docs.test.mjs`：10 个文档契约全部通过。
- `HARBORS_SERVER_PORT=49399 npm start`：Server 成功启动，`/api/health` 返回 ok，首页返回 HTTP 200，SIGINT 后正常退出。
- `git diff --check`：通过。

## 影响与风险

这是有意的破坏性宿主收敛：原桌面入口、托盘、原生通知、打包更新、桌面安装 Kit 与原生窗口行为不再可用。运行时仍保留少量旧 host mode 类型和边界测试作为协议兼容防线，但仓库不再提供任何启动路径进入桌面模式。

## 偏差与遗留

没有已知的未完成代码修改。用户主检出中的原始 600 余项脏状态按约束保留，本变更位于独立 worktree 和分支中。GitHub PR 只由 finish workflow 创建，不由 Agent 合并。

## 后续关注

合并后关注 CI 在公开 npm registry 上安装依赖，以及 Web 稳定入口的首次部署日志。

## 相关正式文档

- [Web-only 宿主 ADR](../../decisions/0002-web-only-host.md)
- [系统架构](../../architecture/system-overview.md)
- [开发工作流](../../guides/development-workflow.md)
