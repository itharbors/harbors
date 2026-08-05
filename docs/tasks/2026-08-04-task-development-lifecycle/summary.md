# Task 驱动开发生命周期实现总结

## 最终结论

本 Task 已完成需求快照、设计、实施、全量验证和 PR 前归总。whole-branch 安全审查发现的 PR 仓库身份、关闭 PR 替换、Git ref 参数、日期与 Markdown/状态校验等反例均已通过失败用例复现并修复；修复后的精确实现 head 已通过 full gate 和独立复审，当前达到 ready-for-pr。ready-for-pr 只允许进入 PR 创建阶段，不代表 PR 已合并、Task 生命周期派生完成或允许归档当前 Codex 会话。

## 需求完成情况

- Schema 与纯 domain：已提供严格 JSON Schema 和无文件 I/O 的状态领域模型，覆盖真实日历 Task ID、合法阶段序列、受控 `skip` 动作及 JavaScript 安全正整数 PR 约束。
- 结构化 status：`status.json` 只保存 Task 身份、类型、更新时间、五阶段状态和稳定 PR 编号，不接受主观进度或自由文本。
- 过程材料默认不提交：`.work/` 已纳入忽略规则，用于本地 spec、plan、调研和临时交接；跨环境仍需要的长期事实须升级为正式档案或文档。
- Framework：`change-workflow` 的 start 自动建档，finish 在首次网络写入前执行 Task 门禁，并支持不可变 summary 链接、同仓库 PR 复用、closed/unmerged PR 替换、编号回写、二次 push 与失败恢复；暂存状态恢复发生编号替换时，还会从 `HEAD` 读取旧编号并先证明旧 PR 已关闭且未合并。
- Kit：`kit-workflow` 复用统一 Task CLI；boundary 只额外允许当前 Task 的三份正式文件，finish/CI 使用精确 PR 仓库、head/base/head 事实执行身份与边界校验，同时保留 Kit 身份、版本、打包和发布边界。
- PR 前 summary：CLI 校验 `task.md` 与包含九个唯一非空章节的 `summary.md`，全部内部阶段终态后 `--ready-for-pr` 才放行。
- PR 号回写：finish 验证 PR 编号、base/head、状态、URL、head SHA、cross-repository、head owner 与 mergedAt 后才用 `set-pr` 记录安全正整数编号，精确提交 `status.json` 并二次普通 push，确保 PR 最新 head 包含该事实。
- 日期边界：Task 日期使用真实公历且年份从 0001 开始；Kit boundary 与 Schema、domain、CLI 对 0000 和 0001–0099 的判断保持一致。
- 派生完成与会话归档：完成状态只由内部终态、PR 编号、GitHub merged、最新 head required checks 和 `main` 三文件共同派生；仅全部成立后归档会话，合并后不制造额外归档 commit。

## 主要改动

- 状态模型、CLI 与 Markdown 合约：新增 Task Schema、纯状态转换、`init/start/complete/skip/block/resume/rewind/set-pr/check/resolve` 文件边界命令，以及 Task/summary 元数据、九个 summary 章节和 CommonMark fence 校验；默认日期使用本地日历，Git base ref 先解析为 SHA 再进入 diff。
- Framework workflow：start/finish 接入真实 Task CLI，PR 前解析唯一 ready Task，以 pre-PR SHA 生成 summary 链接，并校验同仓库 head owner；同名 fork PR 被排除，closed/unmerged 的旧 PR 可安全替换，已合并或身份不符时 fail closed。
- Kit workflow、boundary 与 CI：镜像 Framework 的 Task 事务，把当前 Task 三文件作为受限治理例外；加强 rename/copy、mode、branch identity 与精确 PR head 校验，不放宽其他 Kit 或共享文件边界。
- Skills 与文档：两份 workflow Skill、开发流程、文档维护指南和文档索引统一描述六阶段生命周期、七类变更、`.work/` 边界、实质审查回退和派生完成条件。
- 为最终门禁插入独立最小 bug fix：将两处 Agent Guard 测试的 `preview.2` 旧断言同步到既有 `preview.3` descriptor 事实；未改变 Kit 产品实现或版本。

## 关键决定

- 三份正式文件各自保持单一职责：`task.md` 保存需求快照，`status.json` 保存机器可校验的客观流程位置，`summary.md` 保存收口后的实现、验证、风险和遗留事实。
- spec、plan、排查和临时交接默认留在被忽略的 `.work/`；只有跨环境或长期维护仍需要的客观事实才升级为正式文档。
- PR、required checks 与 merge 状态以 GitHub 实时事实为权威，仓库只记录稳定 PR 编号，避免复制会过期的远端状态。
- PR 的 branch name 不足以证明身份；任何复用、编辑、编号回写或最终确认都必须同时证明 `isCrossRepository=false` 且 head owner 等于当前仓库 owner。
- PR body 的 summary 链接使用包含最新版总结的 pre-PR SHA；自动 PR 编号回写提交不改变该链接，实质修改则刷新到新的可证明 head。
- PR 编号回写后必须二次普通 push，并验证 GitHub `headRefOid` 与本地 HEAD 一致；该步骤完成的是第五阶段事实同步，不是合并完成。
- 合并后不再创建“归档完成”提交；只有 GitHub 与 `main` 的派生条件全部成立后才归档会话。

