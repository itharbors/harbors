# 稳定 Application Data Root 并恢复 Harness 会话

Task ID: `2026-08-25-stabilize-application-data-root`
Type: `bug`

## 背景与问题

Harbors 当前存在多处彼此割裂的运行数据：正式启动的 Server 数据库默认位于项目根目录的 `.data/harbors.db`，开发 Server 另将数据库写入 `packages/server/.editor.db`；开发启动会把 Plugin 的 `data/cache/temp` 根推导到 `packages/server/plugins/**`；Harness Agent 改名后没有导入仍位于 `~/.harbors/pi-agent/sessions` 的旧会话。这会让运行数据混入源码或随 checkout/worktree 改变，并使已有 Server session 或 Agent 对话在切换入口后不可见。

当前机器只读盘点确认：项目 `.data/harbors.db` 包含 8 条设备授权、1 条 credential profile 和 11 条 Server session；`packages/server/.editor.db` 另含 52 条 Server session，两个 legacy DB 的 session ID 没有重叠；`packages/server/plugins/**` 已生成 owner 哈希目录但当前无文件；旧 Agent 目录存在 4 个有效 active JSONL，当前 Harness Agent 的新 sessions 目录为空。

## 目标

1. 将 Web 宿主的稳定 application data root 统一为用户目录下的 `~/.harbors`，开发与生产入口使用同一解析规则，不再依赖源码路径或 `process.cwd()`。
2. 将现有项目 `.data/harbors.db` 与 `packages/server/.editor.db` 非破坏地合并迁移到稳定 application data root，并保持设备授权、credential profile 和 Server session 可见。
3. 将 Plugin 的 owner 私有 `data/cache/temp` 目录统一置于稳定 application data root，停止在 `packages/server/plugins/**` 生成运行目录，并兼容导入可能存在的旧项目内 Plugin data。
4. 将 `~/.harbors/pi-agent/sessions` 中的有效 active 会话导入 Harness Agent 当前私有存储，使旧对话重新可见。
5. 更新与 `.data/` 旧行为冲突的正式架构说明和 ADR，使文档反映新的稳定数据根。

## 范围

- Web Server 正式启动和开发启动的 application data root、数据库路径与 Plugin path roots 解析。
- Server 数据库从项目 `.data/harbors.db`、`packages/server/.editor.db` 到 `~/.harbors` 稳定位置的合并迁移与回归测试。
- Plugin owner 私有 `data/cache/temp` 根的稳定化、旧项目内 data 发现及必要迁移、owner 可诊断信息和回归测试。
- Kit repository storage/runtime 的 owner-scoped legacy data grant，以及 `kits/harness/plugins/agent/**` 的 legacy session 导入逻辑和测试。
- 相关 Framework、Plugin runtime、Harness Kit、启动/迁移测试和 Web 浏览器验收。
- `docs/decisions/0002-web-only-host.md`、相关架构/指南以及本 Task 三份正式档案。

## 非目标

- 不删除项目 `.data/harbors.db`、`packages/server/.editor.db`、`packages/server/plugins/**` 或 `~/.harbors/pi-agent/sessions` 中的源数据；清理由后续显式维护动作决定。
- 不导入 Agent legacy trash，不恢复旧 `agent-chat` URL、Kit ID 或其他兼容入口。
- 不改变 Agent JSONL 业务格式、对话消息协议、Provider streaming 或工具执行语义。
- 不在本 Task 中引入未经确认的 project identity、按 Git 项目隔离的 `projectData`，或重新设计 Plugin 文件读写 API；现有 `ctx.paths.data/cache/temp/legacyData` 继续作为 Plugin 的正式宿主注入能力，本 Task 只补齐 Kit 装配层对 owner-scoped legacy directory 的最小授权声明。
- 不引入 Electron、桌面打包、原生窗口生命周期或其他非 Web 宿主假设。
- 不 push、不创建 PR、不自动整合到本地 `main`。

## 验收标准

