# Conversation 设置与归档管理实现总结

## 最终结论

Conversation Plugin 已拥有独立“对话设置”页面，并完成活动会话归档、归档查询和原 ID 恢复。Agent 保持归档文件事实所有权，Conversation 保持选择状态和 UI 投影所有权；实现、三轮独立代码审查、完整 Kit 自动验证与真实 Web 浏览器验收均已完成，没有阻止收口的问题。

## 需求完成情况

- 活动列表公开语义由可恢复的 `deleteConversation` 收敛为 `archiveConversation`，设置页支持查看并恢复归档。
- Agent 仅允许 Conversation caller 访问归档协议；callerless、Settings、Agent 和其他业务 Plugin 均被拒绝且零副作用。
- 归档当前选择时确定性回退到后一条、否则前一条；最后一条归档后进入继承项目的空草稿。
- 恢复保持原 ID、标题、项目和历史，重新进入活动列表但不抢占当前选择。
- tombstone v1 与 legacy 记录严格解析；损坏、冲突、symlink、时间异常和补偿失败均 fail closed 并保留证据。
- 同 ID mutation 使用 Promise queue 串行；不同 ID 可并发，broadcast 与 request value 任意先后均幂等收敛。

## 主要改动

- `kits/harness/plugins/agent/**`：增加归档查询、原子归档/恢复、稳定业务 envelope、caller 白名单、只读 tombstone 投影和完整文件失败注入测试。
- `kits/harness/plugins/conversation/**`：增加 Settings contribution、归档管理页面、owner 请求、初始化 barrier、per-ID queue、选择回退和 List Panel archive/restore 投影。
- `kits/harness/tests/assembly.test.ts`：覆盖真实跨 Plugin 链路、caller 拒绝、活动 Turn、跨重启恢复、损坏证据保持和广播顺序。

## 关键决定

- Settings Center 只负责目录、导航与容器，不持有或代理 Conversation 业务数据。
- Conversation 与 Agent 的已知业务失败使用显式 `BusinessResult`；生命周期、路由和未知 unavailable 继续抛 transport 异常。
- 归档沿用 Agent 私有 trash/tombstone 存储，但升级为可查询、可恢复且有补偿语义的状态迁移。
- 归档查询严格只读，不触发 legacy import、目录创建、尾行修复或活动缓存调和。

## 验证结果

- Conversation 定向测试：15/15 通过；Agent 归档/存储定向测试：34/34 通过。
- `pnpm --dir kits/harness run test:kit`：279 unit、2 runtime plugin、10 assembly 通过。
- `pnpm run kits:check harness`、两个目标 Plugin build/check、`git diff --check`：通过。
- 独立 code review 共发现并关闭：不同/同 ID 并发竞态、orphan archive、极端时间阻断、恢复提交后加载、异常过度吞并、Settings 重试反馈、补偿矩阵缺口和 List Panel 旧 `delete` 投影。
- 隔离 data root 的真实 Chromium 验收通过：三条会话创建、归档中间项、选择回退、Settings 元数据、Host 重启持久化、恢复不抢选择、恢复后列表重现、最后一条归档进入草稿、375×812 无横向溢出、focus-visible、ARIA status/label 与视觉截图。

## 影响与风险

- `blocking`：无。
- `non_blocking`：Kit teardown 偶发既有的临时目录已删除后异步读取 stderr，但全部测试最终通过；浏览器新 session 协商会先探测不存在的 `/api/session/<id>` 并得到预期 404，不影响页面或业务请求。
- `decision_candidates`：无。
- `follow_up`：无。

## 偏差与遗留

没有已知需求偏差。活动 Turn 拒绝、损坏归档与文件补偿通过真实 Kit/Plugin/磁盘 assembly 验证；浏览器环境没有模型 Provider，因此未人为启动供应商 Turn，未用 mock 冒充该存储状态验证。

## 后续关注

当前没有额外关注项。

## 决策闭环收口

### Decision Delta

- `Task-only`：Conversation 拥有选择/UI，Agent 拥有归档文件事实；业务 envelope、per-ID queue 与可恢复 archive 语义限定在 Harness 的两个 Plugin 内。
- `ADR`：无新增或修订。
- `architecture`：没有超出既有 Plugin 消息交互原则的新仓库级架构。
- `guide`：无需要推广为通用开发规则的增量。
- `candidate`：无。

### 正式落点

- 需求、协议、失败语义、验证和浏览器证据保留在本 Task 的 `task.md`、`.work/**` 与 `summary.md`。
- 未修改 Settings、Framework、Chat 或其他业务 Plugin 的事实所有权文档。

### 反向检索验证

- 查询“Conversation 归档”“对话设置”“archiveConversation”“ARCHIVE_STATE_INCONSISTENT”时命中本 Task 与对应 Plugin 实现。
- 未发现需要更新的既有 ADR、architecture 或 guide，也没有待批准的长期决策候选。

## 相关正式文档

- [Task 需求](task.md)
- [Task 状态](status.json)
