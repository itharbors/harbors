# 移除 Agent 冗余的 list_skills 工具总结

## 最终结论

Harness Agent 已不再向模型暴露或在运行时分发 `list_skills`。每个 Turn 继续通过 system instructions 提供受预算约束的 Skill metadata catalog，模型选中 Skill 后可直接调用 `load_skill` 读取完整 `SKILL.md`。确定性测试、真实 Agent Plugin runtime、真实 Provider 评测和唯一 Web 宿主验收均证明该链路可用，当前没有阻止提交的问题。

## 需求完成情况

- 模型工具 schema 已删除 `list_skills`，保留 `load_skill`。
- 工具执行分支和并行工具分类已删除 `list_skills`，没有兼容别名或生产代码残留。
- `load_skill` 未命中错误改为说明 Skill 不在当前 Turn 可用目录，不再建议调用已删除工具。
- system catalog、同一 Turn `SkillCatalog` 绑定、路径与根身份校验、正文上限和成功加载 Trace 逻辑保持不变。
- 新测试覆盖直接加载、模型 payload、未命中错误、普通 `read`、失败加载和 `loadedSkills` 记录边界。

## 主要改动

- `main/src/adapter/tools.ts`：删除 `list_skills` schema 与执行分支，更新 `load_skill` 未命中错误。
- `main/src/adapter/harbors.ts`：从只读并行工具集合删除 `list_skills`。
- `main/src/adapter/tools.test.ts`：断言模型工具只保留按需加载入口，验证无需前置列举即可加载当前 Turn Skill，并锁定错误文案不含 `list_skills`。
- `tests/runtime.smoke.test.ts`：在真实 Agent Plugin → Model Service 链路中断言工具 payload，并同时验证成功加载、超限失败和普通文件读取只把成功 Skill 记入 Trace。

## 关键决定

- 保留 metadata-first、full-instructions-on-selection：Skill 索引属于每 Turn system instructions，完整正文继续由 `load_skill` 受控读取。
- 不为历史兼容保留不可见的 `list_skills` 分支；当前实现没有刷新、分页、搜索或 catalog 省略项访问语义。
- 不改变 catalog 发现和加载安全边界；system 注入和加载继续绑定同一个 Turn 快照。
- 未形成新的 ADR。该优化是既有 Agent Skill 渐进披露架构内的 Task-only 收敛。

## 验证结果

- Agent 全部并置测试：`pnpm --dir . exec tsx --test "kits/harness/plugins/agent/main/src/**/*.test.ts" "kits/harness/plugins/agent/tests/prompt-eval*.test.ts"`，79/79 通过。
- 真实 Agent Plugin runtime smoke：`pnpm --dir packages/server exec vitest run --root ../../kits/harness --config ../../kits/harness/vitest.config.ts plugins/agent/tests/runtime.smoke.test.ts`，1/1 通过。
- Plugin 制品：`node scripts/ce-plugin.mjs build kits/harness/plugins/agent` 与 `node scripts/ce-plugin.mjs check kits/harness/plugins/agent` 通过；刷新后的 ignored `main/dist` 无 `list_skills` 残留。
- 真实 Provider eval：Model Service catalog 默认模型 `alwaysday1`，4/4 完成且 `blocked=null`；显式和隐式案例均为 `load_skill → read`，unmatched 无工具调用，oversized 只尝试失败的 `load_skill` 后停止。
- 唯一 Web 宿主：重启 `com.harbors.devserver.48381` 后 `http://127.0.0.1:48381/` 返回 HTTP 200，Harness 显示 13/13 Plugin 已加载。浏览器请求 Turn 5 直接执行成功的 `load_skill(lark-attendance)`，Turn 3 unmatched 无工具调用；对应 Trace 分别为 `loadedSkills=["lark-attendance"]` 和 `loadedSkills=[]`，全 Trace 无 `list_skills` 工具调用。
- `git diff --check` 与 Task CLI 普通 check 通过。