## 验证结果

- `npm run test:task-status`：exit 0，33/33 通过，0 failed/cancelled/skipped。
- `npm run test:change-workflow`：exit 0，32/32 通过，覆盖 fork 排除、closed/unmerged 替换、merged 拒绝及伪造暂存替换拒绝。
- `npm run test:kit-workflow`：exit 0，31/31 通过，覆盖与 Framework 相同的 PR 安全恢复边界。
- `node --test scripts/lib/kit-boundary.test.mjs`：exit 0，26/26 通过，覆盖 0001 合法与 0000 非法的日期边界。
- `node --test scripts/lib/kit-docs.test.mjs`：exit 0，12/12 通过，0 failed/cancelled/skipped，0.13s。
- `npm run check:preflight`：exit 0，Kit architecture boundary 返回 OK，preflight dot reporter 166 项全绿。
- `npm run check`：在提交标题规范化前的精确实现 head `d61cd3c2179f1fb50353a11035c8fc4872ec31f3` 上 exit 0；规范化后对应实现 head `64137ae` 与其 tree SHA 均为 `6a093d58a7904b07aeef8d89890020a8e208490c`，文件内容逐字节一致；build、Framework tests、全部 workflow、九个 Kit matrix 检查和 Framework plugin 检查全部通过。
- 独立 whole-branch 复审：原范围 `origin/main...d61cd3c2179f1fb50353a11035c8fc4872ec31f3`，结论 PASS，无剩余 Important、Minor 或整体质量问题；额外验证 Task/Kit boundary/docs 71/71、0000–9999 日期枚举 0 mismatch，以及伪造与合法 staged PR 替换恢复路径。此后仅将一条错误的 `[Bug]` 提交标题规范化为 `[Feature]`；对应实现 tree 完全相同，旧、新归档除本段为记录规范化事实而更新的 `summary.md` 外内容相同。

## 影响与风险

- 创建 PR 后回写 PR 编号会产生新的 branch head，并由第二次 push 重新触发 required CI；只有最新 head 的 required checks 成功才可继续判断派生完成。
- Node 文件系统 API 缺少 `openat`/dirfd 链式目录描述符语义；对同 UID 恶意并发路径替换只能通过拒绝 symlink、操作边界重验、可用时的 `O_NOFOLLOW`、独占临时文件和原子 rename 写入进行硬化，不宣称绝对防御。
- workflow 对 PR 字段、Task 状态、Git 身份、恢复窗口及边界证明采取 fail closed；GitHub 短暂一致性超出有界重试时会安全失败，需要保持现场后重试。
- 同名 fork PR 可能出现在按 branch 查询的候选中；workflow 会验证仓库身份并忽略该候选，绝不 edit 或记录其编号。
- 完整验证依赖与当前 Node ABI 匹配的 native dependencies；本轮在本地重建缺失的 `better-sqlite3` binding 后完成验证，该环境操作未产生仓库变更。

## 偏差与遗留

- 实施计划保留在 ignored `docs/tasks/2026-08-04-task-development-lifecycle/.work/implementation-plan.md`，未暂存、未提交；SDD 过程报告同样不进入提交。
- CLI `init` 的真实初态是 `requirements=completed`、`design=in_progress`，随后才按生命周期推进；该事实与把建档作为独立外部阶段的设计一致。
- 为解除最终 preflight 的既有 Agent Guard `preview.2`/`preview.3` 基线偏差，插入了独立、最小的测试断言 bug fix commit。
- 第一次 full check 因先前 `npm ci --ignore-scripts` 未生成 `better-sqlite3` native binding 而在 Framework prepared tests 环境失败；本地 `npm rebuild better-sqlite3` 后从头 fresh 重跑并通过，未修改产品或测试来规避失败。
- whole-branch reviewer 在初版 full gate 后发现六项重要问题和两项合约缺口；Task 已客观回退，所有反例均先以失败测试复现，再完成实现、文档和 summary 修正。
- 功能遗留：无。

## 后续关注

- PR 审查若引入行为、范围、关键决定、验证证据或风险的实质变化，必须按影响 `rewind` 到 implementation、verification 或 consolidation，重新实施、全量验证并更新 summary。
- 创建 PR 后需确认编号回写的最新 head、required checks 和 PR body 的不可变 summary 链接；PR 关闭未合并或 head 不一致均不能视为完成。
- 只有 PR 已 merge、最新 head required checks 成功且 `task.md`、`status.json`、`summary.md` 已进入 `main` 后，才可归档当前 Codex 会话；ready-for-pr 本身不授权 merge 或会话归档。

## 相关正式文档

- [Task 生命周期设计](../../superpowers/specs/2026-08-04-task-development-lifecycle-design.md)
- [开发流程指南](../../guides/development-workflow.md)
- [Task 档案与 CLI 合约](../README.md)
