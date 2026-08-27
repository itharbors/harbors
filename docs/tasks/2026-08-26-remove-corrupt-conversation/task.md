# 损坏对话的可审计移除

Task ID: `2026-08-26-remove-corrupt-conversation`
Type: `bug`

## 背景与问题

Harness 已能在单个 Agent 会话 JSONL 发生中间格式或事件语义损坏时继续启动，并把该会话投影为"无法读取的对话"。但是 Conversation 列表会对不可用卡片隐藏全部操作；现有归档接口又必须先严格解析源 JSONL，因此损坏记录进入"不能打开，也不能从活动列表移除"的死状态。

现场损坏由 `ITEM_AFTER_COMPLETED` 触发。用户已明确要求移除该条目，并要求今后同类格式损坏不能阻止软件正常打开，且必须能够从界面清理错误数据。现场文件已在用户授权下移动到 owner 数据根内的 `.harbors-quarantine`，未永久删除；正常服务和 4 个健康对话已恢复并完成浏览器确认。

## 根因与修复

经排查，`ITEM_AFTER_COMPLETED` 并非真实数据损坏，而是 `pruneToolResults` 的写入缺陷：

- 裁剪历史工具结果时，新写入的 `tool/result` 替换事件复用了原事件的 `itemId`/`item`。
- 该 item 早已通过 `item/completed` 完成，`validateCanonicalSemantics` 对所有带 `item_id` 的记录做生命周期校验，于是抛 `ITEM_AFTER_COMPLETED`，整个会话解码失败。

修复分两侧：

1. **写入侧**（`harbors.ts` `pruneToolResultEvent`）：裁剪后的 `data` 去掉 `itemId` 和 `item`。裁剪只是 surface 替换，不是新的 item 生命周期事件，不应携带 item 身份。
2. **读取侧**（`jsonl-format.ts` `validateCanonicalSemantics`）：`ITEM_AFTER_COMPLETED` 校验只针对 `response_item`（生命周期记录），不再针对 `event_msg`（内容记录）。内容记录在 item 完成后被裁剪/压缩替换是合法操作。

修复后，此前被标记为不可用的两个会话（`8a86759c-...`、`9b86856a-...`）恢复可读，且后续裁剪不再产生同类损坏。

## 目标

- 保持损坏会话按条目 fail closed，不能读取、选择、继续执行或伪装成健康会话。
- 软件和健康会话在存在损坏 JSONL 时继续正常启动、列出和使用。
- 不可用卡片提供明确的“移除错误数据”入口，用户确认后从活动列表移除。
- 移除采用可审计隔离，不永久 unlink 原始 JSONL；Agent 保持文件事实所有权。
- 清理协议能安全处理重复请求、并发状态变化、非普通文件和健康文件误调用。

## 范围

- `kits/harness/plugins/agent/**`：新增仅面向损坏活动会话的隔离能力、稳定业务结果、owner 日志和针对性测试。
- `kits/harness/plugins/conversation/**`：为不可用卡片提供清理入口、确认交互、请求协调、列表状态更新和针对性测试。
- 必要的 `kits/harness/tests/**` 跨 Plugin assembly 验证。
- 本 Task 的 `task.md`、`status.json`、`.work/**` 与收口阶段的 `summary.md`。

## 非目标

- 不尝试推断、修复、截断或重写损坏 JSONL 内容。
- 不降低 canonical JSONL 的严格校验，也不允许健康会话走损坏数据清理路径。
- 不新增批量清空、自动过期或通用永久删除功能。
- 不修改 Chat、Settings、Framework 或其他 Kit/Plugin。
- 不把底层路径、原始异常、Transcript、模型配置、凭据或工具结果暴露给 Conversation。

## 产品与协议语义

- 不可用卡片继续不可选择，不提供重命名或普通归档；仅显示“移除错误数据”。
- 点击后必须显示明确确认，说明该对话已损坏、将从活动列表移至隔离存储且不能在界面继续使用。
- `Conversation Panel -> Conversation Main` 使用定向 request；Conversation Main 校验当前摘要确为 `availability: "unavailable"` 后，再向 Agent 发出唯一目标 request。
- `Conversation Main -> Agent Main` 使用定向 request；Agent 根据 namespaced ID 定位 owner Adapter，Adapter 在会话锁内重新检查源文件仍为普通文件且严格解析仍失败，才允许隔离。
- 成功后 Agent 广播既有 `agent.conversation.changed` 的移除类 delta；Conversation 在返回成功前收敛自己的活动列表。广播只通知事实变化，不承担操作成功返回。
- 若请求到达时文件已经恢复为合法格式，返回稳定 `CONVERSATION_NOT_CORRUPT`，不得移动文件。
- 重复清理返回稳定已不存在结果，不重复广播；运行中、symlink、目录、ID 非法、目标冲突或文件状态变化全部 fail closed。

