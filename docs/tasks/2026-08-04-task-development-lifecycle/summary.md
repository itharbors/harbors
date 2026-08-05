# Task 驱动开发生命周期实现总结

## 最终结论

本 Task 的状态模型、CLI、档案合约及 Framework/Kit workflow 集成已满足需求快照中的验收标准，并在最终 fresh 全量门禁通过后达到 ready-for-pr。该结论只表示当前 head 可以创建 PR；目前尚无 PR 编号，也未满足 GitHub merged、最新 head required checks 成功以及 `main` 已包含三份正式 Task 文件的派生完成条件，因此不代表生命周期完成，也不应归档当前 Codex 会话。

## 需求完成情况

- Schema 与纯 domain：已提供严格 JSON Schema 和无文件 I/O 的状态领域模型，覆盖结构校验、合法阶段序列、状态动作及 PR 正整数约束。
- 结构化 status：`status.json` 只保存 Task 身份、类型、更新时间、五阶段状态和稳定 PR 编号，不接受主观进度或自由文本。
- 过程材料默认不提交：`.work/` 已纳入忽略规则，用于本地 spec、plan、调研和临时交接；跨环境仍需要的长期事实须升级为正式档案或文档。
- Framework：`change-workflow` 的 start 自动建档，finish 在首次网络写入前执行 Task 门禁，并支持不可变 summary 链接、PR 复用、编号回写、二次 push 与失败恢复。
- Kit：`kit-workflow` 复用统一 Task CLI；boundary 只额外允许当前 Task 的三份正式文件，CI 使用精确 PR head/base/head 事实执行边界校验，同时保留 Kit 身份、版本、打包和发布边界。
- PR 前 summary：CLI 校验 `task.md` 与包含八个唯一非空章节的 `summary.md`，全部内部阶段终态后 `--ready-for-pr` 才放行。
- PR 号回写：finish 验证唯一 open PR 的六项事实后用 `set-pr` 记录正整数编号，精确提交 `status.json` 并二次普通 push，确保 PR 最新 head 包含该事实。
- 派生完成与会话归档：完成状态只由内部终态、PR 编号、GitHub merged、最新 head required checks 和 `main` 三文件共同派生；仅全部成立后归档会话，合并后不制造额外归档 commit。

## 主要改动

- 状态模型、CLI 与 Markdown 合约：新增 Task Schema、纯状态转换、`init/start/complete/block/resume/rewind/set-pr/check/resolve` 文件边界命令，以及 Task/summary 元数据、章节和 CommonMark fence 校验。
- Framework workflow：start/finish 接入真实 Task CLI，PR 前解析唯一 ready Task，以 pre-PR SHA 生成 summary 链接，并对已有 PR、回写失败、重复执行和远端 head 收敛执行保守恢复或 fail closed。
- Kit workflow、boundary 与 CI：镜像 Framework 的 Task 事务，把当前 Task 三文件作为受限治理例外；加强 rename/copy、mode、branch identity 与精确 PR head 校验，不放宽其他 Kit 或共享文件边界。
- Skills 与文档：两份 workflow Skill、开发流程、文档维护指南和文档索引统一描述六阶段生命周期、七类变更、`.work/` 边界、实质审查回退和派生完成条件。
- 为最终门禁插入独立最小 bug fix：将两处 Agent Guard 测试的 `preview.2` 旧断言同步到既有 `preview.3` descriptor 事实；未改变 Kit 产品实现或版本。

## 关键决定

