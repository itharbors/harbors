# Agent Turn 持久化与 Chat 流式展示修复总结

## 最终结论

用户追加的独立复验尚未整体通过。新的后端审查发现空拒绝原因会被误判为成功终态，主 Agent 独立复现后交由另一个 worker 修复，原审查者复审通过。修复版本 Agent 100/100、Chat 112/112、runtime 与装配 16/16 通过，Agent/Chat build 与 check 通过。真实浏览器复验被 Mac 锁屏阻挡，七组场景均为 `not_run`；Task verification 保持 blocked，不以此前验收结果替代本轮完成声明。

此前工作树已补齐后端持久化顺序和 Chat 实时正文展示，前轮 D1–D10 验收记录如下：同一个模型请求仍未结束时，主正文从 A 增至 AB；完成后保留一份回答，取消或失败保留明确标注“未完成”的已提交前缀。下文的前轮通过记录和原始证据保留，新的独立复验状态单列记录。

此前把后端流式能力当成用户可见流式完成，验收范围不足。本次重开后补上 D9/D10，并保留首次真实 Web 失败及返修证据，没有将失败记录覆盖为通过。

分支为 `codex/bug-agent-turn-durability`，基线为本地 main `ae2f31f831c1d4a38ce3a33c4bd1690e733a707f`。用户已授权将已处理代码保存为一个本地 commit，范围为十六份 Agent/Chat 代码与测试、Turn 事件协议、测试指南和本 Task 三份正式文件。其余混有历史改动的设计文档、旧 Task 和评测材料继续留在本地；不推送、创建 PR 或整合 main。用户当前 `49380` 仍是主工作区版本；本地提交不代表该入口已更新，也不解除本轮浏览器复验或原严格 Q30 门禁。

## 需求完成情况

| 验收 | 结果与证据 |
| --- | --- |
| D1 流式顺序 | Store append 成功 → trace → delta；stream/fallback 与终态等待写队列，真实 Store observer 可回读 |
| D2 写失败 | 首错关闭 generation、取消上游、过滤晚到成功通知；故障 Web 中 B 写失败，仅 A 可见且可回读 |
| D3 唯一终态 | 单一 finalizer 与结构化 completion；完成、失败、取消竞争至多一个 terminal |
| D4 Stop | durable cancelled 后才 true；其他非存储故障终态 false；存储失败、无 terminal 或超时 reject；重复 Stop 共享结果 |
| D5 竞争和副作用 | 调用边界检查取消，等待实际工具/子进程退出；被拒绝的并发 send 不清理原 Turn 审批 |
| D6 审批和工具 | call/started 先提交，审批先提交再放行；结果写失败不重跑 mutation；真实 Web 仅一张待审批卡、一条工具结果 |
| D7 验证 | 根独立 Agent 89/89、Chat 112/112、runtime + assembly 16/16；七组真实 Web 及独立审查见下文 |
| D8 文档与边界 | 同步七份关联 Markdown；原始 P100/Q30、13 份非目标基线及主工作区 18 份原件保持不变 |
| D9 真实可见流式 | 同请求在 A、AB 两次取证时均 `finished=false`、`closed=false`；第三段及终态尚未放行，正文已经增长，折叠过程栏仍可见 |
| D10 预览与最终态 | 完成快照替换同 Item 预览且正文唯一；取消/失败保持未完成；新会话、续聊、活动会话切换及刷新覆盖通过 |

## 主要改动

