# 新增 Codex Subagent 并行委派 Skill 实现总结

## 最终结论

当前仓库已新增项目级 `delegate-codex-subagents` Skill。它要求所有非琐碎工作先拆成边界明确、可独立验收的 Brief，再尽可能并行交给 Codex CLI；主 Agent 仅负责拆分、派发、监控和独立验收，不亲自实现。

## 需求完成情况

- Skill 覆盖功能、修复、重构、测试、文档、调研和审查任务。
- Codex CLI 通过 `relay-alwaysday1` profile 固定使用 `auto_model/alwaysday1`。
- 同一批互不依赖、写入范围不重叠的 Brief 默认最多 4 路并发执行。
- `execute`、`review` 的权限与 Brief 合同明确分离。
- 主 Agent 必须独立核对 diff 和验收命令；Subagent 自报完成不等同于验收通过。

## 主要改动

- 新增 Skill 触发描述、职责边界、Brief 格式、并行批次与验收流程。
- 新增 Python 启动器，校验 Brief 字段、路径逃逸、重复任务 ID 和并发写入重叠。
- 使用 macOS `sandbox-exec` 为每个 Subagent 强制独立写入边界；缺少该能力时拒绝降级运行。
- 固定 Codex profile/model，净化继承环境，并为超时进程使用独立进程组清理。
- 严格校验结构化报告，同时兼容 `auto_model/alwaysday1` 返回的单一 JSON Markdown 代码围栏。
- 在批次前后核对 Git 工作区，并标记任何超出整批允许范围的实际变更。
- 增加并行、权限、路径、Schema、环境、状态聚合和真实 OS sandbox 集成测试。

## 关键决定

- Codex 内层使用 `danger-full-access`，整个进程始终由外层 `sandbox-exec` 约束。这样避免 macOS sandbox 嵌套失败，同时保留精确到 Brief 的 OS 写隔离；两者不可拆开使用。
- `completed` 只表示 Subagent 执行成功，输出始终包含 `validation_required: true`，最终通过仍由主 Agent 独立判定。
- Relay 认证必须读取本机认证源，因此凭据相关任务不进入普通委派；需要此类操作时停止并请求用户明确授权。

## 验证结果

- `python3 -m unittest discover -s .agents/skills/delegate-codex-subagents/tests -v`：13/13 通过。
- `quick_validate.py .agents/skills/delegate-codex-subagents`：Skill 结构校验通过。
- 真实 macOS sandbox 集成测试：允许路径写入成功，越界路径被内核拒绝且未生成文件。
- 真实 `relay-alwaysday1 + auto_model/alwaysday1` 只读 smoke：成功读取完整 Skill、返回结构化报告，`actual_changes` 为空。
- 本机 profile 核对：provider 为 `super_relay`，模型为 `auto_model/alwaysday1`。

## 影响与风险

- Skill 仅适用于提供 `/usr/bin/sandbox-exec` 的 macOS 环境；其他环境会明确拒绝执行。
- Relay 认证源对 Codex 运行时仍然可读，这是模型调用的必要条件；Skill 禁止普通 Brief 涉及凭据访问或修改。
- 默认并发数为 4，可在资源允许时显式调整；并行任务仍须保持文件和接口边界互不重叠。

## 偏差与遗留

无。

## 后续关注

- 如果未来需要跨平台运行，应为 Linux 增加等价的强制文件系统隔离实现，不能静默退化为 Prompt 约束。
- 如果 Relay 输出协议稳定支持纯 JSON，可评估移除代码围栏兼容分支。

## 相关正式文档

无。
