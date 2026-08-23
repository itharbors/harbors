# Web 开发命令收敛验收总结

## 最终结论

第一版 Web 开发命令收敛已完成。`pnpm dev` 直接启动唯一 Web 开发栈，`dev:web` 已移除；`pnpm start` 和既有 `--kit` 行为保持不变。

## 需求完成情况

- 根 `dev` script 直接执行 `node scripts/dev.mjs`。
- 删除 `dev:web` script，并将当前有效帮助、源码和文档中的开发入口统一为 `pnpm dev`。
- 保留稳定 Web Server 入口 `pnpm start` 及 `pnpm dev -- --kit <name-or-path>` 参数转发。
- 未新增或删除 Server 能力，未引入 Electron 或桌面宿主假设。

## 主要改动

- 更新根 package scripts 的 Web 开发入口契约。
- 更新 `scripts/dev.mjs` 帮助示例和相关命令测试。
- 更新 README、开发/测试/架构指南中的当前有效命令示例。
- 完成本 Task 的需求、设计、状态和验收记录。

## 关键决定

- `scripts/dev.mjs` 继续作为唯一 Web 开发启动实现，不复制启动编排逻辑。
- `pnpm start` 继续表示稳定 Web Server 启动，不与开发入口合并。
- 历史设计记录不作批量迁移；仅同步当前有效的命令帮助、文档和测试契约。

## 验证结果

- `pnpm install --offline --frozen-lockfile` 完成。
- 全新 worktree 缺少构建产物，补建 workspace 包后执行 `pnpm build` 成功。
- `pnpm dev -- --help` 通过。
- `node --test scripts/lib/pnpm-spawn.test.mjs`：4/4 通过。
- `node --test scripts/lib/runtime-ports.test.mjs`：2/2 通过。
- package scripts 契约检查通过：`dev` 直接执行 `node scripts/dev.mjs`，`dev:web` 不存在，`start` 保持 `tsx packages/server/src/start.ts`。
- 有效源码和文档扫描未发现 `dev:web` 或 `pnpm run dev`。
- `pnpm dev` 成功启动 Vite、Gateway、Server；访问 `/` 成功，`/api/health` 返回 `ok`。
- `git diff --check main...HEAD` 通过。
- Task ready-for-pr gate 通过。

## 影响与风险

开发者只需记忆 `pnpm dev` 作为 Web 开发和浏览器验收入口，稳定运行仍使用 `pnpm start`。删除 `dev:web` 可能影响依赖旧命令的本地脚本，但当前有效源码、文档和测试已完成迁移；历史设计记录保留其历史语境。

## 偏差与遗留

以下是未修改的本地 `main` 上复现的既有基线失败，不由本 Task 引入：

- `kit-docs.test.mjs`：9/10 通过，失败因缺少 `kits/agent-chat/README.md`。
- `test:preflight`：`kits/agent-chat/tests/assembly.test.ts` 有三项 `KIT_LOCAL_DEPENDENCY_ESCAPE` 失败。

这些问题不在本 Task 范围内，未作修复或状态掩盖。

## 后续关注

后续若需要重新设计 Server 能力、外部 Kit 能力或历史设计文档迁移，应另建 Task，避免扩大本命令收敛任务的范围。

## 相关正式文档

- [Task 需求与设计](task.md)
- [Task 状态](status.json)
