# 删除迁移兼容层并收敛 current-only 数据模型总结

## 最终结论

本 Task 已完成。Server、Client、Plugin 与 Harness 不再保留本轮审计确认的历史迁移和恢复入口：设备不会在启动时再次生成兼容用户，Session 不再支持无归属创建、列举或认领，Config Storage 不再复制旧表，Harness 不再包含 legacy JSONL codec、exporter 或 `legacy-turn-*` fallback。Plugin manifest 必须显式声明 `schemaVersion`。

当前主库已经离线清理并收紧为 current schema：65 条无归属 Session 已删除，2 条已有归属 Session 和 7 条 AuthorizedDevice 的字段内容保持不变，`ownerUserId` 与 `userId` 的物理列均为 `NOT NULL`。重启后 `ownerless=0`，页面不再显示“恢复旧 Session”。

## 需求完成情况

- 用户删除：没有 Session 时同步撤销其授权设备和待授权请求；仍有 Session 时保持冲突。
- Device：fresh schema 直接要求 `userId`，删除启动迁移、ALTER/backfill 与重复 DDL。
- Session：fresh schema 直接要求 `ownerUserId`；持久 Session 只由 Workbench 在有效 User 下创建。
- `/api/session` 与 `SessionRuntimeRegistry`：只初始化已有 Session，不再隐式创建或失败回滚删除持久数据。
- Workbench/Client：删除 ownerless/claim 协议、UI、CSS 与测试；无效 URL/缓存 Session 清参后回 picker。
- Config Storage：只创建并使用当前 schema，不再 rename/copy 旧表。
- Harness：删除 legacy JSONL codec/normalize、canonical exporter、legacy turn fallback 及对应测试。
- Plugin：`ce-editor.schemaVersion` 显式必填，内置 manifest、落盘 fixture 和动态 fixture 均补齐。
- 真实数据：删除 65 条 `ownerUserId IS NULL` Session，并离线重建两张身份表以落实 `NOT NULL`。

## 主要改动

- `packages/server/**`：收敛 Device、Session、Config schema 和创建入口，删除迁移/认领 API，并更新 Server fixture。
- `packages/client/**` 与 `packages/plugin-types/**`：删除旧 Session 恢复链，无效 Session 回到选择页；`editor-app` 不再生成随机 Session。
- `packages/plugin/**`、Plugin package manifests 与测试 fixture：要求显式 schemaVersion。
- `kits/harness/plugins/agent/**`、`agent-context-store/**`、Chat trace 与 smoke：只保留当前 Context Store/trace 行为。
- `docs/architecture/**` 与 `docs/guides/**`：正式说明改为 current-only；删除不再有实现的 Legacy Agent JSONL 格式文档。

## 关键决定

- 用户明确要求执行三次独立审计列出的全部可删项，并授权清理当前主库 65 条 ownerless Session。
- 不把迁移代码放回产品；旧主库的物理约束通过一次离线、备份保护的事务整理到 current schema。
- 保留 Context Store 初始化 lock/journal/current pointer、epoch、tombstone、dead-runtime recovery，以及 Credential Vault recovery、Conversation archive/restore 和 Session access policy。
- 无效 Session 不再静默创建；Client 清理 `kit/page/session/sessionId` 后回到根选择流程。

## 验证结果

- 顶层 `pnpm run build` 通过。
- Framework prepared suite 通过：Server 64 files/772 tests、Client 34 files/310 tests、Kit Core 102 tests、Kit CLI 61 tests，以及 Gateway、Host Security、Native Credential Vault 和 106 项脚本测试。
- Plugin 47/47；plugin-build Node tests 13/13。
- Harness：280 unit、3 context fixtures、3 plugin、10 assembly；`pnpm run kits:check` 中 default/harness 均通过。
- Harness smoke 已按 current-only 流程先创建 User 和 owned Session，再验证非法 Kit 返回 `KIT_NOT_FOUND`。
- `git diff --check` 通过；生产扫描无 ownerless/claim/legacy JSONL/exporter/legacy-turn/device migration/config migration 残留。
- 浏览器：Session 页只显示 2 条已有归属 Session，不存在“恢复旧 Session”；未知 Session 直达 URL 被清理为 `/` 并返回使用者选择页。
- 重启后主库：`quick_check=ok`、ownerless=0、owned=2、`sessions.ownerUserId.notnull=1`、`authorized_devices.userId.notnull=1`。
- 独立 code review 最终结论为 PASS，无 blocker、major 或 minor。

