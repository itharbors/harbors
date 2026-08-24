# 将 Agent Chat Kit 重命名为 Harbors Harness

Task ID: `2026-08-24-rename-agent-chat-harness`
Type: `refactor`

## 背景与问题

现有 `kits/agent-chat` 的产品展示名为 “Agent Chat”，但它已经装配 conversation、chat、model-service、agent、preview、settings、debug、mermaid 等完整 Agent 工作台能力，不只是聊天界面。Kit 作为产品能力装配边界，应使用能够覆盖执行、工具、模型、会话、预览和调试职责的产品名称。

用户已确认产品名称为 **Harbors Harness**。其中 `agent` 是 Kit 内负责 Agent Loop 的 Plugin，职责准确，不随 Kit 改名。

## 目标

1. 将 `agent-chat` Kit 的产品身份统一重命名为 `harness`，展示名统一为 **Harbors Harness**。
2. 将 Kit 目录迁移为 `kits/harness`，同步 descriptor、开发命令、测试和当前正式架构/指南引用。
3. 保持 Kit 的业务行为、Plugin 列表、消息协议和 Web-only 宿主边界不变。
4. 将 `agent-chat` 命名空间下已有的 Kit 配置与 Model Service API Key 凭据幂等迁移到 `harness`，避免静默丢失用户数据。

## 范围

- `kits/agent-chat/**` 到 `kits/harness/**` 的目录迁移及 Kit 内部引用更新。
- Kit descriptor 中的 ID、package name、菜单展示名和产品摘要。
- 当前有效的架构文档、开发指南、测试指南、根级开发脚本或测试中对该 Kit 的机器引用。
- Framework/Server 中声明、解析和执行 Kit 身份迁移所必需的通用 descriptor、配置存储与凭据 Vault 能力及针对性测试。
- 本 Task 的 `task.md`、`status.json` 和收口阶段的 `summary.md`。

## 非目标

- 不重命名 `kits/harness/plugins/agent` 或改变 Agent Loop 实现。
- 不改变 Plugin 间 request/broadcast 协议、Provider streaming、存储格式或业务行为。
- 不改写历史 Task、历史计划、历史总结中作为当时事实存在的 `agent-chat` 名称。
- 不修改 Framework/Kit 的 Web-only 宿主模型，不引入 Electron 或桌面宿主能力。
- 不兼容 `/kits/agent-chat`、`?kit=agent-chat`、旧 CLI 参数、旧 catalog ID 或旧 runtimeKit；旧入口在重命名后直接失效。
- 不迁移浏览器布局缓存；布局恢复默认状态是本次明确接受的行为。
- 不发布、推送、创建 PR 或整合到本地 `main`；这些操作仍需后续单独授权。

## 验收标准

1. 仓库中存在 `kits/harness`，不存在活动目录 `kits/agent-chat`；`kit.json.id` 与 `package.json.name` 均为 `harness`。
2. Kit 菜单及面向用户的产品名称为 **Harbors Harness**。
3. `plugins/agent` 的目录、Plugin 身份和行为保持不变。
4. 内部窗口 ID 从 `agent-chat-main` 改为 `harness-main`；旧浏览器布局缓存无需读取或迁移。
5. `agent-chat` 命名空间下的配置与 Model Service 凭据可被幂等迁移到 `harness`；新命名空间已有值时不得被旧数据覆盖，失败不得删除或破坏旧数据，重复执行结果稳定。
6. 旧 URL、CLI、catalog 与 runtimeKit 标识不提供 alias 或重定向，并有回归测试证明旧入口不再解析为活动 Kit。
7. 当前代码、测试、架构文档和指南不再把活动 Kit 标识写成 `agent-chat`；历史 Task/计划/总结及迁移声明中的 legacy ID 可以保留旧名称。
8. Kit descriptor 校验、配置/凭据迁移测试、Plugin runtime smoke、Kit assembly、Kit build 与 Kit test全部通过。
9. 通过唯一 Web 宿主启动该 Kit，并在浏览器确认 Harbors Harness 可正常进入且核心界面可见。
10. `git diff --check` 通过，实际变更不越过本 Task 声明边界。

## 约束

- 遵循 Kit 独立闭环原则；本次仅因用户明确要求保留配置与 API Key 而扩大到通用 Kit 身份迁移能力，不借机修改其他 Framework 业务行为。
- Plugin 交互继续统一使用既有 request/broadcast 消息；本 Task 不新增或调整消息链路。
- Harbors 仅支持 Web 宿主，浏览器验收是 UI、Kit 装配和共享可见行为的最终验证。
- 保留用户已有改动；不执行 stash、reset、清理、push、发布或整合。
- `status.json` 只通过 Task CLI 更新。
- 迁移机制应由 Kit descriptor 显式声明 legacy Kit ID，Framework 不硬编码 `agent-chat -> harness` 产品映射；迁移只处理配置与凭据，不形成旧入口 alias。

