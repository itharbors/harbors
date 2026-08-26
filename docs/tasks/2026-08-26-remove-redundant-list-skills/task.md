# 移除 Agent 冗余的 list_skills 工具

Task ID: `2026-08-26-remove-redundant-list-skills`
Type: `optimize`

## 背景与问题

Harness Kit 的 Agent Plugin 已在每个 Turn 的 system instructions 中注入受预算约束的 Skill 目录，目录包含可用 Skill 的 `name`、`description` 和脱敏 `SKILL.md` 路径；模型选中 Skill 后，再通过 `load_skill` 按需读取完整正文。这已经形成 metadata-first、full-instructions-on-selection 的渐进披露链路。

Agent 当前仍向模型暴露 `list_skills` 工具。该工具返回本 Turn 已发现的同一份 Skill 目录快照，不刷新目录、不分页展示被预算省略的条目，也不提供 system instructions 之外的新信息；其 description 仍要求“先调用它确认名称，再调用 `load_skill`”，`load_skill` 的未命中错误也要求先调用 `list_skills`。这与当前 system catalog 事实重复，会增加工具 schema、无意义工具调用、模型往返和行为歧义。

## 目标

1. 从 Agent 的模型可见工具集合和运行时分发中移除无独立语义的 `list_skills`。
2. 保留 system Skill catalog → `load_skill` → 完整 `SKILL.md` 的渐进披露链路。
3. 让模型可以根据本 Turn system catalog 直接调用 `load_skill`，不再被提示执行前置列举调用。
4. 清理与 `list_skills` 有关的错误文案、并行工具分类、测试和评测假设，减少提示预算与无效往返。

## 范围

- `kits/harness/plugins/agent/main/**` 中 `list_skills` 的 tool schema、执行分支、并行工具分类和相关提示或错误文案。
- `kits/harness/plugins/agent/tests/**` 及 Agent Plugin 自有测试中与 Skill 工具发现顺序有关的 fixture、断言和行为评测。
- Agent Plugin 构建产物及本 Task 档案。
- 对 system Skill catalog 与 `load_skill` 现有 Turn 快照绑定、安全校验和 Trace 行为进行回归验证。

## 非目标

- 不把完整 Skill 正文直接注入 system instructions。
- 不移除或放宽 `load_skill` 的路径、根身份、元数据和正文大小校验。
- 不改变 Skill 根目录发现、同名 winner、目录排序、8 KiB catalog 预算或 12,000 UTF-8 字节正文上限。
- 不新增 Skill 运行时刷新、分页、搜索、远程 provider 或多 authority 协议。
- 不修改 Harness Kit 其他 Plugin、Framework、Model Service 或消息协议。
- 如果设计阶段发现必须支持 Turn 内目录刷新、分页或访问被预算省略条目，不在本 Task 中悄悄复用 `list_skills` 名称；停止并向用户确认扩展方向。
- 不执行 push 或创建 PR；用户已授权直接在当前分支实现并提交本 Task。

## 验收标准

1. Agent 发给模型的工具定义中不再包含 `list_skills`，仍包含 `load_skill`。
2. Agent 工具执行分发和并行工具集合中不存在 `list_skills` 分支或兼容别名，不保留不可达死代码。
3. `load_skill` 可以直接按本 Turn 已发现 catalog 中的 Skill 名称读取完整 `SKILL.md`，不要求先执行其他 Skill 工具。
4. `load_skill` 未命中时返回与本 Turn 可用目录一致的明确错误，不再建议调用不存在的 `list_skills`。
5. system instructions 继续注入包含 `name`、`description` 和路径的 Skill catalog；显式和隐式 Skill 场景仍表现为 `load_skill` 在相关行动前执行，无匹配场景不调用 Skill 工具。
6. Skill catalog 的裁剪、省略、shadowing 和诊断行为保持不变；删除 `list_skills` 不扩大模型对被省略 Skill 的访问承诺。
7. Trace 仍只在 `load_skill` 成功后记录 `loadedSkills`，失败加载和普通文件读取不得被误记为 Skill 加载。
8. Agent Plugin 针对性测试、真实 Plugin handler smoke test、提示行为 eval、构建、Plugin check 和 `git diff --check` 通过。
9. 在 Harbors 唯一 Web 宿主中完成浏览器验收：选择一个可见 Skill 的请求可以直接加载并继续执行，不出现“先列出 Skill”状态或错误；无匹配请求不产生 Skill 工具调用。
10. 业务代码变更严格限制在 `kits/harness/plugins/agent/**`；若实现需要修改 Kit 外路径，停止并先向用户确认。