- 追加独立审查修复：在 sendMessage 捕获边界将非 Error 拒绝原因经现有错误 envelope 归一化，避免 undefined/null/false/0/空字符串被当成“没有失败”；新增十种同步/异步失败路径回归，验证唯一 failed 终态、没有模型执行、下一 Turn 可恢复。
- Agent 活动 Turn 统一拥有 completion、finalizer 和 Stop Promise。终态在实际 Store append 边界锁定；流式与 fallback 通知等待事件提交，首个持久化错误终止 generation。
- 工具执行错误与结果持久化错误分离；只读工具组等待 allSettled，Bash 发出 kill 后等待真实 close。审批提交成功后才放行；同步 busy guard 防止第二次 send 清理原请求审批。
- Chat 从同一已提交 canonical Item 生命周期构建正文预览：delta 按顺序累积，completed 快照成为最终正文。移除 App 中未被 Transcript 消费的重复 delta 消息状态，保留对外消息协议。
- Transcript 和 Markdown 在内容增长时更新；预览直接出现在主正文，过程栏折叠不隐藏。失败、取消或未完成 Item 不冒充成功最终回答。
- 切换会话先清理旧展示再加载目标快照；保留外层 public 会话 gate，仅在 canonical 投影边界把 `harbors:<adapterId>` 转为 native adapterId。真实消息双 ID fixture 和实际 checkpoint 能稳定拦住原缺陷。
- 本地 step 0 占位先归并到实际 step，消除重复 step/key 与审批卡。批量事件重放一次建立索引、一次排序，避免每个 chunk 重复扫描和复制全部状态。

## 关键决定

沿用既有同步 Store、request/broadcast、Item 生命周期和默认权限。没有增加事务协调器、operation journal、存储格式或依赖；同步 Store 仅在调用边界检查取消。

| Decision Delta | 证据、影响范围与状态 | 分类、落点和反向检索 |
| --- | --- | --- |
| 提交成功后才通知，首错阻止成功内容；唯一 finalizer 与 durable Stop | D1–D6、故障/竞争测试、真实 Store 与 Web；Agent 内已验证 | architecture：[Context Store](../../architecture/agent-context-store.md)，检索“generation”“唯一终态”“stopConversation” |
| 已提交 Item delta 供实时展示，completed 快照权威，预览不成为第二份持久事实 | D9/D10、新会话和续聊 pending 前缀、最终唯一；Chat 已验证 | architecture：[Turn 事件协议](../../architecture/agent-turn-event-protocol.md)，检索“预览”“completed” |
| public 路由身份与 native 事件身份在明确边界转换 | 首轮 Web 失败、真实 checkpoint、第三轮独立审查；Chat 投影已验证，外层隔离保留 | architecture：同协议，检索“harbors:”及“adapterId” |
| 流式功能必须在请求未结束时验证正文增长，fixture 保留真实跨层契约 | 实际浏览器 A/AB、旧 bundle 确定失败回归；已验证 | guide：[测试指南](../../guides/testing.md)，检索“流式”“完成前”“fixture” |
| 重放性能返修、两轮失败/返修、受控上游取证和交付边界 | 独立评审、原始测试/截图；仅本 Task | Task-only：本摘要及 `.work/`，以 Task ID、D9、双 ID、Q30 反向检索 |

正式决策记忆两次查询均 fresh、failed_files=0、无命中；沿用 ADR 0005 和核心原则。没有新增 accepted ADR，亦未将无命中解释为没有既有决策。

## 验证结果

追加独立复验由未参与原实现的后端审查者、Chat 审查者及验收 worker 分开执行；后端缺陷由另外的修复 worker 处理，主 Agent 核对实际 diff、失败/通过原始日志、源码哈希和保护范围。

| 本轮独立复验 | 结果 | 本 Task 本地证据 |
| --- | --- | --- |
| 后端首次审查 | 发现 P2：无 reason rejection / throw null 会返回空成功并写 completed；主 Agent 复现 | `.work/fresh-backend-review.json`、`fresh-root-backend-probe.log` |
| 修复与独立复审 | 实现增量三行；十种新增场景修复前全部失败、修复后通过；原探针及十九组独立扩展探针通过 | `.work/fresh-repair-implementation.json`、`fresh-backend-rereview.json` |
| Chat 独立审查 | 未发现确定缺陷；九项额外边界探针通过 | `.work/fresh-chat-review.json` |
| 独立自动验收 | Agent 100/100、Chat 112/112、runtime + assembly 16/16；目标 build/check 通过；绑定十六份源码哈希 | `.work/fresh-acceptance-result.json` |
| 新的真实 Web 七组复验 | 全部 not_run，工具报告 Mac 锁屏；未创建测试宿主、数据目录或标签页 | `.work/fresh-acceptance-browser-blocker.json` |

