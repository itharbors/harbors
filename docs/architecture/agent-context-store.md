# Agent Context Store 架构

Harbors Harness 使用 `agent-context-store` Session Plugin 保存 Conversation，并在每个模型 step 装配历史 Context。SQLite events 是唯一运行时事实源；首次启动、重启和正常运行都不读取或导入 JSONL。

## 职责边界

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `agent-context-store` | Conversation event、metadata、状态投影、Context Plan、初始化和生命周期 | Model Service、tool loop、Chat 广播 |
| Agent | Turn/tool loop、输入预算、调用 Store、组装 Provider request 和 trace | 数据库和历史选择算法 |
| Conversation | 工作台选择态、draft、running 和 generation/revision | Conversation 内容持久化 |
| Chat | 用户输入和 trace 展示 | 数据库和 Agent 私有 Context |

Agent 对 Context Store 声明 Plugin 硬依赖。依赖缺失、成环或加载失败时，包含 Agent 的新 Kit 不得激活。静态预检不触碰旧 Kit；加载失败后尝试恢复旧 Kit，只有恢复成功才可继续。恢复也失败时 Editor 不可用并 fail closed，保留激活及恢复错误，需重建 runtime，不能保证无条件完整恢复。

## 数据布局与所有权

每个 User 的 `agent-context-store` Plugin data 目录使用一个 active SQLite 版本；同 User 的
不同基础 Session 读取同一 Plugin 历史，不同 User 使用不同目录。所有业务表显式携带
`conversation_id`，Conversation 不拆成多个 SQLite 文件；各 Session runtime 可分别打开同一 active 库，
同 User 内的业务隔离由查询条件、事务和测试保证。

目录由 Framework 的可信 User + Plugin 绑定提供，Store 只使用 `runtime.paths.data`，不从
消息参数选择 User，也不把 Conversation schema 下沉到 Framework。旧无 User 的 Plugin
目录不会自动读取或迁移，升级后可能出现空历史，旧文件仍保留。

- `events` 保存完整 canonical event，并在单个 Conversation 内分配连续 `seq`；
- Conversation metadata 与 `current_state` 是确定性投影，可从 events 重建；
- Context Plan 是可清理诊断，不是 Conversation 事实；
- `storage-v2` 根目录中的 `current.json` 原子指向 `versions/<version-id>` 下的 active version；
- 永久删除在 SQLite 事务内检查 archived，原子写入版本目录外 tombstone 后 DELETE/COMMIT；已写 guard 不随数据库回滚撤销，启动会应用 guard，restoreConversation 也检查 guard。当前没有通用 operation journal 或旧版本恢复入口，不把这些机制视为 backup 恢复已验证。

Agent、Conversation 和 Chat 都不直接打开该 SQLite。Agent 通过同进程 `callPlugin()` 调用 Store；
Store 将这些 server methods 显式声明为 request 且 `callers` 仅允许 `agent`，Framework 绑定
真实 caller 并执行相同 ACL。同步客户端不因此变为异步；未公开方法仍不可直调。对外业务
继续使用 request/broadcast。

## Context 装配

每个 Model Service step 前，Agent 从模型窗口扣除 System、tools、权限、输出预留和安全余量，把剩余 `availableInputTokens` 交给 Store。

Store 按三层装配：

1. mandatory state：当前目标、有效约束、已确认决定和未完成事项；
2. 当前 Turn：用户消息、assistant tool call、tool result、approval 和已加载 Skill，按发生顺序完整累积；
3. 历史 Turn：近期 8 条 surface event，以及由精确 path、error 或 ID 锚点命中的旧证据。

同一 Turn 不参与旧历史压缩。跨 Turn 后可以排除旧文件正文，但事件仍可按 source seq 审计或由 `recallHistory` 显式恢复；路径重新出现时，Agent 应重新读取工作区当前版本，不能把旧正文当当前事实。

`cancelled`、`superseded` 和 `expired` 状态在历史选择前过滤。tool call/result、approval 和 item 生命周期按闭包选择，不能拆散。mandatory 内容超过预算时返回 `CONTEXT_BUDGET_EXCEEDED`，不能静默丢弃。