- 三份正式文件各自保持单一职责：`task.md` 保存需求快照，`status.json` 保存机器可校验的客观流程位置，`summary.md` 保存收口后的实现、验证、风险和遗留事实。
- spec、plan、排查和临时交接默认留在被忽略的 `.work/`；只有跨环境或长期维护仍需要的客观事实才升级为正式文档。
- PR、required checks 与 merge 状态以 GitHub 实时事实为权威，仓库只记录稳定 PR 编号，避免复制会过期的远端状态。
- PR body 的 summary 链接使用包含最新版总结的 pre-PR SHA；自动 PR 编号回写提交不改变该链接，实质修改则刷新到新的可证明 head。
- PR 编号回写后必须二次普通 push，并验证 GitHub `headRefOid` 与本地 HEAD 一致；该步骤完成的是第五阶段事实同步，不是合并完成。
- 合并后不再创建“归档完成”提交；只有 GitHub 与 `main` 的派生条件全部成立后才归档会话。

## 验证结果

- `npm run test:task-status`：exit 0，28/28 通过，0 failed/cancelled/skipped，6.52s。
- `npm run test:change-workflow`：exit 0，29/29 通过，165.04s。
- `npm run test:kit-workflow`：exit 0，29/29 通过，246.24s。
- `node --test scripts/lib/kit-docs.test.mjs`：exit 0，12/12 通过，0 failed/cancelled/skipped，0.13s。
- `npm run check:preflight`：exit 0，Kit architecture boundary 返回 OK，preflight dot reporter 161 项全绿，11.09s。
- 环境 native binding 重建后从 build 起 fresh 运行 `npm run check`：exit 0，753.41s；build、Framework prepared tests、workflow tests、全部 9 个 Kit checks 及 Framework plugin checks 均真实执行，Kit matrix 的 `agent-guard`、`csv`、`default`、`mysql`、`notifications`、`scheduler`、`skill-manager`、`sqlite`、`traceweave` 均为 passed，未因缓存或缺环境跳过 required gate。

## 影响与风险

- 创建 PR 后回写 PR 编号会产生新的 branch head，并由第二次 push 重新触发 required CI；只有最新 head 的 required checks 成功才可继续判断派生完成。
- Node 文件系统 API 缺少 `openat`/dirfd 链式目录描述符语义；对同 UID 恶意并发路径替换只能通过拒绝 symlink、操作边界重验、可用时的 `O_NOFOLLOW`、独占临时文件和原子 rename 写入进行硬化，不宣称绝对防御。
- workflow 对 PR 字段、Task 状态、Git 身份、恢复窗口及边界证明采取 fail closed；GitHub 短暂一致性超出有界重试时会安全失败，需要保持现场后重试。
- 完整验证依赖与当前 Node ABI 匹配的 native dependencies；本轮在本地重建缺失的 `better-sqlite3` binding 后完成验证，该环境操作未产生仓库变更。

## 偏差与遗留

- 实施计划保留在 ignored `docs/tasks/2026-08-04-task-development-lifecycle/.work/implementation-plan.md`，未暂存、未提交；SDD 过程报告同样不进入提交。
- CLI `init` 的真实初态是 `requirements=completed`、`design=in_progress`，随后才按生命周期推进；该事实与把建档作为独立外部阶段的设计一致。
- 为解除最终 preflight 的既有 Agent Guard `preview.2`/`preview.3` 基线偏差，插入了独立、最小的测试断言 bug fix commit。
- 第一次 full check 因先前 `npm ci --ignore-scripts` 未生成 `better-sqlite3` native binding 而在 Framework prepared tests 环境失败；本地 `npm rebuild better-sqlite3` 后从头 fresh 重跑并通过，未修改产品或测试来规避失败。
- 功能遗留：无。

## 后续关注

- PR 审查若引入行为、范围、关键决定、验证证据或风险的实质变化，必须按影响 `rewind` 到 implementation、verification 或 consolidation，重新实施、全量验证并更新 summary。
- 创建 PR 后需确认编号回写的最新 head、required checks 和 PR body 的不可变 summary 链接；PR 关闭未合并或 head 不一致均不能视为完成。
- 只有 PR 已 merge、最新 head required checks 成功且 `task.md`、`status.json`、`summary.md` 已进入 `main` 后，才可归档当前 Codex 会话；ready-for-pr 本身不授权 merge 或会话归档。
