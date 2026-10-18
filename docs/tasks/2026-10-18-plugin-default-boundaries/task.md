# 2026-10-18-plugin-default-boundaries

Task ID: `2026-10-18-plugin-default-boundaries`
Type: `bug`

## 背景与问题

架构审查发现，Plugin runtime 的默认接口没有完整绑定用户、会话与插件所有权：持久目录只按 Plugin 名称划分，Config 与 Credentials 只按 Kit/Plugin 划分；部分删除和重置接口可影响其他 Plugin；部分查询返回内部可写引用；直接调用与消息调用采用不同的调用者规则。正常使用公开 API 仍可能产生跨用户共享或跨 Plugin 串扰。

用户已授权一起修复这些问题，同步相关设计文档，并将可推广的设计思想提炼到核心设计原则。Framework 只负责通用 User、Session、Plugin 身份、作用域与能力边界，Conversation 等业务对象继续由 Plugin 实现。

## 目标

1. 让 Plugin 正常使用默认接口时自动获得正确的数据作用域与资源所有权，减少依赖作者手动拼路径、过滤身份或记忆清理范围。
2. 补齐文件存储、配置、凭据、资源写操作、查询快照和调用权限之间的一致性。
3. 以实际实现和验证更新正式架构、开发指南及核心原则，记录长期设计取舍与来源。

## 范围

- Framework 的 Plugin runtime/type/path、Session 到 runtime 的身份装配、配置与凭据绑定、Panel/Menu/Message 公共接口及相应测试。
- 受契约变化影响的内置贡献控制器、公开 testing harness，以及必要的 Kit/Plugin 调用方适配；业务适配仍归对应 Kit/Plugin 目录。
- `docs/architecture/`、`docs/guides/`、`docs/decisions/`、`docs/README.md` 和本 Task 正式档案。
- 本 Task `.work/` 内的设计、评审及验证过程材料。

## 非目标

- 不把 Conversation、Project 或具体业务 schema 引入 Framework。
- 不扩展为 OS 权限沙箱、多人协作平台或新的通用数据库平台。
- 不处理前轮已单独识别的 Session 销毁并发问题、SSE 重连同步及浏览器布局权威问题。
- 不修改、迁移或删除用户真实运行数据与 Keychain 凭据；旧数据归属和兼容行为需在设计中明确，测试使用隔离数据。
- 不执行 push、PR 创建、部署或 main 整合。

## 验收标准

1. Plugin 数据路径由 Framework 根据可信身份绑定；同 Plugin、同 User 的预期持久共享和不同 User 隔离具有回归测试，Session 专属数据按 Session 隔离；缺少必要身份时明确失败，不静默回退共享根。
2. Config、Credentials 与持久路径采用明确一致的默认作用域；两个 User 的正常业务使用不会意外覆盖配置或使用对方的私有凭据。显式共享的权限、适用范围和旧数据处理有准确文档与测试。
3. Plugin 可见的删除、重置和清理自动限制在自身 owner；Host-only 全局清理能力不进入普通 Plugin facade；内置贡献控制器的必要委托能力保持可验证。
4. Plugin 查询结果与内部可写状态解耦；修改返回值不能改变内部身份、归属、注册信息或菜单，后续合法更新仍走受控接口。
5. Plugin 业务调用使用一致的可信调用者规则；直接调用与消息调用的适用边界明确，现有必要消费者完成适配，不能旁路声明的调用权限。
6. 按受影响功能边界运行针对性测试；涉及共享可见行为和 Kit 装配时，在隔离数据根的唯一 Web 宿主完成浏览器验收，不调用真实模型或真实凭据。
7. 正式文档准确描述最终 API、默认范围、显式共享、快照与 owner 规则；核心原则提炼可复用不变量，长期决策与 Task 双向关联。
8. `git diff --check`、Task 检查和 ready gate 通过；保留当前已有用户变更，实际 diff 不超出本 Task 声明边界。

## 约束

- 优先最简单的可用方案；复用现有 runtime.paths、配置与凭据能力，不引入无实际需要的抽象。
- 身份从 Server 的 Session owner 与 Plugin 装配获取，客户端业务参数不能指定或覆盖可信身份。
- 插件业务交互遵循 request/broadcast 消息约定，设计中明确触发方、接收方、顺序与终点。
- 只支持 Web host；测试不能访问用户家目录、真实数据库、Keychain 或不稳定上游。
- 当前 main 已有 Conversation knowledge-base 与 tool-error-reporting Task 文档变更；不覆盖、不 stash、不 reset、不纳入本 Task。
- `status.json` 只通过 Task CLI 修改；进入设计前按仓库工作流取得 current/worktree 的明确选择。