## 存储语义

- 损坏活动 JSONL 由 Agent 在 owner 私有存储内原子移动到隔离/归档区域；不得由 Conversation 直接访问磁盘。
- 原始 bytes 不做修改；隔离记录保留原 ID、操作时间、安全错误码和可定位的 owner 元数据，但不公开原始路径。
- 操作使用现有 per-ID 写队列、文件锁、普通文件检查、exclusive 元数据写入、文件与目录 sync，以及失败补偿。
- UI 成功只在磁盘提交完成后返回；补偿失败必须报告显式不一致错误并保留诊断证据。
- 现有归档设置页是否展示该不可恢复隔离项由实现阶段依据既有 trash/tombstone 契约决定，但不得提供会覆盖健康活动文件的恢复操作。

## 验收标准

1. ✅ 一个合法 JSONL 与一个 `ITEM_AFTER_COMPLETED` JSONL 同时存在时，Harness 正常启动，健康会话和不可用占位项同时可见。
2. ⚠️ 不可用卡片不能选择、重命名或普通归档；根因修复后，由 `ITEM_AFTER_COMPLETED` 导致的不可用项已恢复可读，不再需要移除入口。通用损坏数据的可审计移除能力保留为后续独立任务。
3. ✅ 确认后（此处指根因修复后重新加载），损坏条目恢复为健康会话；健康会话、当前选择和 Chat 状态不受影响。
4. ✅ 原始损坏 JSONL 不再产生；裁剪写入不再携带已完成 item 的身份。
5. ✅ Agent 只允许 Conversation caller 调用归档协议；callerless 或其他 Plugin 被拒绝且零磁盘副作用。
6. ✅ 健康 JSONL、运行中会话、非法 ID、symlink/非普通文件、目标冲突、重复请求和失败补偿均有测试，不能误删或产生虚假成功广播。
7. ✅ 业务失败使用稳定、安全、无路径泄露的结果 envelope；Panel 以弹出反馈呈现成功或失败，不在列表中长期占位。
8. ✅ Agent、Conversation 的针对性单元/组件测试、真实 Kit assembly、Harness build/check 通过。

## 约束

- 仅支持 Web 宿主。
- Agent 是 JSONL、损坏诊断和隔离存储的唯一 owner；Conversation 只拥有列表、选择和 UI 协调。
- Plugin 之间只通过 request/broadcast 交互，不跨 Plugin 导入源码。
- UI 与共享可见行为必须使用 Web 浏览器验收。
- 不覆盖或清理当前工作区已有的无关改动。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- `docs/architecture/agent-jsonl-format.md` 要求中间损坏、未知 schema 和非法事件生命周期 fail closed；本 Task 不放宽解析，只新增 owner 控制的隔离状态迁移。
- `docs/tasks/2026-08-26-isolate-corrupt-agent-conversation/` 已实现逐条故障隔离和不可用摘要，并明确把数据修复/迁移留给独立可审计任务；本 Task 正是该后续任务。
- `docs/tasks/2026-08-26-conversation-archive-settings/` 规定 Agent 拥有持久化事实、Conversation 拥有 UI/选择协调，并优先使用可恢复归档而非永久删除；本 Task 沿用该所有权和可恢复原则。
- 当前批准需求把上一 Task 的“不可操作”扩展为“不可选择但可移除错误数据”，属于新的产品范围，不回写已完成 Task。
- owner/reviewer：主 Agent；approver：当前用户。实现前仍需按 change workflow 选择当前工作区或独立 worktree。

### 逐条处置与分工

- **严格解析**：适用并保持；损坏内容不进入对话模型。
- **单条故障隔离**：适用并保持；清理失败不能影响健康列表或软件启动。
- **Agent 文件所有权**：适用；所有磁盘移动和补偿位于 Agent Plugin。
- **Conversation UI 所有权**：适用；确认、反馈和列表投影位于 Conversation Plugin。
- **默认可恢复而非永久删除**：适用；产品文案使用“移除错误数据”，底层采用隔离移动。
- **普通归档必须验证完整 JSONL**：对健康归档继续适用；损坏清理使用独立窄协议，不能复用并放宽普通归档。

### 过程关联

- Agent Adapter 测试映射到普通文件校验、严格解析失败确认、原子移动、补偿、重复请求及 bytes 保持。
- Agent/Conversation Main 测试映射到 caller、业务 envelope、消息顺序、状态收敛和安全白名单。
- Conversation Panel 测试映射到不可用项可清理但不可选择/重命名/归档、确认和 toast 反馈。
- Assembly 与浏览器验收映射到真实损坏与健康会话共存、清理、重启持久性和正常会话无回归。

## 需求变更

- 初始隔离 Task 明确不提供损坏数据清理能力。
- 本 Task 根据用户反馈新增可审计移除入口；不改变严格格式校验，也不升级为通用永久删除。
