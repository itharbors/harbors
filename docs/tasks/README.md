# Task 档案

每个可交付变更使用一个目录：`docs/tasks/YYYY-MM-DD-<slug>/`。日期使用创建日，`slug` 使用小写 kebab-case，并与变更分支的类型和 slug 对应。

目录中只有三类正式、可提交的长期事实：

- `task.md` 是需求快照：说明问题、目标、边界、约束和验收标准；它不记录实施过程的猜测。
- `status.json` 是机器校验的客观状态：Task ID、类型、阶段、更新时间和 PR 编号。它不保存自由文本、主观进度或敏感信息。
- `summary.md` 是收口总结：在收口阶段终态前写入，记录实际实现、验证、影响和遗留，并收口本次决策反馈闭环。

`.work/` 默认被 Git 忽略，适合存放 spec、plan、调研笔记、短期验证输出和其他过程材料。若某项内容需要被审查、复现、跨会话或跨环境交接，应将客观且长期有用的信息整理进 `task.md`、`summary.md` 或相应正式文档，而不是依赖 `.work/`。同一台机器上的会话可以通过 `.work/` 接续；跨环境移交时必须升级仍需要的客观信息。

不要在正式 Task 文件或 `.work/` 中写入密码、token、密钥、cookie、连接串或其他可恢复的敏感信息。

## 类型与阶段

Task 类型为 `feature`、`bug`、`optimize`、`docs`、`refactor`、`test`、`chore`：分别用于新能力、缺陷修复、性能资源优化、文档、无行为变化的结构调整、独立测试和日常维护。

一项变更依次经过六个工作阶段：

1. 需求/分类：确认需求并选择七类类型之一。
2. Task 建档：创建目录、填写需求快照和初始状态。
3. 设计/计划：在本地过程材料中完成可执行设计。
4. 实现/验证：实现、测试和修正。
5. 收口/交付选择：完成总结、通过 ready gate，向用户询问创建 PR、本地整合到 `main` 或暂不处理。
6. 交付确认/会话归档：按用户选择的路径确认本地或 GitHub 事实，再归档 Codex 会话。

`status.json` 的五个内部 stages 是 `requirements`、`design`、`implementation`、`verification`、`consolidation`。可用 action 为 `start`、`complete`、`skip`、`block`、`resume`、`rewind`、`set-pr`。前一阶段必须终态才能开始后一阶段；`complete` 和 `skip` 只作用于进行中阶段，并分别形成 completed、skipped 终态；`block`/`resume` 在进行中与阻塞之间切换；`rewind` 使目标阶段重新进行并将其后阶段设回 pending；`set-pr` 只在所有内部阶段终态时记录安全正整数 PR 号。状态只记录这些结构化事实，不添加主观说明。

`skip` 不豁免决策闭环记录。确无适用决策时，必须先完成仓库检索并在 `task.md` 明确记录“无适用项”
及检索证据；确无决策增量时，必须在 `summary.md` 明确记录“无增量”及分类和反向检索验证证据。
缺少这些记录时不得将相关 stage 标为 skipped。

## 决策反馈闭环记录

Task 的检索、规划、反馈、执行、验证和收口遵循[决策反馈闭环指南](../guides/decision-feedback-loop.md)。
闭环复用上述五个内部 stages，不新增状态阶段；角色反馈是输入，不自动成为正式决策。
外部 decision memory 只能帮助发现可回链的仓库来源，不能独立约束 Task；无命中、`partial` 或
`failed` 时仍必须扫描仓库 Markdown。

### `task.md`：决策上下文与处置

新建 Task 必须增加“决策上下文与处置”章节并至少记录以下内容。已有 Task 仅在任务范围或关键依赖
发生变化，或收口涉及长期决策时补齐；其他已有 Task 不因本契约回溯改写：

- **Decision Context**：任务启动检索的意图、范围、时间点、已批准来源及关键约束；记录候选 owner、
  reviewer、approver 的标识、角色来源和负责范围。无论外部 memory 是否命中，都要记录对
  `docs/decisions`、`docs/architecture`、`docs/guides`、相关 Task 和实现路径的仓库扫描，以及
  检索质量和仍未解决的缺口；确无适用决策时明确写“无适用项”并保留检索证据。
- **逐条处置与分工**：design 阶段确认 owner、reviewer、approver 的分工；对每项相关决策标记
  “适用、不适用、冲突、需新增”或“需人工确认”，附来源、理由、证据和负责人；单独处置角色反馈，
  不把反馈冒充决策。
- **过程关联**：记录决策到实现/测试证据的预期映射；范围变化时记录重新检索及处置更新。

### `summary.md`：决策增量与反向验证

新建 Task 的 `summary.md` 在收口时必须增加“决策闭环收口”章节并记录以下内容；已有 Task 在上述
范围/依赖变化或收口涉及长期决策时必须补齐：

- **Decision Delta**：按已批准决策、当前架构事实、操作方法、待讨论方案、一次性任务证据、冲突或例外分类，逐项说明保留、修订、替代、新增等变化，并指向对应 Task 事实；确无决策增量时明确写“无增量”并保留分类证据。
- **正式落点**：列出每项最终落点及链接；批准的长期取舍进入 ADR，架构事实进入 `docs/architecture`，
  可复用方法进入 `docs/guides`，未批准或一次性信息留在 Task，不把角色反馈直接发布为决策。
