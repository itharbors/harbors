# 验证产物

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../../2026-10-22-agent-turn-durability/summary.md)。

- `p100-result.json`：同机 1/10/50/100 Turn 性能原始样本和三项门禁。
- `q30-result.json`：Q30 fixture v2 的 30 个真实模型用例各 3 次的 current/candidate Context Plan、期望、答案、评分和错误。v2 保持用例意图不变，明确最终状态和值类型，并按状态字段检查失效旧值。

Q30 报告不包含 Provider 凭据或 Panel capability。`baseUrl` 是历史隔离 Web 宿主的本地地址。2026-08-29 原始报告中 current 90/90 可评分且 90/90 通过；candidate 89/90 可评分且 89/89 通过，M09 repeat 1 为 Provider 空响应（MODEL_SERVICE_INVALID_RESPONSE），原始 regressions 也保留该项。status=completed 只表示 runner 结束，不表示质量门禁通过。

严格门禁保持 candidate 全部 90 次可评分、通过数不低于 current、无同 case/repeat 新增回归；当前未通过。已评分答案无语义失败与缺失 1 次可评分结果分开报告，不能删除 error/regressions、减少分母或改答案伪装成通过。

现行 runner 注入期望最终有效 state（oracle state），评测范围是 Context 装配比较；不证明真实模型状态抽取准确率、Agent 状态工具接受的端到端成功率或完整工具执行链。独立确定性 Agent 集成测试只证明各自覆盖范围。

2026-10-22 文档复核仅重新读取这些原始产物，不重跑模型、不修改 JSON；流式与 Stop 实现缺口另见 [Task](../task.md)。P100 的性能通过不替代严格 Q30 或故障门禁。