## 约束

- Harbors 仅支持 Web 宿主；Agent 共享可见行为必须通过 Web 浏览器验收。
- system catalog 是模型在 Turn 开始时的 Skill 发现入口，`load_skill` 是完整正文的受控加载入口；删除前者的重复工具不能削弱后者的安全边界。
- 必须使用同一个本 Turn `SkillCatalog` 绑定 system 注入和 `load_skill`，避免模型看到的目录与实际加载集合发生 TOCTOU 分叉。
- 保留用户已有改动，不 stash、reset、清理或覆盖无关文件。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- 用户指出 Skill 信息应在每轮系统提示词中可见，并询问为何还需要 `list_skills` tool；核对当前实现后确认，system instructions 已包含 Skill metadata catalog，而 `list_skills` 只返回同一 Turn 的相同 catalog 快照。
- 相关已完成 Task `2026-08-26-agent-system-instructions` 已确立 metadata-first、选中后通过 `load_skill` 读取完整正文的渐进披露架构，并明确真实模型评测的期望顺序是 `load_skill → related action`，没有把 `list_skills` 作为必需前置步骤。
- 已查询批准决策记忆，未找到关于保留或移除 `list_skills` 的 global 或 repository decision、constraint、lesson 或 rule；索引 freshness 为 `partial`，有 1 个失败文件，因此不能把空结果解释为完整知识库证明。
- 已扫描 `docs/decisions`、`docs/architecture`、`docs/guides`、相关 Task 和 Agent Plugin 实现；未发现要求保留重复列举工具的正式 ADR。当前直接证据来自已完成的渐进披露 Task 与现有实现。
- owner：后续任务主 Agent，负责 Task 状态、范围边界、实际 diff 和验证证据。
- reviewer：执行计划中的独立审查角色，负责检查工具契约残留、Skill 加载安全边界、提示预算和行为回归。
- approver：当前用户，负责工作环境、范围扩展和后续交付选择。

### 逐条处置与分工

- **适用既有渐进披露架构**：保留 system metadata catalog 和按需 `load_skill`；来源为 `2026-08-26-agent-system-instructions` Task，由 owner 在设计和验证中维护映射。
- **移除重复能力**：将当前 `list_skills` 视为无独立运行时语义的重复入口，目标是删除模型 schema、执行分支和相关文案，由 implementer 在 Agent Plugin 内闭环。
- **保留安全与快照绑定**：`load_skill` 继续只接受本 Turn 已发现 winner，并执行现有路径和大小校验，由 reviewer 重点检查。
- **不预先批准新协议**：刷新、分页、搜索或访问 catalog 省略项属于范围扩展；若出现真实需求，由 approver 另行确认，不在实现中隐式加入。
- **验证用户可见行为**：确定性测试证明 schema 和分发清理，真实模型 eval 与 Web 浏览器证明模型能直接加载适用 Skill 且无冗余前置调用。

### 过程关联

- 工具定义、执行分支和并行分类清理映射到 `main/src/adapter/tools.ts` 与 `main/src/adapter/harbors.ts`。
- system catalog、Turn 快照绑定、`load_skill` 安全校验和 Trace 回归映射到 `main/src/adapter/system-instructions.ts`、`main/src/adapter/skills.ts`、`main/src/adapter/harbors.ts` 及其针对性测试。
- 模型行为和用户可见结果映射到 Agent Plugin 的 prompt eval、runtime smoke test 和唯一 Web 宿主浏览器验收。

## 需求变更

- 初始讨论用于澄清 Skill metadata、完整正文和加载工具的边界；用户随后确认将 `list_skills` 的冗余问题记录为优化 Task。
- 用户随后明确要求直接实施该 Task、在当前分支修改并创建 commit；因此工作环境采用 `current`，完成设计、实现、验证和本地提交，不执行 push 或创建 PR。
