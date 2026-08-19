# 2026-08-19-builtin-luna-subagents

Task ID: `2026-08-19-builtin-luna-subagents`
Type: `chore`

## 背景与问题

`delegate-codex-subagents` Skill 当前依赖外部命令行代理、Relay 配置、Python 启动器、任务描述文件和操作系统级隔离包装。这套执行方式与 Codex 内置 Subagent 能力不一致，也增加了启动链路、维护成本和环境依赖。

## 目标

将 `delegate-codex-subagents` Skill 改为使用 Codex 内置 `multi_agent_v1` Subagent 工具，并固定使用 Luna High 配置。Skill 应能指导主 Agent 完成原子拆分、互斥并行委派、克制等待、失败修正、实际变更审查和代理关闭。

## 范围

本 Task 只修改以下文件：

- `.codex/skills/delegate-codex-subagents/SKILL.md`
- `.codex/skills/delegate-codex-subagents/agents/openai.yaml`
- 删除 `.codex/skills/delegate-codex-subagents/scripts/run_subagents.py`
- 删除 `.codex/skills/delegate-codex-subagents/tests/test_run_subagents.py`
- `docs/tasks/2026-08-19-builtin-luna-subagents/task.md`

Skill 文案需覆盖内置 `spawn_agent`、`send_input`、`wait_agent`、`close_agent` 的职责和流程；每次创建代理固定使用 `model="gpt-5.6-luna"`、`reasoning_effort="high"`，默认最多 4 个活跃代理；子任务使用自包含内联 prompt，明确目标、上下文、允许修改、验收检查和禁止事项。

## 非目标

- 不修改仓库其他源码、测试、文档、配置或工作流文件。
- 不新增替代启动器、任务描述文件或外部代理协议。
- 不调整业务逻辑、插件实现、Kit 装配或 Framework 行为。
- 不提交、发布、推送、创建分支或合并变更。

## 验收标准

- `SKILL.md` 明确只能使用 `multi_agent_v1` 的 `spawn_agent`、`send_input`、`wait_agent`、`close_agent`。
- required references 验收必须明确覆盖 `multi_agent_v1`、`spawn_agent`、`send_input`、`wait_agent`、`close_agent`、`gpt-5.6-luna`、`reasoning_effort` 和 `high`。
- `SKILL.md` 明确禁止外部代理命令、任务描述文件、旧 Python 启动器、外部 Relay 配置和操作系统级隔离包装。
- `SKILL.md` 明确固定模型 `gpt-5.6-luna`、推理强度 `high`，默认最多并行 4 个活跃代理。
- `SKILL.md` 明确原子拆分、互斥写入范围、自包含内联 prompt、主 Agent 只做编排与只读验收、失败优先修正或重新委派、完成后审查并关闭代理。
- `openai.yaml` 的展示文案和默认提示同步为内置 Luna High Subagent。
- 两个旧 Python 文件已删除，Skill 目录不再包含旧启动器相关内容。
- `python3 /Users/test-user/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/delegate-codex-subagents` 通过。
- `rg -in 'codex CLI|relay-alwaysday1|auto_model/alwaysday1|run_subagents\\.py|sandbox-exec|Brief JSON' .codex/skills/delegate-codex-subagents` 无匹配结果。
- `git diff --check` 通过，且实际改动文件严格限制在本 Task 范围内。

## 约束

- 直接在当前 `main` 工作区修改，不切换分支。
- 不使用外部代理命令或 Python 启动器执行子代理；本次若需要子代理只能使用 Codex 内置 Subagent 工具。
- 不创建或读取凭据，不扩大权限，不执行发布、推送或其他外部不可逆操作。
- 保留工作区中与本 Task 无关的既有改动，不覆盖或还原用户文件。
- 文档默认使用中文；工具名、模型名和参数名保持原文。

## 需求变更

本 Task 将原计划中的外部代理启动方式调整为 Codex 内置 `multi_agent_v1` Subagent 工具，并明确使用 Luna High；其余范围和验收目标未变。
