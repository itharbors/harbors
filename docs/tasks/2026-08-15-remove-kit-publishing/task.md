# 2026-08-15-remove-kit-publishing

Task ID: `2026-08-15-remove-kit-publishing`
Type: `feature`

## 背景与问题

仓库此前包含 GitHub Actions 驱动的 Kit 发布、Release Tag、Registry 聚合与版本递增门禁。这些能力超出当前仅在本地开发、校验和打包 Kit 的需求，也使仓库的维护与变更流程不必要地依赖远程发布基础设施。

## 目标

- 移除 Kit 的 GitHub Actions 发布、Registry、Release Tag、发布意图和版本递增门禁。
- 保留 Kit 的本地发现、构建、校验、打包和制品检查能力。
- 将文档统一为本地 Kit 开发与打包模型。

## 范围

- 删除发布、Registry 和 Release Tag 相关实现、工作流、测试与文档引用。
- 保留普通开发检查，以及 Kit 的本地 `validate`、`pack`、`inspect` 流程。
- 更新根文档、架构文档和 Kit 开发指南。

## 非目标

- 新建或实现 agent-chat Kit。
- 增加新的远程 Kit 分发、安装或市场能力。
- 改变现有插件 package 架构或 Web host 行为。

## 验收标准

- 仓库不再包含 Kit 发布、Registry、Release Tag 或版本递增门禁。
- Kit 仍可在本地完成构建、校验、打包与制品检查。
- 文档不再描述 GitHub 自动发布、远程 Registry 或 Release Tag 流程。
- 受影响的测试和静态检查通过。

## 约束

- 保持当前 VisualSJ/main 已移除的 Kit workflow 和插件 package 架构，不恢复旧工作流。
- 本 Task 仅处理发布体系清理；agent-chat Kit 延后单独实现。

## 需求变更

用户确认将 GitHub 上的 Kit 工作流、发布版本相关内容全部移除，并要求在最新 `VisualSJ/main` 基础上以无冲突变更提交；此前冲突的 PR 不继续修复。