当前代码默认装配模式是 candidate-v1。诊断或紧急回退可显式设置 HARBORS_AGENT_CONTEXT_MODE=surface-v1；这只切换 Context 装配，不回退存储。默认值是代码事实，不代表严格质量门禁已经通过；2026-10-22 的复核缺口见下文。

## 状态与消息链

模型私有工具 `update_conversation_state` 只产生候选。Agent 校验 action、state ID、kind 和 value 后，才写入 `state/set`、`state/clear` 或 relation event；含糊或引用不存在的候选被拒绝。

当前调用链是：

1. Chat request Agent；
2. Agent 同步 callPlugin 把用户和 Turn event 提交 Store；
3. Agent 同步调用 buildContext 并持久化 Context Plan；
4. Agent request Model Service；
5. Agent 在 Store commit 后 broadcast trace/delta 给 Chat；
6. sendMessage 等待已接收事件收口并持久化唯一 turn/end；Stop 在 cancelled 终态持久化后返回 true，超时或持久化失败拒绝。

这些广播只在当前 Session runtime 内分发。同 User 的其他 Session 通过读取或刷新看到共享
历史，本轮未增加跨 Session 的实时 UI 同步协议。

### 可靠性与验收状态

本地提交 `1d0dec9` 修复流式写前广播与 Stop 超时仍返回 true：沿用同步 Store、delta 回调、broadcast 和 `stopConversation(): Promise<boolean>`，写入成功后通知，失败关闭 generation；终态等待队列并由唯一写入点持久化。

Stop 无 active Turn 返回 false；只有 cancelled turn/end 持久化成功才 true，其他非存储故障终态返回 false；收口超时或写失败走 rejection 通道。自动测试及先前 Web 验收记录见 [修复任务](../tasks/2026-10-22-agent-turn-durability/summary.md)；追加的七组真实 Web 复验未执行，不能宣称该任务验收完成。

## 首次初始化与恢复

首次启动直接在新版本目录创建空 SQLite，建立 schema 和 metadata，通过 integrity check 后原子发布 `current.json`。Context Store 不接收 legacy root，也不枚举、打开、解析或导入旧 JSONL、archive 和 `.deleted` marker。

已有 `current.json` 时只打开其指向的 SQLite。当前运行时不提供 JSONL codec、导入或导出接口；磁盘上的历史 JSONL 不属于当前数据模型，也不会参与启动和恢复。

版本内 migration-journal.json 仅处理空库初始化发布及其崩溃恢复。当前没有一致快照备份、新版本恢复发布或对象引用校验平台；历史一次性迁移记录不能作为这些产品能力的验证。相关未来需求须另定范围，本轮不补建基础设施。

## 验证入口

```bash
pnpm --dir kits/harness run test:kit
pnpm --dir kits/harness run benchmark:p100
pnpm --dir kits/harness run eval:q30
```

P100 验证 1/10/50/100 Turn 的预算、候选上界和同机 P95。Q30 使用三类各 10 例、每例 3 次，共各 90 次真实模型对照；严格要求 candidate 全部 90 次可评分、通过数不低于 current，且无同 case/repeat 新增回归。

2026-08-29 原始报告为 current 90/90 可评分且 90/90 通过，candidate 89/90 可评分且 89/89 通过，M09 repeat 1 为 Provider 空响应；报告 regressions 保留该项，status=completed 仅表示 runner 结束。严格门禁未通过，不能减少分母或将未评分项改写为通过。

Q30 注入期望最终有效 state（oracle state），只隔离比较 Context 装配，不证明真实模型状态抽取或完整工具链；独立确定性 Agent 集成测试只证明其覆盖范围。以上历史结果未在 2026-10-22 重跑；流式/Stop 与严格 Q30 仍是 [原 Task](../tasks/2026-08-26-conversation-knowledge-base/task.md) 的未完成项，文档核对由 [独立 docs Task](../tasks/2026-10-22-context-store-design-reconciliation/task.md) 验收。

相关协议：[Agent Turn 事件协议](./agent-turn-event-protocol.md) · [Plugin 运行时模型](./plugin-runtime-model.md) ·
[Store manifest](../../kits/harness/plugins/agent-context-store/package.json) ·
[来源 Task](../tasks/2026-10-18-plugin-default-boundaries/task.md)
