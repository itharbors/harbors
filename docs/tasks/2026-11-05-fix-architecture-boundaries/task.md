# 修复架构边界检查

Task ID: `2026-11-05-fix-architecture-boundaries`
Type: `test`

## 背景与问题

全仓检查发现 Harness prompt-eval 三个文件跨目录引用 Framework 构建文件，以及 Framework 测试使用真实 Kit 身份列表。

## 目标

消除四项边界报错，保留现有测试和评测行为，验证后提交并推送当前分支。

## 范围

- 修正 Harness prompt-eval 的 Framework 测试入口解析和必要的测试装配。
- 将 Client Kit picker 测试夹具改为虚构 Kit。
- 执行针对性测试及全仓检查，记录结果并提交推送。

## 非目标

- 不放宽架构边界规则，不改变产品业务行为。
- 不访问真实模型、用户数据或凭据运行评测。

## 验收标准

- 全仓架构边界检查不再报出上述四项。
- prompt-eval 凭据测试和 runner 的入口解析有效，Kit picker 测试通过。
- 适用的全仓检查通过，形成符合规范的本地提交并推送。

## 约束

- 使用用户已选择的当前工作区，保留其他已有提交与内容。
- 不新增 Framework 对具体 Kit 的特殊处理。

## 需求变更

无。

## 决策上下文与处置

沿用现有公开 `@itharbors/server/testing` 测试入口和 Kit 边界规则；不新增架构决策。