- **反向检索验证**：写明使用的查询/意图、命中的正式文档、预期信息是否可被下一次规划消费，以及
  未命中或仍需人工确认的项目。验证失败时不得宣称闭环完成，`consolidation` 必须保持
  `in_progress` 或由执行者 `block`。

上述内容是人工记录和评审契约，不是 `task:status` CLI 当前会自动校验的语义；CLI 也不会自动判断
“无适用项”“无增量”是否有充分证据。

审查导致实质变更时，使用 `rewind` 回退 `implementation`、`verification` 或 `consolidation` 的适当阶段，重新实施、验证和更新总结；不要保留过时的总结来表示新代码。

## CLI

在仓库根目录运行下列命令。除 `init` 外，以下是各 action 的独立用法示例，不是一组可按顺序整段执行的命令。所有命令都会打印 Task ID，非零退出表示校验或转换未通过；`complete` 与 `skip` 是同一进行中阶段的两种互斥终态。

```bash
node scripts/task-status.mjs init feature safe-login --date 2026-08-04
node scripts/task-status.mjs start 2026-08-04-safe-login implementation
node scripts/task-status.mjs complete 2026-08-04-safe-login implementation
node scripts/task-status.mjs skip 2026-08-04-safe-login implementation
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

在运行 `--ready-for-pr` 前，人工核对闭环记录是否完整：仓库扫描及外部 memory 无命中、`partial`、
`failed` 状态，逐条处置和角色来源/负责范围/最终分工、反馈边界、决策到实现/测试证据、范围变化
重检、Decision Delta 分类、正式落点和反向检索结果。反向检索失败时不得通过人工语义检查，
`consolidation` 必须保持
`in_progress` 或由执行者 `block`。CLI 只验证上述结构化文件和 stages，不会替代这些语义检查，
也不会自动判断或阻塞反向检索失败。若有 skipped stage，人工检查还必须确认 Decision Context、
Decision Delta 和反向检索记录仍完整；确无适用决策或无增量时，“无适用项”或“无增量”必须附有
检索、分类和验证证据，否则不得放行。

## 交付选择、合并与完成

实现与验证完成后必须先停下并询问用户选择：创建 PR、本地整合到 `main`，或暂不处理。选择不等于授权
外部写入；push、创建或更新 PR、本地整合分别需要明确授权。暂不处理时不改变远端事实，也不宣称
需求完成。

选择 PR 时，先确认要 push 的分支和 head，单独取得 push 授权；push 后核对 base/head，再单独取得
创建或更新 PR 的授权。只有实际存在 PR 后才能用 `set-pr` 记录正整数编号。PR 打开不代表完成；PR
路径仍须同时满足：内部 stages 终态、已记录 PR 号、GitHub 显示 merged、最新 head 的 required checks
成功，以及三份 Task 正式文件已在 `main`。合并 PR 仍需另行明确授权。`pullRequest: null` 在尚未选
PR 或本地整合路径是有效状态，不是失败。

选择本地 `main` 时，先选择并确认 `fast-forward`、merge commit 或 squash，再针对确定的源分支和
head 取得独立整合授权，且不 push。整合前要求源/目标 worktree clean、目标为本地 `main`、记录
`origin/main...main` 的 ahead/behind，并完成只读冲突预检；若 `main` 落后远端，必须先请求单独同步
授权，不能自动 pull、rebase、stash 或 reset。冲突时停止并交还用户处理。`fast-forward` 仅在目标是
源祖先时可用，使用 `git merge --ff-only <source-branch>` 且不提供新的提交标题；merge commit 必须
使用非快进策略并显式提供合法中文标题，例如 `git merge --no-ff -m "[Feature] 合并安全登录" <source-branch>`；
squash 使用 `git merge --squash <source-branch>` 后再以合法中文标题执行 `git commit -m "[Feature] 添加安全登录"`。
三种策略都要记录源 head；merge commit 和 squash 还要记录整合前后 `main` head。

本地路径的完成定义是：内部 stages 终态，`task.md`、`status.json`、`summary.md` 和交付变更都已在
本地 `main`，且 `main` clean；此时 `pullRequest` 保持 `null`。这不代表远端 `main` 已更新。只有对应
路径的事实全部成立后，才可归档 Codex 会话。

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

## 决策上下文与处置

新建 Task 必须记录 Decision Context、仓库扫描、候选及确认后的 owner/reviewer/approver、角色来源
和负责范围、逐条决策处置、角色反馈、证据和人工确认项；确无适用决策时明确记录“无适用项”及
检索证据。
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

## 相关正式文档

链接本 Task 产生或依赖、需要长期保留的设计、guide、ADR 等正式文档；没有时明确写“无”。

## 决策闭环收口

收口时必须记录 Decision Delta 分类、各项正式落点，以及反向检索的查询、命中结果和未决缺口；
确无决策增量时明确记录“无增量”及分类和反向检索验证证据。
```
