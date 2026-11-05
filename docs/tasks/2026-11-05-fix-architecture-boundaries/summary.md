# 架构边界检查修复总结

## 最终结论

修复三处 Harness 测试跨目录引用与一处 Framework 测试真实 Kit 列表，不改变产品行为或边界规则。

## 需求完成情况

- prompt-eval 使用 Framework 公开测试入口；仓库 TypeScript 配置为 tsx 提供与现有 Vitest 相同的入口解析。
- Kit picker 测试使用虚构 alpha/beta，保留创建、选择及导航断言。

## 主要改动

修改三处测试导入、一个测试入口路径映射和 Kit picker 测试夹具。

## 关键决定

继续复用已有 `@itharbors/server/testing` 公开入口，不新增 Kit 依赖或架构规则例外。

## 验证结果

- 架构检查 `node scripts/check-kit-architecture.mjs`：通过。
- `pnpm exec tsx --test kits/harness/plugins/agent/tests/prompt-eval.credentials.test.ts`：3/3 通过。
- `pnpm --filter @itharbors/client exec vitest run tests/components/kit-picker.test.ts`：21/21 通过。
- 从仓库根和 Harness 目录运行 runner 均能加载入口，因有意不提供评测配置返回 `EVAL_CONFIG_UNAVAILABLE`，未访问真实数据或凭据。
- 准备 Framework 构建依赖并初始化临时 Git 元数据后，在隔离副本执行 `pnpm run check`：通过，包括 Framework、工作流和全部 Kit 检查。
- 主 Agent 核对实际差异和验证结果；未执行独立子 Agent 代码审查。

## 影响与风险

仅修改测试文件和测试入口解析，不改变业务源码。根 tsconfig 的路径映射供 tsx 在仓库开发与测试环境解析公开测试入口。

## 偏差与遗留

隔离副本最初缺少构建产物，准备 Framework 依赖后补跑；归档副本缺少 Git 元数据，初始化临时 Git 后重跑。该临时仓库不与远端交互。

## 后续关注

历史 Model Service Task 的独立代码审查和先前验收状态不因本次修复自动改变。

## 相关正式文档

- [测试指南](../../guides/testing.md)
- [开发工作流](../../guides/development-workflow.md)

## Findings

- blocking：无。
- non_blocking：真实模型评测及独立子 Agent 代码审查未执行，本次只验证入口解析、测试替身和主 Agent 自查。
- decision_candidates：无新增决策。
- follow_up：持续使用公开测试入口，避免 Framework 绑定具体 Kit 清单。