本轮首次自动验收曾让 dist 依赖测试与 Chat build 并行，造成五项 Chat 与两项 runtime/装配测试缺 dist；纠正为先 build 再测试后全部通过，原失败日志完整保留。修复前 Agent 89/89 的结果保留为历史，当前以修复后的 100/100 为准。

以下表格与七组 Web 记录属于追加独立复验前的验收。

| 执行者与验证 | 结果 | 本 Task 本地证据 |
| --- | --- | --- |
| 实现者目标 Chat build / check | 均 exit 0 | `.work/chat-stream-build.log`、`chat-stream-check.log` |
| 根独立 Chat 全部并置测试 | 112/112，0 fail/skip | `.work/root-chat-stream-unit-final.log` |
| 根独立 Agent 全部针对性测试 | 89/89，0 fail/skip；Chat 返修期间 Agent 八文件冻结 | `.work/root-chat-stream-agent-unit.log` |
| 根独立 runtime + Kit 装配 | 16/16，2 文件通过 | `.work/root-chat-stream-assembly.log` |
| 独立代码审查 | 第三轮通过；112/112、真实 checkpoint 旧/新 DOM 对照、错误 public envelope 拒绝、八文件 SHA 匹配 | `.work/chat-stream-code-review-round3.json` |
| 独立性能复核 | 3k chunks 全量 parse 中位 1.677ms；尾 20 次合计 26.884ms；只衡量同步解析，不代表端到端渲染延迟 | `.work/chat-stream-code-review-round2.json` |
| 根真实 Web | 七组全部通过，首次失败历史保留 | `.work/chat-stream-browser-verification.json` |
| 独立 Web 证据复核 | 7/7 原始 AX/checkpoint 逐项通过，实际视检 A/AB 截图并核对取证时间与同请求 pending 状态 | `.work/chat-stream-web-independent-review.json` |
| 根保护与清理 | 16 个已审源码哈希匹配，13 份非目标和 18 份 main 原件不变；隔离宿主与目录清理，main 服务保留 | `.work/chat-stream-final-scope-result.json` |

真实 Web 使用完整 Gateway/Server/Client、Harness 和 14/14 Plugin，测试入口为 `http://127.0.0.1:54358/`。上游每次仅放行一段，再由独立控制动作推进下一段和终态；UI 操作通过浏览器完成，SQLite 与上游 checkpoint 作为交叉证据。

1. 新会话 A→AB 时同请求仍 pending；折叠过程栏不隐藏正文。放行 C 和终态后回答唯一，刷新仍唯一。
2. 继续已有会话：旧回答保留一份，新 Turn 先显示 A、再 AB，完成后两轮内容均正确。
3. 切离运行中的会话不会串内容；切回恢复 A；AB 期间刷新仍恢复同一请求的前缀，之后正常完成。
4. 点击 Stop：仅一个 cancelled terminal，AB 标为未完成，晚到控制返回 409 且上游已关闭，刷新后保持。
5. 临时 SQLite trigger 拒绝第二段写入：仅 A 持久化并显示，B 不显示；唯一 failed terminal、上游关闭。移除 trigger 后可发起下一请求。
6. 审批卡仅一份；允许一次后，asked < resolved < approval completed < tool result < terminal，相关事件唯一；工具输出正确，后续回答 A→AB 仍在完成前可见。
7. 主动断开上游：唯一 failed terminal，已有 A 标为未完成，刷新后保持。