## 影响与风险

- 每轮发送给模型的工具 schema 少一个无独立语义的工具，模型无需为已在 system 中可见的目录增加一次列举往返。
- 已有对话历史中若包含旧 `list_skills` 调用仍作为历史事件保留；新 Turn 不再向模型提供该工具，也不在运行时保留兼容执行分支。
- catalog 超预算省略的 Skill 仍不可由模型发现；本 Task 没有扩展分页或搜索能力，行为与优化前的 system catalog 契约一致。

## 偏差与遗留

- 浏览器第一次显式命中使用了历史已加载过的 `change-workflow`，不能证明当前 Turn 新加载，因此未作为验收证据；随后改用此前未加载的 `lark-attendance` 完成独立验证。
- 真实 eval runner 的规范输出位置仍固定在既有 `2026-08-26-agent-system-instructions/.work/evidence/prompt-eval.json`；本 Task 不修改 eval 协议，关键结果已固化在本总结。
- 浏览器控制台出现 Chat Panel 已有的 React 重复 key 警告，涉及 `TurnBlock`/`TranscriptTurnRow`，不由本次 Agent 工具 diff 引入，也不影响本 Task 的工具调用与 Trace 验收。

## 后续关注

- `blocking`：无。
- `non_blocking`：Chat Panel 的重复 key 警告会产生控制台噪声，并可能影响 Turn 过程展开；建议由 Chat Plugin 的独立 bug Task 处理。
- `decision_candidates`：无。
- `follow_up`：如果未来需要 Turn 内刷新、分页或访问 catalog 省略项，应定义新的明确协议与验收，不应恢复当前无语义的 `list_skills`。

## 决策闭环收口

### Decision Delta

- `Task-only`：删除重复的 `list_skills` 模型工具、执行分支和旧错误提示。证据为本 Task 源码 diff、79/79 单元测试、1/1 runtime smoke、4/4 真实 eval 与 Web Trace；影响范围限于 Harness Agent Plugin；状态为已验证；正式落点为本 Task summary 与 Agent Plugin 源码/测试；反向检索可由 `list_skills` 定位本 Task，且生产代码零命中。
- `architecture`：无新增。system Skill catalog → 同 Turn `load_skill` 的结构事实已由 `2026-08-26-agent-system-instructions` 建立，本 Task 只消除重复入口。
- `guide`：无新增；现有 Plugin 局部验证与 Web-only 规则足以覆盖本次工作。
- `ADR`：无新增或修订。
- `candidate`：无。未来刷新或分页只作为 follow-up 触发条件，不构成本 Task 的待批准决策候选。

### 正式落点

- 需求、边界与验收：本 Task `task.md`。
- 实现与回归：`kits/harness/plugins/agent/main/src/adapter/tools.ts`、`harbors.ts` 及对应测试。
- 既有渐进披露架构依据：`docs/tasks/2026-08-26-agent-system-instructions/task.md` 与 `summary.md`。

### 反向检索验证

- 预期查询：`list_skills`、`load_skill`、`Skill 渐进披露`、`available_skills`。
- `list_skills` 在 Agent Plugin 生产代码中无命中，Plugin 范围仅在“不应存在”的测试断言中命中；仓库范围另有 `2026-08-16-agent-chat`、`2026-08-26-agent-system-instructions` 等历史 Task 和本 Task 文档记录当时或本次事实。`load_skill` 与 `Skill 渐进披露` 可定位既有架构 Task、当前实现与本 Task。
- 当前无需要发布到 ADR、architecture 或 guide 的新长期事实；本 Task 总结是本次优化的正式审查与交接落点。

## 相关正式文档

- [Task 定义](task.md)
- [Task 状态](status.json)
- [Agent 基础系统指令与 Skill 渐进披露](../2026-08-26-agent-system-instructions/task.md)
- [测试指南](../../guides/testing.md)
