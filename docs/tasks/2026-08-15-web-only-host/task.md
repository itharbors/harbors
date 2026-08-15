# Web-only host 收敛

Task ID: `2026-08-15-web-only-host`
Type: `refactor`

## 背景与问题

主检出中存在一套未提交的 Web-only 改造，包含大量桌面端和内置 Kit 文件删除、入口及测试调整，但根锁文件、运行时数据隔离、Task 与验收尚未收口。本 Task 需在最新 `origin/main` 基线上恢复并完成这套改造。

## 目标

将 Harbors 主程序收敛为 Web-only host：移除 Electron 桌面运行、打包、更新与桌面 Kit 管理能力，仅保留内置 default Kit，并完成配置、依赖、测试和文档的闭环。

## 范围

- 将默认启动入口切换为 Web 服务，移除 Electron 专属入口、桥接、打包、更新和发布能力。
- 主仓库仅保留 `default` Kit；其他独立 Kit 不再作为主仓库 workspace 和 Registry 内置项。
- 清理失效的桌面端与 Kit 管理脚本、依赖、测试和文档引用。
- 同步根锁文件，隔离 Server 运行时数据，补充必要的回归测试与长期文档。
- 吸收最新 `origin/main` 上已合入的变更，解决重叠文件差异。

## 非目标

- 不修改或发布已拆分到独立仓库的 Kit。
- 不保留 Electron 兼容层或桌面打包通道。
- 不合并 GitHub PR；只按仓库工作流创建并验证 PR。

## 验收标准

- `npm start` 能以 Web 模式启动 default Kit。
- 根 `package.json` 与 `package-lock.json` 一致，不再安装 Electron、electron-builder 或已删除的 desktop workspace。
- 运行时生成的数据不会作为源码进入 Git。
- 构建、预检、Framework 测试及 workflow 测试通过，删除路径不存在有效源码引用。
- 分支基于最新 `origin/main`，Task ready gate 通过并创建 PR。

## 约束

- 保留主检出中的原始未提交改动，不在脏 `main` 上提交、stash、merge、rebase 或清理。
- 所有实现与收口仅在 `refactor/web-only-host` worktree 中完成。

## 需求变更

本 Task 未发生需求变更。