[A 截图](.work/chat-stream-prefix-A.png) 与 [AB 截图](.work/chat-stream-prefix-AB.png) 对应同一未完成请求；每项 AX 和事件 checkpoint 由验证 JSON 索引。浏览器只记录四条预期取消/注入故障错误（含首轮失败尝试的取消），没有重复 key 或未捕获异常。

测试使用临时空数据根、工作区和测试 homedir、内存测试 vault 与本地确定性 SSE；没有访问真实用户数据、Keychain 或真实模型。宿主、临时目录和测试标签页已清理，相关日志、AX、事件及截图保留。旧后端验证证据仍在 `.work/browser-verification.json` 等文件中，不能替代本轮 D9/D10。

## 影响与风险

业务源码范围为 Agent 八文件和 Chat 八文件；其他 Plugin、Framework、manifest、依赖及外部消息协议未改。已提交 delta 的可见延迟包含持久化时间。Chat 当前仍从轨迹重建展示，本轮消除了重放中的重复扫描，尚未声称所有历史规模的端到端性能均已量化。

持久化失败会使 send/Stop 明确失败；工具副作用即使已经发生，也不会因为结果记录失败自动重跑。不响应取消的工具或上游继续占用 Turn 时，Stop 超时不能作为实际完成信号。受控上游验证的是链路行为，不代表真实 Provider 性能或模型质量。

## 偏差与遗留

- `blocking`：追加的真实 Web 七组复验尚未执行，浏览器工具明确报告 Mac 锁屏。用户手动解锁后，由独立验收 worker 在隔离环境完成并提交新证据；前轮截图不能解除本轮阻塞。
- 已关闭本轮 P2：空错误值导致 Turn 误成功；独立复审、修复前后回归及修复版本全量针对性测试通过，原失败报告和日志保留。
- `non_blocking`：原严格 Q30 仍未满足：current 90/90 可评分并通过，candidate 89/90 可评分、89/89 通过，M09 repeat 1 为 Provider 空响应。原 Context Store Task 保持 implementation blocked，原始 JSON 不变。
- `non_blocking`：本工作树尚未集成到 main，当前用户入口 49380 不包含此次修复。
- `decision_candidates`：无新增待批准长期设计。
- 已关闭旧展示遗留：step 0/step 1 重复造成的 React key 和审批卡重复已在本轮修复，真实审批场景及浏览器日志验证通过。
- 首轮代码审查发现逐 chunk 重放性能退化，返修后独立复核通过；首轮真实 Web 又暴露 public/native ID 混用。两次均先阻止阶段通过，再修复、补回归及重验，原失败记录保留。

## 后续关注

- `follow_up`：单独安排真实模型评测，补齐原严格 Q30；本 Task 的本地上游结果不能解除该门禁。原 8/31 工具错误 Task 的 verification blocked 状态也保持原样。
- `follow_up`：用户已授权一个本地 commit；推送、创建 PR 和整合 main 仍未授权。`.work/` 原始日志和截图按仓库约定保留为本机证据，不进入提交；本文保留可跨环境阅读的验证结果及剩余阻塞。

## 相关正式文档

- [本 Task 与 D1–D10](task.md)
- [Context Store 架构](../../architecture/agent-context-store.md)
- [Turn 事件协议](../../architecture/agent-turn-event-protocol.md)
- [测试指南](../../guides/testing.md)
- 本机未提交的历史材料：Agent 集成设计 `docs/tasks/2026-08-26-conversation-knowledge-base/design/agent-plugin-integration.md`
- 本机未提交的历史材料：兼容与回归边界 `docs/tasks/2026-08-26-conversation-knowledge-base/design/compatibility-and-regression.md`
- 本机未提交的历史材料：原 Context Store 摘要 `docs/tasks/2026-08-26-conversation-knowledge-base/summary.md`
- [ADR 0005](../../decisions/0005-plugin-default-boundaries.md) 与 [核心原则](../../architecture/core-principles.md)
