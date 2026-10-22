# 2026-10-22-agent-turn-durability

Task ID: `2026-10-22-agent-turn-durability`
Type: `bug`

## 背景与问题

本 Task 首次启动时，Context Store 文档核对发现两项 P1 缺口：流式 delta 在持久化排队后立即广播；Stop 等待内存 completion 或超时后仍返回 true，不能证明取消终态已持久化。前轮已在 Agent Plugin 修复并保存验证证据。随后用户指出真实页面仍整片输出，本轮重开并补齐 Chat 展示链路；当前完成条件包括 D9/D10 的真实浏览器验收。

## 目标

让用户看到的流式内容对应已提交事件，并在生成尚未完成时逐段显示正文；让成功停止对应已提交的取消终态。复用现有 Store、串行写队列、Turn 执行对象和消息协议，以最小改动处理持久化失败、完成/取消竞争、晚到事件和 Chat 展示断链。

## 范围

- `kits/harness/plugins/agent/` 内的实现、并置测试及 runtime 测试。
- `kits/harness/plugins/chat/` 内的实时预览、轨迹投影与并置回归测试，补齐用户可见的流式展示。
- 直接关联的 Context Store、Turn 事件正式文档、8/26 原 Task 的目标/现状和本 Task 档案；业务源码只在 Agent、Chat 两个明确授权的 Plugin 内修改。
- 核对与 Turn 收口相关的工具副作用和 approval 顺序；确定的同 Plugin 缺口按相同持久化原则补齐。
- 独立实现、独立审查和主 Agent 最终验收；Task 机器状态仅由主 Agent 通过 CLI 管理。

## 非目标

- 不实现通用备份恢复、operation journal、对象校验、JSONL 导入导出或跨 Session 实时同步。
- 不更改 Framework、Store、Model Service 等其他 Plugin 的源码及对外协议。
- 不更改 Context 选择算法、Q30 评分或原始评测数据；严格 Q30 的模型补跑不是本可靠性修复的完成条件，原门禁继续保留。
- 不读取或迁移真实用户数据、操作 Keychain、修改真实模型配置；验证使用隔离数据与测试上游。
- 本次用户已授权将已处理代码保存为一个本地 commit；不推送、创建 PR、整合 main 或清理已有改动。

## 验收标准

1. **D1 流式顺序**：对应事件提交成功、trace 通知后才发送 delta；completed/step/end/turn/end 不越过已接收事件队列。
2. **D2 写失败**：首个持久化失败关闭当前 generation 并取消上游；失败项、后续项与晚到回调不再广播成功，错误不被 Provider 异常或 finally completion 掩盖。
3. **D3 唯一终态**：完成、失败和取消通过唯一收口路径确定终态；等待队列后至多提交一个 turn/end，成功/失败结果均可被等待者观察，避免悬空 Promise 或未处理 rejection。
4. **D4 Stop 语义**：保留 Promise<boolean>。无 active Turn 返回 false；只有 durable cancelled terminal 后返回 true；超时或终态持久化失败走 rejection，不广播稳定“已停止”。重复 Stop 共享同一 Turn 的收口结果。
5. **D5 竞争与副作用**：context/model/tool/approval/append 边界检查取消；Stop 后晚到 delta、result 和审批响应不产生第二终态或重复执行 mutation 工具。同步 Store 只在调用边界检查，不虚构可中断 API。
6. **D6 审批和工具**：call/started 成功后才执行工具；副作用发生后 result 写失败不自动重跑；approval asked 持久化后才开放，resolved 持久化后才执行，重复或过期响应不得再次执行。
7. **D7 验证**：针对延迟写、写失败、上游不响应、终态写失败、完成/Stop 竞争、重复 Stop、晚到事件及审批失败进行必要的自动化回归；验证实际 request/broadcast 顺序。共享可见行为在隔离 Web 宿主中验收，记录入口和可见结果。
8. **D8 文档与边界**：将实际修复、验证证据及剩余缺口同步到相关文档，保护原始 P100/Q30 JSON 与无关改动；不将本 Task 通过外推为原 Context Store Task 全部完成。
9. **D9 真实可见流式**：同一回答在模型请求仍未完成时，正文至少经过两个可观察的递增前缀；第三段/终态暂不放行时，页面仍显示已有前缀且保持运行状态。不得用最终全文、收到 delta、单元测试或动画打字效果替代此浏览器验收。
10. **D10 预览与最终态**：同一 Item 的实时预览与 completed 快照衔接后只有一份回答；取消/失败时未完成前缀不能被标成成功最终回答。刷新、切换会话后，不串内容、不重复、不丢已提交最终回答；新会话、继续旧会话和切入进行中的会话均有针对性覆盖。

