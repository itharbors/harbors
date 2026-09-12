# 2026-09-11-user-delete-legacy-device

Task ID: `2026-09-11-user-delete-legacy-device`
Type: `bug`

## 背景与问题

本地主机管理员在用户选择页删除由旧授权设备迁移出的兼容用户时，Server 因该用户仍绑定授权设备而返回 `409 USER_IN_USE`。这类用户本身由设备迁移产生，导致管理员即使经过删除确认也无法在用户入口完成清理。

## 目标

允许本地主机管理员在用户删除确认后删除这类设备用户，并同步撤销该用户关联的授权设备；有关联 Session 的用户仍不得删除。移除已经完成使命的自动迁移、旧存储 fallback 和无生产消费者的兼容代码，使被删除的数据不会再从旧源复活，并收敛当前运行时只使用现行数据模型与接口。

进一步收敛为单一现行身份模型：AuthorizedDevice 必须属于 User，Session 必须属于 User；不再创建、列举、认领或展示 ownerless Session，不再运行 Device/User、Config Storage、legacy JSONL 或 legacy turn 的历史兼容迁移。删除无生产消费者的 canonical JSONL 手工 exporter，并按用户明确授权清理当前主库中的 65 条 ownerless Session。

## 范围

- `packages/server`：调整工作台用户删除接口及对应测试，使删除无 Session 的用户时同步撤销其授权设备和待授权请求。
- `packages/client`：使删除失败提示与实际阻塞条件一致，并更新对应组件测试。
- `packages/kit-core`、`packages/plugin`、`kits/harness`、相关 `scripts` 与现行 architecture/guide：删除审计确认的迁移/兼容 contract，并同步正式文档和验证。
- 移除 Server 启动时的跨目录 Application Data Migration、legacy source 配置、三个启动入口接线及对应测试；保留 `~/.harbors` 稳定数据根解析，fresh schema 直接声明现行字段，不再运行旧列 backfill。
- 移除 `agent-chat -> harness` 的 `legacyKitIds` 配置/凭据迁移及 Kit schema/runtime 接线。
- 移除 Framework/Kit/Plugin 的 `legacyDataDirectories`、`legacyPluginDataDirectories` 公共兼容契约与透传实现。
- 移除 Harness Agent 的无 Context Store `storage-v1`/旧 JSONL fallback、自动导入、v0 写时升级、canonical JSONL 手工导出及对应冗余测试。
- 移除审计确认无生产消费者的兼容代码：Kit Picker 字符串 overload、`PanelInstanceSnapshot` deprecated alias、Model Service 字符串 cancel、Context Store 无消费者目录与 facade、只写不读的 delete operation journal、Chat surface-only 旧会话展示兼容、旧 clean 目录和孤立迁移指南。
- `docs/tasks/2026-09-11-user-delete-legacy-device/**`：记录需求、状态、验证与收口事实。
- `packages/server`、`packages/plugin-types`、`packages/client`：删除 ownerless Session contract/UI/claim 链路，将 Session 创建统一到 Workbench 的显式 User 入口；`/api/session` 只初始化已存在且可访问的 Session。
- `packages/server`：删除 `DeviceStore.migrateLegacyDevices`、Config Storage 旧表复制和对应迁移测试；fresh schema 直接声明现行字段。
- `kits/harness/plugins/agent`、`agent-context-store` 与正式文档：删除 legacy JSONL codec、canonical JSONL exporter、`legacy-turn-*` fallback 和只为这些能力存在的测试/文档。
- `packages/plugin`：要求 manifest 显式声明 `schemaVersion`，删除缺省 v1 兼容。
- 当前主库：先做可恢复备份，再删除精确匹配 `ownerUserId IS NULL` 的 65 条 Session；不操作已有归属 Session。

## 非目标

- 不删除或重新归属任何已有归属 Session；仅按用户授权删除精确匹配的 65 条 ownerless Session。
- 不改变远程设备申请、审批或身份切换规则。
- 不删除项目 `.data`、`.editor.db`、Plugin legacy root 或旧 JSONL；只按 2026-09-12 用户授权，在备份后删除当前主库中 65 条 `ownerUserId IS NULL` 的 Session。
- 不删除现行 `userId`/`ownerUserId` 身份字段；删除旧列 backfill 与 Config Storage 旧表复制，当前 schema 不兼容时明确失败而非迁移。
- 不删除 Context Store 的初始化 lock/journal、version pointer、epoch fencing、Conversation tombstone 或 `surface-v1` Context 诊断模式；canonical JSONL 手工导出已被用户明确纳入删除范围。
- 不删除当前 Message route 数组格式；Plugin manifest 的 schemaVersion 缺省已被用户明确纳入删除范围，所有现用 manifest 改为显式声明。
- 不处理页面样式或与迁移/兼容清理无关的重构。