## 决策上下文与处置

### Decision Context

- 2026-08-24 查询已批准决策记忆，检索意图为 “agent Kit 重命名 Harness / Harbors Harness / 产品命名 / Kit 定位”；未命中条目，索引状态为 `partial` 且 `failed_files=1`，因此不能据此证明不存在历史决定。
- 仓库定向扫描覆盖 `docs/decisions`、`docs/architecture`、`docs/guides`、相关 `docs/tasks`、`kits/agent-chat` 及根级机器引用。命中当前架构事实：Kit 决定 Web 工作台具有哪些产品能力；产品专属 Plugin 应闭环位于 Kit 内；Harbors 仅支持 Web 宿主。
- 未发现已接受 ADR 对 “Agent Chat” 产品名形成约束；历史 Task 记录了原始创建背景，作为历史事实保留，不批量改写。
- 用户确认配置与 API Key 必须迁移、旧入口不需要兼容、内部窗口 ID 应同步改为 `harness-main`；同时确认浏览器布局缓存属于可丢弃临时数据。该反馈扩大了 Task 的 Framework/Server 范围，需求阶段已重新检索。
- 扩围后再次查询已批准决策记忆，检索意图为 “Kit ID 重命名、配置 SQLite、credential scope、幂等迁移、旧入口不兼容”；仍未命中，索引状态为 `partial` 且 `failed_files=1`。仓库扫描命中配置存储以 `kit_id` 为主键、凭据 scope 包含 Kit ID、现有 descriptor 只有插件数据目录兼容声明；未发现现成 Kit ID 迁移契约。
- owner：当前主 Agent，来源为本 Task 编排者，负责需求边界、状态和最终验收。
- reviewer：执行计划阶段的独立 sub-agent，负责重命名完整性、兼容性和边界审查。
- approver：当前用户，来源为产品命名决定的提出者与确认者，负责批准长期产品名 **Harbors Harness**。

### 逐条处置与分工

- **适用**：`docs/architecture/kit-and-session-model.md` 的 Kit 产品能力边界；据此将产品级名称落在 Kit，而不把内部 Agent Plugin 一并改名。owner 负责实施映射，reviewer 复核。
- **适用**：仓库 Kit 独立闭环和 Web-only 约束；实现限于目标 Kit、必要机器引用、正式文档与 Task 档案，最终使用浏览器验收。owner 负责范围控制，reviewer 复核。
- **需新增且已人工确认**：产品名称由 “Agent Chat” 改为 **Harbors Harness**，技术标识使用 `harness`。用户在本 Task 启动前明确确认；该反馈是本次需求授权，最终长期落点应进入当前架构/指南，而不是仅留在 Task。
- **需新增且已人工确认**：旧配置与 Model Service API Key 必须迁移；旧 URL/CLI/catalog/runtimeKit 不兼容；窗口 ID 同步改名；布局缓存允许丢弃。owner 负责把这些决定转成非破坏、幂等、通用的 descriptor 迁移契约，reviewer 复核失败与冲突语义。
- **当前架构事实**：配置行由 `kit_id` 隔离，凭据 scope 摘要包含 Kit ID；只改 Kit descriptor 会使旧配置和凭据不可见。现有 `legacyDataDirectories` 仅适用于插件数据目录，不能替代配置与凭据迁移。
- **不适用**：测试 API 中的通用 `createPluginRuntimeHarness`、`createKitAssemblyHarness` 等小写 harness 术语；它们表示测试夹具，不属于产品标识，不做改名。

### 过程关联

- 产品命名决定 → `kits/harness/kit.json`、`kits/harness/package.json` 和当前正式文档。
- Kit 边界与行为不变 → Plugin 列表、协议实现保持原样，并由 runtime smoke、assembly、build、test 验证。
- Web-only 可见行为 → 使用 Web 开发入口和浏览器检查产品入口及核心界面。
- 配置与凭据迁移 → descriptor 显式声明 legacy Kit ID，Framework/Server 以通用、幂等、非破坏规则迁移；针对新值优先、重复执行和失败保留旧数据建立回归测试。
- 旧入口不兼容 → catalog、URL、CLI 与 runtimeKit 只接受 `harness`，不添加 alias；通过路由和 catalog 测试验证。
- 布局与窗口 ID → `harness-main` 成为新窗口标识，旧 localStorage 缓存自然失效且不迁移。

## 需求变更

- 初始需求为将现有 Agent Chat Kit 重命名为 **Harbors Harness**。
- 设计审查发现 Kit ID 参与配置、凭据和布局缓存命名。用户随后确认：配置与 API Key 必须迁移；旧入口不兼容；窗口 ID 一并改名；布局缓存可以丢弃。因此范围扩大到通用 Framework/Server 配置与凭据迁移能力，并重新进入 requirements 阶段完成检索与处置。