1. 所有正式 Web 启动入口和 `pnpm dev` 使用同一个可测试的 resolver，将 application data、Server 数据库、Kit config 和 Plugin path roots 放在 `~/.harbors` 下；从不同 cwd、checkout 或 worktree 启动不改变位置。
2. 首次切换时，如果稳定目标数据库不存在而任一 legacy DB 存在，则通过并发安全、原子、幂等流程生成合并数据库；目标已存在或并发进程已先发布时，继续在单一事务中只导入目标缺失的主键。表 schema 必须兼容；已有目标记录永不覆盖；legacy 来源按固定顺序处理，同主键同值计为 skipped、异值计为 conflicted 并保留第一来源；失败保留源文件并给出可诊断错误。
3. 迁移后原有 8 条设备授权、1 条 credential profile 和两个 legacy DB 合计 63 条不重复 Server session 均可读取；两个源数据库仍保留，重复启动不重复覆盖或损坏目标。
4. Plugin runtime 只在 `~/.harbors` 对应的受控根下创建 owner 私有 `data/cache/temp`；从 `packages/server` 或其他 cwd 启动不会在源码树创建这些目录。
5. 对旧项目内 Plugin data 执行安全盘点和兼容迁移：目标同 owner/同相对路径已存在时目标优先；不跟随越界符号链接；失败保留源数据；迁移可重复执行并有日志或结构化诊断。当前仅有空目录时不制造无意义副本。
6. `pi-agent` legacy directory 只注入 Agent Plugin，不暴露给 Harness 的 Conversation、Chat、Settings 等其他 Plugin。Agent importer 只读取 `~/.harbors/pi-agent/sessions` 的 active JSONL；不导入 trash；校验文件名、session ID 和完整 JSONL；目标 `.jsonl` 或 `.deleted` 已存在时目标优先；单文件原子发布，失败不删除源文件且不阻止其他有效文件导入。
7. 当前确认的 4 个有效旧对话在迁移后可由 Harness conversation list 读取，重复启动不会产生重复会话；现有 v0 文件由当前兼容 decoder 读取，不强制原地重写。
8. 迁移过程具有可观测的 discovered/imported/skipped/conflicted/failed 统计；日志不包含 API Key、会话正文或其他敏感数据。
9. Server、Plugin runtime、Harness Agent 的针对性测试通过；Kit assembly、Harness check、Framework/Server 相关测试通过；浏览器确认 Harness 加载正常、旧对话可见且控制台无 error/warning。
10. `git diff --check`、Task 普通检查与 ready gate 通过，实际 diff 不覆盖当前工作区已有的用户 Skill 修改。

## 约束

- Harbors 仅支持 Web 宿主；application data 的物理位置由宿主解析，Framework、Kit 和 Plugin 不自行拼接用户主目录。
- Plugin 继续只使用宿主注入的 owner 私有路径；迁移基础设施可以跨 Framework/Harness 边界，但不得绕过 Plugin owner 隔离。
- 数据迁移必须非破坏、幂等、失败安全；目标数据优先，不覆盖新数据；任何自动清理均不在本 Task 授权范围。
- SQLite 迁移需要覆盖多源 schema 校验、WAL、并发、主键冲突和部分失败风险，不能用未经校验的普通覆盖复制替代一致性迁移。
- 测试使用注入的临时 home/data root，不读取或修改真实用户数据；真实目录只允许只读盘点和最终由正式启动执行的迁移逻辑。
- 保留当前工作区已有的 `.codex/skills/delegate-codex-subagents/**` 用户修改，不 stash、reset、覆盖或纳入本 Task。
- `status.json` 只通过 Task CLI 修改；提交必须符合仓库中文标题规范。

## 需求变更

本 Task 将此前仅讨论的“稳定 Plugin 数据根”和“Agent 会话恢复”合并，并按用户确认补充项目内 Server DB 迁移，统一作为一次跨边界缺陷修复实施。定义后只读盘点又发现开发入口的 `packages/server/.editor.db`，因此 Server DB 范围从单源搬迁修订为两个 legacy DB 的非破坏合并；该调整仍属于用户已批准的“项目内运行数据统一迁到 `.harbors`”。

## 决策上下文与处置

### Decision Context