## 验收标准

1. 本地主机管理员可以删除没有关联 Session、但仍有关联授权设备或待授权请求的用户。
2. 删除成功后，该用户、关联授权设备和待授权请求均不可再读取；设备后续访问回到未授权状态。
3. 有关联 Session 的用户仍返回冲突，且用户、设备、待授权请求和 Session 均保持不变。
4. 非本地管理员仍不能调用用户删除接口。
5. 用户界面的失败提示只说明仍会阻止删除的关联 Session，并通过目标 Client/Server 测试及 Web 浏览器验收。
6. 默认 `pnpm start`、`pnpm dev` 和 Web Host runner 均不再扫描或导入项目内 legacy DB/Plugin data；删除当前 User/Device 后重启不会从旧源恢复。
7. Harness 正式与测试装配只使用必需的 Context Store，不再具有 `storage-v1`、旧 JSONL 自动导入或无 Store fallback。
8. Kit/Plugin/Server runtime 不再暴露 legacy data directory contract；Harness 不再声明 `legacyKitIds`，配置和凭据不再从 `agent-chat` 复制。
9. 审计确认无生产消费者的兼容分支、目录和 facade 被删除，相关现行行为测试继续通过。
10. Framework、Kit Core、Plugin、Client 与 Harness 的边界、目标测试、构建和 Web 验收通过，实际 diff 不覆盖用户已有改动。
11. fresh Device/Session/Config schema 直接使用现行字段；启动不再执行 legacy device、ownerless Session 或旧 Config 表数据迁移。
12. 生产代码无法再创建 `ownerUserId = NULL` 的 Session；Workbench context、公共协议和 UI 中不存在 ownerless/claim/“恢复旧 Session”。
13. 当前主库 ownerless Session 从 65 精确变为 0，已有归属 Session 数量与 ID 保持不变；备份文件可用于恢复。
14. legacy JSONL codec、canonical exporter、legacy turn fallback 和 Plugin schemaVersion 缺省兼容无生产残留。

## 约束

- 遵守 Web-only 宿主边界，不加入 Electron 或桌面生命周期假设。
- 删除必须在现有 Auth/Workbench 存储边界内直接实现，不引入新的抽象或数据模型。
- 用户已明确选择删除上述迁移和兼容能力；不再承诺从 2026-08-25 以前的项目内数据根直升，也不再承诺仓库外 Kit 使用 legacy data directory contract 或 `agent-chat` Kit ID 自动恢复。
- 保留当前工作区已有改动；执行环境确定后只修改本 Task 声明的允许路径。
- `status.json` 只通过 Task CLI 修改。

## 需求变更

2026-09-11：只读审计确认设备用户会因 Server 每次启动重新导入 `.data/harbors.db` 而复活。用户要求启动 subagent 盘点全部迁移代码，随后明确要求“都删掉”。Task 因此从单一删除接口缺陷扩展为跨 Framework、Kit、Plugin 的迁移与兼容清理；明确保留仍服务当前 schema、初始化恢复、删除防复活和现用 manifest/message 格式的机制。

2026-09-12：用户在页面发现“恢复旧 Session”，要求再次启动 subagent 进行代码洁癖审计，并明确“全部执行”。三个只读审计确认仍有 DeviceStore 启动迁移、ownerless Session 全链、Config Storage 旧表迁移、legacy JSONL/exporter、legacy turn fallback 和 Plugin schemaVersion 缺省兼容。用户的“全部执行”同时确认删除这些代码以及当前主库 65 条 ownerless Session；保留现行崩溃恢复、安全 tombstone、Credential Vault recovery 和 Kit runtime compatibility。

## 数据清理记录

