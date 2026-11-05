# 整理已有未提交改动总结

## 最终结论

已整理原有档案和 Model Service 流式收口改动，保留原始评测数据并还原无关生成 CSS 差异。目标检查与隔离浏览器验收通过；仓库全局门禁仍被既有架构检查阻断。

## 需求完成情况

- Context Store 与工具错误历史档案已分别提交；历史 Q30 和其他原验收缺口未改写。
- 流式在 OpenAI `[DONE]` 或 Anthropic `message_stop` 后结束读取；仅有 `finish_reason` 时等待完整结束、连接关闭或请求超时。
- 迟到用量通过单独分片接收；不再使用 250 毫秒提前收口。

## 主要改动

Model Service 消费完整结束标记后停止读取并释放 reader；新增结束标记后连接保持打开、迟到用量、超时及结束后残留数据的回归测试。

## 关键决定

用户选择优先等待完整数据：若上游只发送 `finish_reason` 便保持连接，请求可能等待到超时；不承诺所有不完整的上游都可成功完成。

## 验证结果

- Model Service 定向测试 45/45 通过；目标 Plugin 构建及产物校验通过。
- `pnpm run kits:check harness`：通过。
- `pnpm run check`：未通过；在 `test:kit-architecture-boundary` 检出 3 处 prompt-eval 跨 Kit 引用及 Client 测试中的静态 Kit 列表，均是已有问题，后续门禁未运行。
- 隔离 Web 宿主、临时数据根、内存凭据和本地模拟 Provider：正常结束显示完成，350 毫秒后到达的 usage 确认写入事件；仅有 `finish_reason` 时持续运行，取消后显示已取消。
- timeout 在自动测试中验证；浏览器未等待实际超时，真实 Provider 未重验。

## 影响与风险

请求在仅收到 `finish_reason` 时可能一直等待至配置超时，系统上限为五分钟；不会提前截断后续数据。无运行时协议或配置变更。

执行全仓检查期间现有 dev Gateway 和 Server 进程发生重启，时间与构建吻合，可能影响当时运行中的会话。

## 偏差与遗留

历史严格 Q30 与此前 Agent Turn 的追加 Web 复验保持原状态；本任务不将其写为通过。

## 后续关注

如需判断特定 Provider 是否缺少完整结束信号，应采集该 Provider 的实际流式协议证据。

## 相关正式文档

- [Agent Context Store](../../architecture/agent-context-store.md)

## Decision Delta 与 Findings

- blocking：全仓 `pnpm run check` 的既有架构边界问题未解除；独立代码审查未执行，不能宣称仓库交付门禁全部通过。
- non_blocking：真实 Provider 未重验；仅有 finish_reason 的服务可能等待到超时。
- decision_candidates：无。
- follow_up：按需验证真实 Provider，另行处理历史 Q30 与先前任务验收。
