# Harness Kit 走查问题修复总结

## 最终结论

本 Task 已修复 Harness Settings 菜单缺少 request route、Kit 门禁漏跑 Plugin 并置测试、Conversation/Chat Panel 缺少 React Root 卸载与状态清理三个问题。实现、代码审查、完整 Kit check、Web smoke 和浏览器验收均已完成，没有 blocking。

## 需求完成情况

| 验收项 | 结果 | 证据/说明 |
| --- | --- | --- |
| Settings 菜单使用正式消息路由 | 已完成 | manifest 声明 `openSettingsPanel`；assembly 串联验证菜单 message、request route、handler 和 `settings.settings` 打开结果 |
| Kit 门禁覆盖全部 Plugin 并置测试 | 已完成 | `test:kit` 新增 `test:unit`；当前发现 37 个适用测试文件，共 254 tests 通过，runtime smoke 仍独立执行 |
| Conversation/Chat Panel 对称卸载 | 已完成 | 两个 Panel 保存并卸载 React Root、清空 setter；Chat 的 selected、trace、catalog 缓存通过纯事件桥接模块统一 reset |
| 生命周期回归测试 | 已完成 | Conversation 与 Chat 覆盖 double unmount、重挂载和全局/JSDOM 恢复；Chat 三类缓存分别验证 reset 后不重放 |
| Kit 分层验证和浏览器验收 | 已完成 | runtime smoke 1 test、assembly 6 tests、`kits:check harness`、boundary、Web smoke 和浏览器 13/13 Plugin 验收通过 |
| diff 与 Task 门禁 | 已完成 | `git diff --check` 通过；Task 变更位于 `kits/harness/**` 和本 Task 档案，用户已有 Skill 修改未纳入 |

## 主要改动

1. 在 Settings Plugin manifest 中注册 `openSettingsPanel` request，并用真实 Kit assembly 验证菜单到 Panel 的完整链路。
2. 为 Harness 新增 `test:unit`/`test:unit:run`，从仓库根使用现有 tsx runner 发现 main、panel 和 Plugin 根的并置测试；`test:kit` 现在按 validate → unit/component → runtime smoke → assembly 执行。
3. Conversation 与 Chat Panel 保存 React Root，mount 前清理旧实例，提供幂等 unmount，并清除模块级 setter。
4. 将 Chat 的事件 setter 与 selected/trace/catalog 缓存抽到 `panel-event-bridge`，通过纯单元测试证明首次重放和 reset 后隔离。
5. 修复 assembly 对异步 `agent.message.status` 的竞态：使用已有轮询辅助等待广播终态，临时安装目录和连续两次定向运行均稳定通过。

## 关键决定

- Settings 继续通过既有 `settings.openSettingsPanel` 定向 request 打开 Panel，不绕过消息系统，也不改变消息名称。
- Plugin 并置测试纳入 Kit 门禁，但 runtime smoke、assembly 和 Web smoke 继续保持各自独立的测试层级。
- Panel 卸载同时负责 React Root、setter 和挂载间缓存边界；Chat 缓存状态由纯桥接模块管理，以便独立验证。
- 当前工作区模式为 `current`，用户授权在本地 `main` 形成一个 `[Bug]` commit；不创建分支、worktree、PR 或远端写入。

## 验证结果

- `pnpm --dir kits/harness run test:unit`：37 个文件、254 tests passed。
- `pnpm --dir kits/harness run test:kit`：254 个 unit/component、1 个 runtime smoke、6 个 assembly tests passed。
- `pnpm --dir kits/harness run test:assembly && pnpm --dir kits/harness run test:assembly`：连续两轮各 6 tests passed，用于重验异步广播竞态。
- `pnpm run kits:check harness`：`KIT=harness STATUS=passed`，包含临时安装、build、test、validate 和 Web smoke。
- `pnpm run kits:boundary`：`KIT_ARCHITECTURE_BOUNDARY_OK scope=all`。
- `git diff --check`：通过。
- 唯一 Web 宿主浏览器验收：Harness 13/13 Plugin 加载；Settings 显示 1 panel、2 requests、1 broadcast；工作台核心 Panel 可见；console warning/error 为空。

## 影响与风险

- `test:kit` 会比以前耗时更长，因为现在真实执行全部 Plugin 并置测试并在测试前构建当前 Kit；这是门禁可信度提升带来的预期成本。
- assembly 运行时偶尔打印 Agent 会话临时锁文件已清理的 stderr 日志，但测试结果和 `kits:check` 均通过；本 Task 未改变该既有 Agent 存储行为。
- 权威测试指南仍将 Harness `test:kit` 描述为只包含 validate、runtime smoke 和 assembly，尚未写入新增 `test:unit`。根据 Kit 文件夹外修改需先确认的仓库边界，本 Task 没有越界改写该指南。

## 偏差与遗留

- 初始代码审查认为 Chat DOM 空态断言不能分别证明 trace/catalog 缓存清理；随后抽出纯 `panel-event-bridge` 并补充逐项测试，blocking 已解除。
- `kits:check` 首轮暴露 `agent.message.status` 广播读取竞态；改用等待终态后，定向连续两轮及完整 check 均通过。
- 浏览器自动化确认 Settings 入口与 Plugin route 数量，但跨 iframe 的设置按钮点击定位超时；真实 request/handler 终点由 assembly 覆盖，浏览器控制台保持干净。

## 后续关注

- 在获准修改 Kit 外正式指南时，同步 `docs/guides/testing.md` 中 Harness `test:kit` 的命令语义。
- 若 Agent assembly 的临时锁 stderr 日志频率上升，应另建 Agent 存储生命周期 Task 排查；当前不影响本次门禁。

## 相关正式文档

- [Task 定义](task.md)
- [测试指南](../../guides/testing.md)
- [Harness Kit assembly 架构说明](../../architecture/harness-kit-assembly.md)
- [开发工作流指南](../../guides/development-workflow.md)

## 决策闭环收口

### Decision Delta

- `Task-only`：Settings manifest、Plugin 测试门禁和 Panel 生命周期实现恢复到既有消息、Kit 边界与测试分层约束；没有新增长期产品、架构、安全、迁移或治理决定。
- `guide` 候选：Harness `test:kit` 已包含 `test:unit`，测试指南需要在获得 Kit 外修改授权后同步；当前保持 follow-up，不冒充已发布正式规则。

### 正式落点与反向检索验证

- 实现事实落在 `kits/harness/package.json`、Settings manifest、Conversation/Chat Panel 源码和对应测试。
- 反向检索使用 `openSettingsPanel`、`test:unit`、`createPanelEventBridge`、`unmount` 和 `Harbors Harness`；可从 Kit manifest、package scripts、实现与测试定位本次行为。
- 既有正式约束继续来自测试指南、Harness assembly 架构说明和开发工作流；本 Task 未新增 ADR，也无待批准架构候选。

### blocking

- 无。

### non_blocking

- `docs/guides/testing.md` 的 Harness `test:kit` 描述尚未包含新增 unit/component 阶段。
- assembly 的既有 Agent 临时锁清理可能输出 stderr，但所有要求的验证均通过。

### decision_candidates

- 无。

### follow_up

- 同步测试指南的 Harness `test:kit` 命令语义；owner：Harness/文档维护者；触发条件：用户批准修改 Kit 文件夹外正式指南或建立独立 Docs Task。
- 观察 assembly 临时锁 stderr；owner：Agent Plugin 维护者；触发条件：日志导致测试失败或出现实际数据/生命周期回归。