- 执行前确认 48381 无监听进程，主库及 WAL/SHM 无进程持有。
- 主库执行前 `quick_check=ok`、ownerless=65、owned=2；已有归属 Session 为 `656c16b3-f032-49ce-9fce-0291a5055c4a` 与 `ca8c84fc-72a5-460c-affe-49fbe5e62303`，owner 均为 `legacy-device-f63be984-c885-4318-ad3f-7cc71ffbe6b0`。
- 一致性单文件备份：`~/.harbors/backups/harbors-pre-ownerless-cleanup-20260912T153413+0800.db`；备份 `quick_check=ok`，计数和已有归属 Session 与清理前主库一致。
- 在单个 `BEGIN IMMEDIATE` 事务中重新断言上述计数与 ID，只删除 `ownerUserId IS NULL`；`changes()=65`。提交前再次断言 ownerless=0、owned=2 且已有归属 Session 不变。
- 提交后主库 `quick_check=ok`、ownerless=0、owned=2，已有归属 Session ID 与 owner 未变。
- 独立审查发现旧表的 `ownerUserId`/`userId` 物理列仍为 nullable。再次生成一致性单文件备份 `~/.harbors/backups/harbors-pre-current-schema-20260912T155000+0800.db`，其 `quick_check=ok`、Session=2、AuthorizedDevice=7 且无 NULL owner。
- 在单个 `BEGIN IMMEDIATE` 事务中复制并逐行双向比对两张表，随后以当前 DDL 重建 `sessions` 与 `authorized_devices`；提交后 `ownerUserId.notnull=1`、`userId.notnull=1`，Session=2、AuthorizedDevice=7、内容与重建前一致，`quick_check=ok`。这是一轮离线数据整理，不在产品代码中保留迁移路径。

## 决策上下文与处置

### Decision Context

- 检索时间：2026-09-11。
- 检索意图：用户删除、授权设备、兼容用户、Session owner、Web 工作台权限边界。
- 仓库扫描：`docs/decisions`、`docs/architecture`、`docs/guides`、相关 `docs/tasks`、`packages/client` 与 `packages/server`。
- 适用来源：
  - `docs/architecture/kit-and-session-model.md`：User 与 AuthorizedDevice、Session 的关系；撤销设备不应删除 Session；本地主机管理员负责用户与未分配 Session 管理。
  - `docs/architecture/system-overview.md`：Server 是 User、授权设备和 Session owner 关系的权威；匿名设备不能读取工作台上下文。
  - `docs/guides/testing.md`：Server 行为运行针对性测试，Client 可见行为使用 Web 浏览器验收。
  - `docs/decisions/0004-automated-development-workflow.md`：Task、环境选择、独立审查、验证与交付授权边界。
- 已批准决策记忆查询未命中，索引状态为 `partial` 且 `failed_files=14`，不能证明不存在约束；因此以仓库 Task、架构、Git 历史、当前实现和用户本轮明确决定为准。
- 三个只读 subagent 分别审计 Server、Harness/Plugin 与全仓脚本，区分一次性数据搬迁、原地 schema upgrade、运行时兼容 API 和初始化恢复协议。
- 检索质量：仓库内直接调用链与历史已覆盖；仓库外 Kit 是否仍消费 legacy path 无法证明，但用户已明确接受删除该兼容承诺。
- 角色来源与负责范围：owner 为当前主 Agent，负责需求、状态、实现编排和验证；reviewer 为执行计划中的独立 sub-agent，负责计划与 diff 审查；approver 为用户，负责环境、长期决策和交付路径门禁。

### 逐条处置与分工

- User/Session owner 边界：适用。删除仍以“无关联 Session”为硬条件，由 owner 实现、reviewer 检查、用户验收。
- AuthorizedDevice 生命周期：适用。删除用户时只撤销关联设备授权，不触碰 Session 数据；由 Server 实现和集成测试证明。
- 本地管理员权限：适用。保持现有 `local-admin` 检查，不扩大远程调用权限。
- 新 ADR：不适用。本次是现有用户清理行为的缺陷修复，不引入长期架构取舍。
- Application Data Migration：删除。原 Task 的一次性搬迁已完成，继续在每次启动扫描旧源会使已删除记录复活。
- Agent JSONL/storage-v1 fallback：删除。正式 Harness 已强制使用 Context Store，旧分支没有生产入口。
- `legacyKitIds` 与 legacy data directory contract：删除。用户明确结束旧 Kit 身份和仓库外 legacy storage 兼容承诺。
- Device/Session/Config 的旧 schema upgrade/backfill：删除，fresh schema 直接完整声明；Context Store 初始化/恢复与 tombstone 保留，它们保护当前崩溃恢复和删除语义。
- 角色反馈：用户指出选中的兼容设备用户“删不掉”，作为缺陷证据；不直接升级为长期决策。

### 过程关联

- Server 路由和 Auth store 变更映射到删除成功、残留关系清理、Session 阻塞与权限集成测试。
- Client 文案变更映射到组件测试和浏览器实际删除流程。
- 实现允许范围以第二次审计后的 `.work/plan-v3.md` 所列 Server、Client、Kit Core、Plugin、Harness、manifest、现行 architecture/guide 与本 Task 路径为准；若需要越过这些路径，将回到 requirements 重新确认范围。
