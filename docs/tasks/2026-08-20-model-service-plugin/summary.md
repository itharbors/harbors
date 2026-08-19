# model-service Plugin 交付摘要

## 最终结论

独立的 `model-service` Plugin 已建立并接管主模型访问，Agent 改为通过 request 使用；后续 Profile 配置未纳入本阶段。

## 需求完成情况

- Agent Chat Kit 已装配独立 `model-service` Plugin。
- Agent 已通过定向 request 获取模型目录并发起主模型请求；模型服务负责 legacy 配置、凭据、协议、HTTP、重试、取消和归一化。
- Agent 继续负责会话、工具循环、compaction、权限和 trace；本阶段未实现 Profile 配置 UI。

## 主要改动

- 新增 `kits/agent-chat/plugins/model-service`，提供 `getCatalog`、`complete`、`cancel` 三个定向 request。
- 将 Agent 的主模型目录获取、OpenAI/Anthropic 请求、重试、取消和响应归一化改为通过
  `model-service` 消费；Agent 继续负责会话、工具循环、compaction、权限和 trace。
- 保留 `HARBORS_RELAY_*`、`PI_AGENT_*` 与 DSH settings/credentials 的 legacy 兼容读取。
- 模型服务响应不返回真实凭据、凭据文件路径或环境变量名；仅返回模型目录、规范化消息和用量统计。
- 新增正式架构说明：`docs/architecture/model-service-plugin.md`。

## 关键决定

- 保留 `HARBORS_RELAY_*`、`PI_AGENT_*` 与 DSH settings/credentials 的 legacy 兼容入口。
- 本次不实现 `ctx.config`/`ctx.credentials` Profile UI，不删除 legacy 兼容入口。
- Plugin 间使用 request/broadcast 消息边界；model-service V1 没有配置写入，因此不新增配置变化广播。

## 验证结果

- model-service 聚焦测试：11 项通过。
- agent 聚焦测试：12 项通过。
- model-service、agent 两个 Plugin build/check：通过。
- `pnpm --dir kits/agent-chat run build`：通过。
- `node packages/kit-cli/dist/cli.js validate kits/agent-chat`：通过（8 plugins，8783 files）。
- 真实 Web 宿主 HTTP 消息 smoke：`model-service.getCatalog` 和 Agent `getDraftOptions` 通过。
- `git diff --check`：通过。

## 影响与风险

- 浏览器控制工具当前不可用，未完成可视化点击验收；已完成真实 Web 宿主 HTTP 消息 smoke。
- `pnpm run kits:check agent-chat` 在隔离临时仓库中因 kit-cli 缺少 `yazl`（`ERR_MODULE_NOT_FOUND`）失败，未进入 Kit 测试阶段；不是本次 Plugin 代码测试失败。

## 偏差与遗留

- 使用裸 Kit session ID 的 HTTP 请求返回 404，这是已有 runtime routing defect；使用实际复合 runtime ID 的消息 smoke 已通过。

## 后续关注

- 当前仍依赖 legacy env/DSH 配置和凭据读取，后续再迁移到 `ctx.config`/`ctx.credentials` Profile，并设计 catalog changed 广播。

## 相关正式文档

- `docs/architecture/model-service-plugin.md`
- `docs/tasks/2026-08-20-model-service-plugin/task.md`