## 需求变更

本 Task 未发生需求变更。

## 决策上下文与处置

### Decision Context

- 2026-10-18 已检索正式 decision memory，查询词覆盖 Plugin runtime、User、Session、存储、配置、凭据、owner、快照与消息调用；返回无命中，fresh，failed_files=0。该结果不替代仓库约束。
- 仓库扫描覆盖 `docs/decisions/0001-plugin-first-architecture.md`、`0002-web-only-host.md`、`docs/architecture/core-principles.md`、`plugin-runtime-model.md`、`kit-and-session-model.md`、`kit-configuration-model.md`、Plugin 开发指南和测试指南，以及对应 Plugin/Server 实现入口。
- 已接受约束：Plugin 优先、Framework 不认识产品概念；Session 运行态隔离；受限 runtime；按 owner 清理；仅 Web host；按功能边界验证。
- 前轮只读 sub-agent 确认资源 owner 与可写查询引用存在缺陷并完成纯内存复现；配置/凭据默认共享和双调用入口需要统一设计。角色反馈提供证据，用户本轮已授权修复及文档原则更新。
- owner：主 Agent，来源为当前任务委托，负责需求、状态、环境、接口一致性与验收。
- reviewer：后续执行计划中分配的独立评审 sub-agent，负责方案、实际 diff 和验证边界；具体分工在环境选定后记录。
- approver：当前用户，负责本次修复范围与设计方向批准，以及后续单独的交付选择。

### 逐条处置与分工

- **适用**：ADR 0001 的业务与 Framework 分层、Plugin 贡献及 owner 清理；修复保持通用身份和能力边界。
- **适用**：ADR 0002 的 Web-only、统一 data root 和测试隔离；不触碰真实数据。
- **需新增**：默认接口绑定身份/作用域、扩大共享显式化、写操作绑定 owner、读取快照与调用权限一致性；按用户本轮授权形成具体可评审设计并同步正式文档。
- **需明确**：现有 global 配置、凭据 scope 和 callPlugin 的历史语义如何被新契约替代；不通过静默改写旧 ADR 消除差异。
- **角色反馈**：前轮 sub-agent 的只读审查是实现证据，不独立批准业务共享或迁移策略。

### 过程关联

- 可信 User/Session 装配 → 默认路径/Config/Credentials 绑定 → 双 User、双 Session 隔离测试。
- Owner facade → Panel/Menu/Message 清理与 Host-only 接口 → 双 Plugin 回归测试。
- 查询 API → 独立快照 → 修改返回值不影响内部状态的回归测试。
- 调用入口 → 可信 caller/权限及消费者适配 → Plugin runtime、真实 Kit assembly 和 Web 验收。
- 最终 API 与不变量 → architecture/guide/core-principles、必要 ADR → Task summary 和反向检索。


## 工作环境与执行分工

- 用户在需求定义后选择创建独立 worktree；2026-10-18 使用仓库 start-change.sh worktree 入口建立 `bug/plugin-default-boundaries`。
- 基线为本地 main `a5338e5065fae42492c1284539e937ad549f895e`，工作区为 `.worktrees/bug-plugin-default-boundaries`；只将本 Task 两份新档案带入，原工作区已有变更保持原位。
- design 的 plan 由独立只读 Agent 提出，review 由前轮审查 Agent 独立执行并通过；补充 Kit 查询和每位 lifecycle.attach 接收者的控制面快照，关闭对 ACL 元数据的可写引用。
- Runtime worker 独占 Plugin package、Panel/Menu/Message 公共面及其测试；Server worker 独占身份装配、Config/Credentials、Kit、Application 与测试 harness；文档 worker 独占正式架构、指南和 ADR。
- 主 Agent 负责 Kit 必要消费者、集成/浏览器验收、实际 diff 复核、Task 状态和总结，用户继续作为 approver。

## 正式设计落点

本轮已授权方向与最终验证分别记录在 [ADR 0005](../../decisions/0005-plugin-default-boundaries.md)、
[核心设计原则](../../architecture/core-principles.md) 和 [实现总结](./summary.md)。
默认 API 的具体当前行为以 [Plugin 运行时模型](../../architecture/plugin-runtime-model.md) 为正式投影。