- 2026-08-25 查询已批准决策记忆，意图为“Framework application data root、home directory、Plugin storage、项目数据库和 legacy Agent session 迁移”；未命中，索引状态为 `partial`，`failed_files=1`。该结果只说明外部正式记忆无法确认，不替代仓库来源或当前用户批准。
- 仓库扫描覆盖 `docs/decisions`、`docs/architecture`、`docs/guides`、Kit 配置 Task、Agent runtime storage Task、Harness 改名 Task及当前启动/Plugin path/Agent storage 实现。
- 命中的已批准约束包括：Web-only 宿主；Kit/Plugin 不解释宿主物理路径；Plugin 使用 owner 私有 `ctx.paths.data/cache/temp/legacyData`；配置 `application-data` 由 Web 宿主映射到 `~/.harbors`；迁移失败应保留旧数据。
- 仓库存在冲突：ADR 0002 和 system/runtime flow 文档仍声明 Server 运行数据写入项目 `.data/`，而较新的 Kit 配置架构已声明正式 Web 入口将 application-data 映射到 `~/.harbors`。用户已明确批准本 Task 将项目内运行数据统一迁到 `.harbors`，本 Task 需要修订旧文档结论。
- 范围变化后重新查询已批准决策记忆，意图为“合并项目 `.editor.db` 与 `.data/harbors.db` 到用户级 application data”；仍未命中，索引状态仍为 `partial`、`failed_files=1`。仓库实现扫描确认两个入口使用不同默认 DB 路径，未发现现成多源迁移契约。
- owner：当前主 Agent，来源为本 Task 编排者，负责需求、设计、实现、状态推进和最终验收。
- reviewer：执行计划中的独立代码/方案审查步骤，负责跨 Framework、Plugin runtime 与 Harness 边界检查；若未使用 sub-agent，则由主 Agent以独立审查清单执行，不改变状态所有权。
- approver：当前用户，来源为需求发起人，负责批准统一迁移到 `~/.harbors` 的范围；该批准不包含删除源数据、push、PR 或本地整合。

### 逐条处置与分工

- **适用**：`docs/architecture/kit-configuration-model.md` 的宿主路径边界。Web 宿主解析 `~/.harbors`，Framework 和业务模块只消费注入后的抽象根或 runtime paths。
- **适用**：`docs/tasks/2026-08-21-agent-runtime-storage` 的 `ctx.paths.data`、`storage-v1`、tombstone 和 trash 语义。本 Task 只补 legacy import 和根路径稳定化，不回退 Agent 自行读取 home 的常态路径。
- **需修订且已获批准**：`docs/decisions/0002-web-only-host.md` 中“Server 数据写入 `.data/`”的旧结论。新结论为用户级稳定 application data root；源码 checkout/worktree 不拥有正式运行数据。
- **当前架构事实**：`.data/harbors.db` 与 `packages/server/.editor.db` 分别保存正式/开发入口的 Server 运行状态，`packages/server/plugins/**` 由不稳定的开发 data root 创建，Agent 新存储为空而旧 home sessions 仍有效。
- **不适用**：Harness 旧入口兼容。改名 Task 已明确不保留旧入口，本 Task 仅迁移数据。
- **需新增**：Kit repository storage 的 owner-scoped legacy data grant。现有 Kit 级 `legacyDataDirectories` 会注入 Kit 全部 Plugin，不能用于 `pi-agent`；本 Task 由 Kit 显式把目录授权给目标 Plugin，并保持 `ctx.paths.legacyData` runtime surface 不变。任意 Plugin 不能仅靠自声明取得其他 legacy 目录。
- **需后续人工确认**：是否增加 `globalData/projectData` 等新的 Plugin storage scope，以及 project identity 如何定义。本 Task 不以未确认方案阻塞当前数据恢复。

### 过程关联

- 稳定 application data resolver → 启动配置与 dev/prod 接线 → cwd/worktree 无关测试和源码目录防回归测试。
- Server DB 合并迁移 → 多源 schema、WAL、原子/并发/目标优先测试 → 设备授权、credential profile、两个来源 session 数据保持验证。
- Plugin root 迁移 → owner 路径与 legacy 迁移测试 → Server/Plugin runtime 定向验证。
- Agent legacy import → JSONL/tombstone/trash/重复执行测试 → Harness assembly 与浏览器对话列表验收。
- 文档冲突修订 → ADR/architecture diff → Task consolidation 的 Decision Delta 与反向检索验证。
- 若设计或实现发现范围变化，将重新查询决策记忆、扫描仓库来源并更新本章节后再继续。
