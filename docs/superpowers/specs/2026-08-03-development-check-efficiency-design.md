# 需求开发检查效率优化设计

## 背景

当前根 `npm run check` 先执行 `npm test`，其中包含全部 Kit 的 `kits:test`，随后又执行
`kits:check`，最后通过 `plugins:check` 再执行一次 `kits:build`。`kits:check` 本身已经对每个
Kit 执行 build、test、validate，以及市场 Kit 的 pack/inspect，因此最终门禁重复执行了
Kit build/test。根 build 也会被 `test:framework` 的 `test:toolchain` 再执行一次。

本次 MySQL 凭据需求中，本地全量门禁单轮约需 8–10 分钟；开发者手动运行一次后，
`finish-change.sh` 又按安全约束运行一次。静态预检默认 TAP 输出约 19,888 bytes；相同测试
使用 Node dot reporter 后输出 104 bytes，耗时从 20.013 秒降至 17.848 秒。单 MySQL Kit
完整检查实测 54.339 秒。

GitHub Framework CI 同时监听任意 push 和 pull_request。PR #47 的相同提交分别产生了
93 秒的 push 检查和 104 秒的 pull_request 检查。

## 目标

- 保留现有最终测试、架构检查和 Kit 生命周期覆盖。
- 删除根最终门禁中重复的 build、Kit test 和 Kit build 阶段。
- 提供二十秒量级、成功输出极小的开发预检入口。
- 明确开发阶段运行预检，`finish-change.sh` 独占本地最终全量门禁。
- 功能分支只通过 pull_request 触发 Framework CI，main push 和 merge group 继续受保护。

## 非目标

- 第一版不实现 workspace/Kit 依赖闭包选择器。
- 第一版不并发运行本地 Kit matrix。
- 不缓存或复用可编辑的本地“检查通过凭证”。
- 不改变 `npm test`、`kits:test`、`kits:check` 或 `plugins:check` 的独立公共语义。
- 不减少 GitHub required checks。

## 当前状态

当前根命令关系为：

```text
check
├─ build
├─ test
│  ├─ test:framework → test:toolchain → build
│  ├─ kits:test → 每个 Kit build + test
│  └─ test:workflows
├─ kits:check → 每个 Kit build + test + validate + pack/inspect
└─ plugins:check → plugins:check:framework + kits:build
```

## 方案

### Framework prepared 边界

将现有 `test:framework` 拆为：

- `test:framework:prepared`：运行 Framework 工作区和 Node 测试，不负责根 build；
- `test:framework`：先运行 `test:toolchain`，再调用 `test:framework:prepared`，保留独立调用语义。

最终 `check` 先 build 一次，再调用 prepared 入口，避免重复根 build。

### 最终门禁去重

新的根 `check` 顺序为：

```text
build
→ test:framework:prepared
→ test:workflows
→ kits:check
→ plugins:check:framework
```

`kits:check` 保持所有 Kit 的 build/test/validate/pack/inspect，因此最终覆盖不依赖被删除的
重复 `kits:test` 和 `kits:build` 阶段。`npm test` 和 `plugins:check` 不改，避免破坏独立调用者。

### 快速预检

新增：

- `test:preflight`：以 `--test-reporter=dot` 运行 Kit 元数据、release intent、CI 选择、边界和
  workflow 关键静态测试；
- `check:preflight`：先运行全仓 Kit 架构边界，再运行 `test:preflight`。

预检是开发反馈入口，不替代最终门禁。成功日志使用 dot reporter；失败时 Node 仍返回非零并
输出失败详情。

### 开发流程约定

开发指南调整为：开发循环运行聚焦测试和 `npm run check:preflight`；提交后直接调用
`finish-change.sh`，由它运行一次 `npm run check`。第一版不修改 change-workflow Skill 本体；
纪律型 Skill 的措辞变更需要独立的多轮 agent 压力测试。

### GitHub CI 触发

Framework CI 的 push 事件限定到 `main`：

```yaml
push:
  branches:
    - main
pull_request:
merge_group:
```

功能分支创建 PR 后由 pull_request 检查；main push 和 merge queue 仍独立验证。

## 可靠性与失败处理

- `check:preflight` 失败即停止开发预检，不产生通过标记。
- `npm run check` 仍是 finish 和发布流程的硬门禁。
- prepared 入口只由已经完成 build 的根 check 使用；公开 `test:framework` 仍自行准备工具链。
- CI 触发测试必须拒绝任意功能分支 push，并接受 main push、pull_request 和 merge_group。
- 如去重后任何历史测试只在被移除的重复阶段执行，命令契约测试应失败；最终完整门禁用于验证。

## 测试计划

- TDD 修改 `ci-workflow.test.mjs`，先证明当前脚本缺少 prepared/preflight 且 check 仍重复 Kit 阶段。
- TDD 增加 CI 触发断言，先证明任意 push 当前仍会触发 Framework CI。
- 运行 `test:preflight` 并记录耗时与输出字节，确认退出 0 且成功输出显著小于默认 TAP。
- 运行 `test:framework`，证明独立入口仍准备工具链并通过。
- 运行 `npm test`，证明公共测试语义未变。
- 运行最终 `npm run check`，证明去重后的完整门禁通过。
- 运行 `git diff --check`。

## 发布与回滚

这是仓库工具链变更，不需要数据迁移或 feature flag。若 CI 或最终门禁出现覆盖缺口，回滚
`package.json` 命令组合和 CI trigger 即可；独立的 `npm test`、`kits:test`、`kits:check` 与
`plugins:check` 在整个变更中保持可用。

## 风险与权衡

- prepared 命令被直接误用时可能缺少构建产物，因此命名明确标识 prepared，并只在根 check
  和受测试的内部流程中使用。
- dot reporter 减少成功细节；失败详情和退出码仍保留，完整门禁继续使用原 reporter。
- 功能分支尚未创建 PR 时不再消耗 Framework CI；这是预期行为，本地预检负责即时反馈。

## 需求覆盖矩阵

| 需求 | 技术覆盖 | 状态 |
| --- | --- | --- |
| 降低开发反馈时间 | `check:preflight` | 已设计，待实现基准 |
| 降低成功日志 token | Node dot reporter | 已实测 99.48% 输出下降 |
| 删除重复全量工作 | prepared Framework + 单次 `kits:check` | 已设计，待完整门禁验证 |
| 不降低最终覆盖 | finish/CI 继续运行根 `check` | 已覆盖 |
| 避免双 CI | push 仅 main | 已覆盖 |
| 安全失败 | 非零退出、无通过凭证、最终 full gate | 已覆盖 |

## 开放问题

依赖感知 affected 选择和本地 Kit 并发留给后续独立设计，在本版本数据稳定后再进入 shadow mode。