## 影响与风险

- `blocking`：无。
- `non_blocking`：`pnpm run test:workflows` 的 architecture-boundary 仓库自检仍被 base commit 已存在的 4 条违规阻塞：三个 Harness prompt-eval 文件跨 Kit 引用 Server testing，一个 Client Kit Picker 测试使用静态 Kit ID 列表。本 Task 的功能、Framework、Plugin 与 Kit 全矩阵均已通过；未借本次清理扩展重构这些基线问题。
- `decision_candidates`：无。结束旧迁移兼容承诺已由用户明确批准。
- `follow_up`：可另建维护 Task 修复上述 4 条 architecture-boundary 基线问题。

## 偏差与遗留

计划中的 current-only 功能、真实数据清理、schema 收紧和浏览器验收均完成。唯一未全绿的仓库工作流命令是上述基线 architecture-boundary 自检；四条命中在基线 commit `7ae22af24b4cb30bb6bd89d08c5509b00fa0c588` 已存在，不是本轮新增。

页面仍显示现有 User/AuthorizedDevice 数据；本 Task 只删除明确授权的 65 条 ownerless Session，没有推断授权去删除其余当前用户或设备。

## 后续关注

- `follow_up`：用独立 maintenance Task 清除 architecture-boundary 的四条基线违规。
- 两份恢复备份应按运维需要保留；不要重新接入自动导入逻辑。

## Decision Delta

- `architecture`：AuthorizedDevice 与 Session 必须属于 User，fresh schema 直接使用非空 owner；已实现、验证并写入 `kit-and-session-model.md` 与 `system-overview.md`。
- `architecture`：持久 Session 只有 Workbench 显式 User 创建入口，runtime 初始化不创建持久数据；已实现并写入 `runtime-flows.md`。
- `architecture`：Harness SQLite Context Store 是唯一运行时事实源，不提供 JSONL codec、导入或导出；已实现并写入 `agent-context-store.md`。
- `guide`：Plugin manifest 必须显式声明 `ce-editor.schemaVersion`；已写入 `developing-plugins-and-kits.md`。
- `Task-only`：删除 65 条 ownerless Session、两次备份和离线表约束整理；完整证据记录在 `task.md`。
- `ADR`：无新增或修订。
- `candidate`：无。

## 反向检索验证

- 生产路径检索 `ownerlessSessions`、`claimSession`、`migrateLegacyDevices`、`ensureNamespacedSchema`、`normalizeLegacyTraceEvent`、`exportCanonicalJsonl`、`legacy-turn-` 与 `jsonl-format`，无命中。
- 所有落盘 Plugin package manifest 均显式 `ce-editor.schemaVersion=1`；动态 parser fixture 已在重新构建后的全量测试中覆盖。
- 正式架构和指南中不再引用已删除的 Legacy Agent JSONL 文档、ownerless Session 或默认 schemaVersion。
- 独立 reviewer 从唯一 Session 创建入口、数据库约束、Context Store 安全机制和备份逐列一致性反向复核，最终 PASS。

## 相关正式文档

- [Task 需求](task.md)
- [执行计划](.work/plan-v3.md)
- [诊断记录](.work/diagnosis-legacy-reimport.md)
- [系统总览](../../architecture/system-overview.md)
- [运行时流程](../../architecture/runtime-flows.md)
- [Kit 与 Session 模型](../../architecture/kit-and-session-model.md)
- [Plugin Runtime 模型](../../architecture/plugin-runtime-model.md)
- [Agent Context Store](../../architecture/agent-context-store.md)
- [Plugin 与 Kit 开发指南](../../guides/developing-plugins-and-kits.md)
