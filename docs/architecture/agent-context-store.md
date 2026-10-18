# Agent Context Store 架构

Harbors Harness 使用 `agent-context-store` Session Plugin 保存 Conversation，并在每个模型 step 装配历史 Context。SQLite events 是唯一运行时事实源；首次启动、重启和正常运行都不读取或导入 JSONL。

## 职责边界

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `agent-context-store` | Conversation event、metadata、状态投影、Context Plan、初始化和生命周期 | Model Service、tool loop、Chat 广播 |
| Agent | Turn/tool loop、输入预算、调用 Store、组装 Provider request 和 trace | 数据库和历史选择算法 |
| Conversation | 工作台选择态、draft、running 和 generation/revision | Conversation 内容持久化 |
| Chat | 用户输入和 trace 展示 | 数据库和 Agent 私有 Context |

Agent 对 Context Store 声明 Plugin 硬依赖。依赖缺失、成环或加载失败时，包含 Agent 的新 Kit 不得激活。

## 数据布局与所有权

每个 User 的 `agent-context-store` Plugin data 目录使用一个 active SQLite 版本；同 User 的
不同基础 Session 读取同一 Plugin 历史，不同 User 使用不同目录。所有业务表显式携带
`conversation_id`，Conversation 不拆成多个 SQLite 文件，共享 schema、备份和连接生命周期；
同 User 内的业务隔离由查询条件、事务和测试保证。

目录由 Framework 的可信 User + Plugin 绑定提供，Store 只使用 `runtime.paths.data`，不从
消息参数选择 User，也不把 Conversation schema 下沉到 Framework。旧无 User 的 Plugin
目录不会自动读取或迁移，升级后可能出现空历史，旧文件仍保留。

- `events` 保存完整 canonical event，并在单个 Conversation 内分配连续 `seq`；
- Conversation metadata 与 `current_state` 是确定性投影，可从 events 重建；
- Context Plan 是可清理诊断，不是 Conversation 事实；
- 版本目录中的 `current.json` 原子指向 active version；
- 永久删除使用版本目录外的 tombstone guard，旧版本和 backup 不能复活已删除 Conversation。

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

`candidate-v1` 是通过门禁后的默认装配模式。诊断或紧急回退可显式设置 `HARBORS_AGENT_CONTEXT_MODE=surface-v1`；未设置或其他值都不能静默退回旧模式。

## 状态与消息链

模型私有工具 `update_conversation_state` 只产生候选。Agent 校验 action、state ID、kind 和 value 后，才写入 `state/set`、`state/clear` 或 relation event；含糊或引用不存在的候选被拒绝。

正常顺序是：

1. Chat request Agent；
2. Agent 先把用户和 Turn event 提交 Store；
3. Agent 调用 `buildContext` 并持久化 Context Plan；
4. Agent request Model Service；
5. 模型 delta、tool、approval 和 item event 先提交 Store，再 broadcast trace；
6. Turn 以唯一 `turn/end` 持久终态结束。

这些广播只在当前 Session runtime 内分发。同 User 的其他 Session 通过读取或刷新看到共享
历史，本轮未增加跨 Session 的实时 UI 同步协议。

## 首次初始化与恢复

首次启动直接在新版本目录创建空 SQLite，建立 schema 和 metadata，通过 integrity check 后原子发布 `current.json`。Context Store 不接收 legacy root，也不枚举、打开、解析或导入旧 JSONL、archive 和 `.deleted` marker。

已有 `current.json` 时只打开其指向的 SQLite。当前运行时不提供 JSONL codec、导入或导出接口；磁盘上的历史 JSONL 不属于当前数据模型，也不会参与启动和恢复。

## 验证入口

```bash
pnpm --dir kits/harness run test:kit
pnpm --dir kits/harness run benchmark:p100
pnpm --dir kits/harness run eval:q30
```

P100 验证 1/10/50/100 Turn 的预算、候选上界和同机 P95。Q30 使用三类各 10 例、每例至少 3 次的真实模型对照；candidate 必须全部可评分、通过数不低于 current，且不能出现同 case/repeat 的新增回归。

相关协议：[Agent Turn 事件协议](./agent-turn-event-protocol.md) · [Plugin 运行时模型](./plugin-runtime-model.md) ·
[Store manifest](../../kits/harness/plugins/agent-context-store/package.json) ·
[来源 Task](../tasks/2026-10-18-plugin-default-boundaries/task.md)
