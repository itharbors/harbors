# 2026-08-15-remove-kit-publishing 实现总结

## 最终结论

本次变更已完成本地实现和验证：Kit 不再依赖 GitHub Actions、远程 Registry、Release Tag、发布意图或版本递增门禁；本地 Kit 发现、校验、打包和制品检查仍被保留。Task 尚未进入收口阶段，替代 PR 的创建、审查与合并确认不在本总结范围内。

## 需求完成情况

- Kit 发布、Registry、Release Tag 与版本递增门禁的相关实现、工作流、测试和文档引用已移除。
- Kit 继续从 `kits/` 目录进行本地发现，并保留本地 `validate`、`pack` 和 `inspect` 能力。
- 根文档、架构文档与 Kit 开发指南已调整为本地开发和打包模型。
- 受影响的 Kit workflow、Kit 校验、CI 选择、预检与文档/单体仓库测试已执行并通过。

## 主要改动

- 删除 GitHub Actions 工作流，以及 Kit 发布、Registry、Release Tag、发布意图和版本递增相关脚本与测试。
- 将 Kit 单体仓库与检查逻辑收敛为本地目录发现和制品校验，不再读取远程 Registry 或发布元数据。
- 更新 Kit 开发、制品和运行流程文档，移除远程发布描述。

## 关键决定

保留本地打包与检查链路，移除远程发布基础设施；这满足当前仅在本地开发和验证 Kit 的需求，同时不改变现有插件 package 架构或单一 Web host。

## 验证结果

以下命令已实际运行并通过：

```bash
npm run test:kit-workflow
npm run test:kit-check
npm run test:kit-ci-selection
npm run test:preflight
node --test scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-docs.test.mjs
git diff --check
```

## 影响与风险

仓库不再提供 GitHub 自动发布、远程 Registry 聚合或 Release Tag 驱动的 Kit 分发能力。需要发布或安装远程 Kit 的使用场景须在未来以新的、明确授权的机制单独设计。

## 偏差与遗留

agent-chat Kit 未包含在本 Task，按已确认范围延后单独实现。当前没有其他已知偏差与遗留。

## 后续关注

创建替代 PR 后，应确认其可干净合入最新 `VisualSJ/main`，并由 GitHub 执行该分支要求的检查。

## 相关正式文档

- [Kit 开发指南](../../guides/developing-plugins-and-kits.md)
- [Kit 制品指南](../../guides/kit-artifacts.md)
- [Kit 与会话模型](../../architecture/kit-and-session-model.md)
