# 2026-08-23-unified-dev-command

Task ID: `2026-08-23-unified-dev-command`
Type: `chore`

## 背景与问题

当前 `pnpm dev` 通过 npm script `dev:web` 间接启动 `scripts/dev.mjs`，仓库帮助、现行指南和测试中也同时出现两个 Web 开发命令。Harbors 只支持 Web 宿主，这种双入口会让开发、浏览器验收和命令契约产生不必要的分叉。稳定入口 `pnpm start` 与 Web 开发栈的职责不同，应继续保留并保持现有行为。

## 目标

- 让 `pnpm dev` 直接运行唯一的 Web 开发栈启动器 `scripts/dev.mjs`。
- 删除 npm script `dev:web`，使 `pnpm dev` 成为 Web 开发、调试和浏览器验收的唯一命令入口。
- 同步当前有效的启动帮助、开发指南、测试契约和 README，消除对 `dev:web` 的现行用法依赖。
- 保留 `pnpm start` 的稳定 Web Server 入口，以及现有 `pnpm dev -- --kit <name-or-path>` 参数转发和 Kit 行为。

## 范围

- 根 `package.json` 的 `dev`/`dev:web` script 契约。
- `scripts/dev.mjs` 的当前命令帮助和用法示例，以及直接启动所需的最小测试契约调整。
- README、开发/测试/架构指南中描述当前启动方式的有效内容；历史设计记录不作批量改写，除非其内容被现行契约测试消费。
- 覆盖默认 Web 启动和 `--kit` 参数转发的聚焦测试，以及本 Task 的需求、状态和设计记录。

## 非目标

- 不新增或删除 Server 能力，不改变 Gateway、Server、Client、端口、构建或运行时逻辑。
- 不改变 `pnpm start`、Kit 发现/装配、`--kit` 解析、指定 Kit 直达或其他现有开发行为。
- 不引入 Electron、桌面窗口、原生生命周期、托盘、更新器或桌面 IPC 假设。
- 不保留 `dev:web` 兼容别名，不借机收敛其他启动命令，也不实现外部 Kit 能力。
- 不进行与本命令契约无关的 UI、插件、Framework、Server、测试重构或历史文档大范围迁移。

## 验收标准

- `package.json` 中 `dev` 直接执行 `node scripts/dev.mjs`，且不存在 `dev:web` script；`pnpm dev` 能启动现有 Gateway、Server、Client Web 开发栈。
- `pnpm dev -- --kit <name-or-path>` 仍将参数传给同一启动器，并保持现有指定 Kit 行为；`pnpm start` 的脚本和值保持不变。
- 当前启动帮助、README、开发/测试/架构指南不再把 `pnpm run dev:web` 作为有效入口，统一说明 `pnpm dev`；相关测试断言与实际契约一致。
- 聚焦的启动器/命令契约测试通过，`pnpm dev` 在 Web 浏览器中可访问现有开发页面；不得以新增或修改 Server 能力作为通过条件。
- `pnpm run task:status check 2026-08-23-unified-dev-command` 与 `git diff --check` 通过。

## 约束

- 本 Task 第一版只收敛启动命令；如发现需要新增 Server 或 Kit 能力，应停止并另建需求，不在本 Task 扩 scope。
- 设计以 `scripts/dev.mjs` 为唯一 Web 启动实现，`package.json` 只提供 `dev` 这一面向使用者的开发脚本；不得通过第二个 alias 恢复旧入口。
- 只支持 Web 宿主，涉及启动可见行为时按仓库规则使用浏览器验收。
- 所有 Task 状态变更通过 `pnpm run task:status` CLI 完成；`status.json` 只记录结构化阶段事实，设计理由和交接信息写入本文件或默认不提交的 `.work/`。
- 本次建档允许提交的正式文件仅为本 Task 目录下的 `task.md` 与 `status.json`；不修改实现、测试或其他正式文档。
- 提交标题使用 `[Chore] 收敛 Web 开发启动命令`，不以句号结尾；不 merge、push、创建 PR、rebase、stash 或删除 worktree。

## 设计摘要

1. 将根 `dev` script 的命令值改为 `node scripts/dev.mjs`，删除 `dev:web` script；不复制启动逻辑，也不改变启动器内部的 Server/Gateway/Client 编排。
2. 将帮助和现行文档中的开发命令统一为 `pnpm dev`，Kit 示例统一使用 `pnpm dev -- --kit ...`；稳定运行说明继续使用 `pnpm start`。
3. 测试只锁定命令入口、帮助文本和参数转发契约，验证现有 Web 栈可启动；不借此扩展 Server 或 Kit 业务测试。

## 需求变更

本 Task 将第一版范围限定为启动命令收敛：`pnpm dev` 直接运行唯一 Web 开发栈，删除 `dev:web`，保留 `pnpm start` 和现有 `--kit` 行为，并同步当前有效的帮助、文档和测试。外部 Kit 能力与 Server 能力均不在本 Task 内新增或删除。

## 实际结果

- 完成 `pnpm install --offline --frozen-lockfile`。由于全新 worktree 缺少构建产物，先补建 workspace 包并执行 `pnpm build`，构建成功。
- `pnpm dev -- --help` 通过，帮助统一展示 `pnpm dev` 及 `pnpm dev -- --kit ...`。
- `node --test scripts/lib/pnpm-spawn.test.mjs`：4/4 通过。
- `node --test scripts/lib/runtime-ports.test.mjs`：2/2 通过。
- package scripts 契约检查通过：`dev` 直接执行 `node scripts/dev.mjs`，`dev:web` 不存在，`start` 保持 `tsx packages/server/src/start.ts`。
- 有效源码和文档扫描未发现 `dev:web` 或 `pnpm run dev`；历史设计记录与 Task 档案不属于当前有效命令契约。
- `pnpm dev` 成功启动 Vite、Gateway、Server；访问 `/` 成功，`/api/health` 返回 `ok`。
- `git diff --check main...HEAD` 通过。

以下两项是在未修改的本地 `main` 上复现的既有基线失败，不由本 Task 引入：

- `kit-docs.test.mjs`：9/10 通过，剩余失败因缺少 `kits/agent-chat/README.md`。
- `test:preflight`：`kits/agent-chat/tests/assembly.test.ts` 有三项 `KIT_LOCAL_DEPENDENCY_ESCAPE` 失败。
