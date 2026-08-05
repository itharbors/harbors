# Task 档案

每个可交付变更使用一个目录：`docs/tasks/YYYY-MM-DD-<slug>/`。日期使用创建日，`slug` 使用小写 kebab-case，并与变更分支的类型和 slug 对应。

目录中只有三类正式、可提交的长期事实：

- `task.md` 是需求快照：说明问题、目标、边界、约束和验收标准；它不记录实施过程的猜测。
- `status.json` 是机器校验的客观状态：Task ID、类型、阶段、更新时间和 PR 编号。它不保存自由文本、主观进度或敏感信息。
- `summary.md` 是收口总结：在收口阶段终态前写入，记录实际实现、验证、影响和遗留。

`.work/` 默认被 Git 忽略，适合存放 spec、plan、调研笔记、短期验证输出和其他过程材料。若某项内容需要被审查、复现、跨会话或跨环境交接，应将客观且长期有用的信息整理进 `task.md`、`summary.md` 或相应正式文档，而不是依赖 `.work/`。同一台机器上的会话可以通过 `.work/` 接续；跨环境移交时必须升级仍需要的客观信息。

不要在正式 Task 文件或 `.work/` 中写入密码、token、密钥、cookie、连接串或其他可恢复的敏感信息。

## 类型与阶段

Task 类型为 `feature`、`bug`、`optimize`、`docs`、`refactor`、`test`、`chore`：分别用于新能力、缺陷修复、性能资源优化、文档、无行为变化的结构调整、独立测试和日常维护。

一项变更依次经过六个工作阶段：

1. 需求/分类：确认需求并选择七类类型之一。
2. Task 建档：创建目录、填写需求快照和初始状态。
3. 设计/计划：在本地过程材料中完成可执行设计。
4. 实现/验证：实现、测试和修正。
5. 收口/PR：完成总结、通过 PR 前检查、创建 PR。
6. 合并确认/会话归档：以 GitHub 与 main 的事实确认完成，再归档 Codex 会话。

`status.json` 的五个内部 stages 是 `requirements`、`design`、`implementation`、`verification`、`consolidation`。可用 action 为 `start`、`complete`、`block`、`resume`、`rewind`、`set-pr`。前一阶段必须终态才能开始后一阶段；`complete` 只作用于进行中阶段；`block`/`resume` 在进行中与阻塞之间切换；`rewind` 使目标阶段重新进行并将其后阶段设回 pending；`set-pr` 只在所有内部阶段终态时记录正整数 PR 号。状态只记录这些结构化事实，不添加主观说明。

审查导致实质变更时，使用 `rewind` 回退 `implementation`、`verification` 或 `consolidation` 的适当阶段，重新实施、验证和更新总结；不要保留过时的总结来表示新代码。

## CLI

在仓库根目录运行下列命令。所有命令都会打印 Task ID，非零退出表示校验或转换未通过。

```bash
node scripts/task-status.mjs init feature safe-login --date 2026-08-04
node scripts/task-status.mjs start 2026-08-04-safe-login implementation
node scripts/task-status.mjs complete 2026-08-04-safe-login implementation
node scripts/task-status.mjs block 2026-08-04-safe-login verification
node scripts/task-status.mjs resume 2026-08-04-safe-login verification
node scripts/task-status.mjs rewind 2026-08-04-safe-login implementation
node scripts/task-status.mjs set-pr 2026-08-04-safe-login 123
node scripts/task-status.mjs check 2026-08-04-safe-login
node scripts/task-status.mjs check 2026-08-04-safe-login --ready-for-pr
node scripts/task-status.mjs resolve feature/safe-login origin/main
node scripts/task-status.mjs resolve feature/safe-login origin/main --ready-for-pr
```

普通 `check` 要求 `task.md` 符合合约，并在 `summary.md` 存在时校验它；当 `consolidation` 为终态时 `summary.md` 必须存在。`--ready-for-pr` 还要求三份正式文件非空、两份 Markdown 均符合合约以及全部内部 stages 终态；PR 号可以仍为 `null`。`resolve` 从本分支相对 base 的 Task 变更解析唯一状态，并确认分支身份相符。

## PR、合并与完成

创建 PR 前，在当前 pre-PR head 上完成并提交 `summary.md`，PR body 链接该不可变 SHA 上的 summary URL。创建 PR 后记录 PR 号并再次 push，使 `status.json` 的 PR 事实可追溯。

“完成”是派生事实，必须同时满足：内部 stages 终态、已记录 PR 号、GitHub 显示 merged、最新 head 的 required checks 成功，以及三份 Task 正式文件已在 main。仅在这些事实成立后归档 Codex 会话；不要为了“归档”制造合并后的 commit。

## 可复制模板

将反引号中的值替换为本 Task 的明确事实；每个章节都应写入可审查的具体内容。模板中的示例文字说明应被替换为实际信息，不能保留模糊占位词。

```md
# 2026-08-04-safe-login

Task ID: `2026-08-04-safe-login`
Type: `feature`

## 背景与问题

说明触发本次变更的用户问题、证据或维护需求。

## 目标

说明交付后可观察到的结果。

## 范围

说明本次会修改的系统边界。

## 非目标

说明本次明确不处理的相邻问题。

## 验收标准

列出可执行或可观察的逐项验收结果。

## 约束

说明兼容性、安全性、流程或技术限制。

## 需求变更

说明已批准的需求调整；没有调整时明确写“本 Task 未发生需求变更”。
```

```md
# 2026-08-04-safe-login 实现总结

## 最终结论

说明是否满足收口条件以及结论依据。

## 需求完成情况

逐项说明 task.md 验收标准的完成状态。

## 主要改动

说明用户可见或维护者可见的关键改动。

## 关键决定

说明重要取舍及其理由。

## 验证结果

列出实际运行的命令、结果和必要的环境限制。

## 影响与风险

说明兼容性、发布、性能或操作风险。

## 偏差与遗留

说明与原需求的已批准偏差，或明确写“没有已知偏差与遗留”。

## 后续关注

说明合并后需要观察的客观信号，或明确写“当前没有额外关注项”。
```