## 约束

- 保持实现简单，不建立通用事务协调器、独立 journal 或新 ACL，不改变同步 Store API、delta 回调与 broadcast 协议。
- 仅支持 Web；遵守 Plugin 单元边界、既有 request/callers 授权和可信身份。
- 消息链：Chat request Agent → Agent 同步调用 Store → Agent request Model Service → Store 提交/trace → Agent broadcast delta 给 Chat；Stop 通过 Agent 等待持久化收口后响应。
- 保留当前未提交的文档和 Task 档案，不 stash、reset 或删除；执行环境须在需求定义后明确记录。
- 实现者与独立审查者分离；主 Agent 对照实际 diff、故障测试及浏览器证据裁定。

## 需求变更

- 2026-10-22 用户指出右侧实际回答整片出现，并要求“补全，不要将没有做完的功能当做完成交付”。只读复现确认 Chat 虽收到 delta 并更新 messages，Transcript 却仅取完整 assistant/message，忽略增量正文。
- 因此重开本 Task，明确授权 Chat Plugin 展示修复，增加 D9/D10；前轮完成声明仅保留为后端可靠性证据，不再代表用户可见流式已完成。此前浏览器只检查完成后的全文与终态，未覆盖生成中正文增长，本轮必须补齐。
- 2026-10-22 用户要求“把已经处理的那个代码提交一下，提交一个 commit”。本次保存已审查的 Agent/Chat 代码、测试、Turn 事件协议、测试指南及本 Task 三份正式文件；此前未提交的设计草稿和评测材料不纳入。浏览器独立复验仍 blocked，本地提交不改变验收状态。

## 决策上下文与处置

- 正式决策记忆检索：当前仓库已识别；以 Agent、流式持久化、Stop、同步 callPlugin 与 callers 查询，无命中，fresh、failed_files=0。无命中不代表仓库没有决策。
- 已有约束：[ADR 0005](../../decisions/0005-plugin-default-boundaries.md)、[核心原则](../../architecture/core-principles.md)；另参考本机未提交的历史材料 `docs/tasks/2026-08-26-conversation-knowledge-base/design/agent-plugin-integration.md`。沿用已有边界，不新增 accepted ADR。
- 来源：[原 Context Store Task](../2026-08-26-conversation-knowledge-base/task.md) 与本机未提交的文档核对记录 `docs/tasks/2026-10-22-context-store-design-reconciliation/summary.md`。
- 用户为需求发起人与 approver；主 Agent 负责需求、环境、状态及裁定；执行计划确认后指定实现与独立审查子 Agent。
- 初次启动时目标源码没有未提交改动；前轮 Agent 变更和已有文档均已保存内容快照，本轮按允许范围增量更新并保护既有改动。
- 本轮 Chat 增量实现前查询正式决策记忆（Chat、流式、增量、transcript、canonical、item delta）：无命中，fresh、failed_files=0；沿用现有 Item 生命周期与可信 Plugin 边界，不新增 accepted ADR。

## 执行环境与角色

- 用户明确选择独立 worktree；按仓库启动入口创建后，分支使用 `codex/bug-agent-turn-durability`。
- 工作区：`/Users/bytedance/Project/harbors/.worktrees/bug-agent-turn-durability`，基于本地 main `ae2f31f831c1d4a38ce3a33c4bd1690e733a707f`；dirty policy 为 preserve。
- 当前 Task 已迁入 worktree；18 份相关未提交文档/档案复制作为基线，主工作区原文件逐份核对哈希不变。快照和环境事实保存在本 Task `.work/`。
- 实现及计划：`implement_turn_durability`；独立计划与代码审查另由只读 Agent 承担；主 Agent 负责状态、文档同步、最终验证与裁定。
- Chat 补全继续使用同一已授权 worktree；前轮源码、正式文档与证据已快照在 `.work/before-chat-stream/`，Agent 八文件保持冻结。主工作区 49380 服务及真实用户数据保持隔离，不用它运行测试上游。Chat 实现与独立审查继续分离，主 Agent 负责 D9/D10 的真实 Web 验收。
