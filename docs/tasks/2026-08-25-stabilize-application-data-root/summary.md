# 稳定 Application Data Root 并恢复 Harness 会话总结

## 最终结论

Task 已实现并验证：Web 正式与开发入口统一使用 `~/.harbors`，项目内两个 legacy Server DB 已非破坏地合并，Plugin owner 存储不再落入源码树，Harness Agent 的 4 条旧会话已导入并在真实 Web 页面可见。独立代码复审 blocking 为 0，源数据库和旧 Agent JSONL 均保留且校验和未变。

## 需求完成情况

- 完成统一 application data resolver：Server DB、Kit config 与 Plugin roots 均由 Web 宿主解析，cwd、checkout 和 worktree 不再决定正式数据位置。
- 完成 `.data/harbors.db` 与 `packages/server/.editor.db` 的 WAL 一致性快照、当前 schema 校验、目标优先合并、并发锁和 no-overwrite 原子发布。
- 完成旧 Plugin persistent data 的安全迁移；cache/temp 不导入，target root、owner 和递归中间目录的 symlink 均 fail closed。
- 完成 Kit owner-scoped legacy grant，并贯通 repository descriptor、普通 Session Plugin 和 startup Application Plugin；Harness 仅向 `agent` 授予 `pi-agent`。
- 完成 Agent active JSONL 导入：校验 UUID、header ID 和完整 JSONL，忽略 trash，尊重目标与 tombstone，原子且幂等，源文件保留。
- 完成 ADR、架构说明和开发指南修订。

## 主要改动

- Framework 新增稳定启动配置与 application data migration；两个启动入口在打开数据库前执行同一流程。
- Plugin inspection 新增稳定的 `storageOwnerKey` 诊断字段。
- Kit repository storage schema 新增 `legacyPluginDataDirectories`，并对未声明 owner、非法目录和原型链名称做安全处理。
- Harness Agent adapter 增加一次性 initialization、legacy importer 和带 FileHandle heartbeat 的 session lock。
- 新增 Server migration、catalog、Kit 装配、Plugin owner 和 Agent importer 回归测试；迁移并发测试使用两个真实 Node 进程。

## 关键决定

### Decision Delta

| 分类 | 变化或决定 | 证据来源 | 影响范围 | 状态与落点 | 反向检索 |
| --- | --- | --- | --- | --- | --- |
| ADR | 正式运行数据统一位于用户级 `~/.harbors`，checkout/worktree 不拥有正式数据 | 用户明确批准、本 Task 实现与真实迁移 | Web Server、Kit config、Plugin storage | 已批准；修订 `docs/decisions/0002-web-only-host.md` | 仓库检索可从 `~/.harbors`、`.editor.db`、worktree 命中 ADR 与架构文档 |
| architecture | Plugin legacy 路径由 Kit 按 owner 最小授权，普通与 startup Plugin 使用同一契约 | 独立复审与 41 项定向测试 | Kit Core、Server Editor、Application catalog | 已验证；写入 Plugin runtime model | 从 `legacyPluginDataDirectories` 可命中 schema、runtime 和开发指南 |
| guide | `DB_PATH` 只覆盖 Server DB；Plugin roots 需显式绝对路径覆盖 | resolver 测试与两个入口实现 | 开发、运维、测试 | 已验证；写入开发工作流和 Plugin/Kit 指南 | 从 `DB_PATH`、Plugin root 可命中 runtime flow 与 guide |
| Task-only | legacy DB/Plugin/Agent 数据只导入目标缺失项，源文件不自动清理 | 用户范围、迁移实现、真实数据校验 | 本次升级与回滚 | 已完成；保留在 Task 与迁移日志 | 从 legacy DB 名称与 `pi-agent` 可命中 Task 和正式迁移说明 |
| candidate | 是否新增 `globalData/projectData` 与 project identity | 早期架构讨论，本 Task 明确非目标 | 未来 Plugin storage API | 待 approver 决定；未写成现行 API | 当前正式文档只声明 owner 私有根，没有伪装为已决定能力 |

已再次查询批准决策记忆，结果仍为无命中、`freshness=partial`、`failed_files=1`；因此反向验证以仓库正式 ADR、architecture、guide 和实现检索为准，没有把外部记忆缺失解释为已有批准。

## 验证结果

- Server 全量：62 个文件、771 项测试全部通过。
- Harness：unit 256/256、Plugin runtime 1/1、assembly 6/6、Web Host smoke 通过、`kits:check harness` 通过。
- Plugin：typecheck 与 33/33 测试通过；Kit Core repository 23/23；repository-kits 21/21；preflight、Kit architecture boundary 通过。
- 独立代码复审：最终 blocking 0；首份 source schema、DB 临时文件、目标目录 symlink、owner grant 全链路问题均已关闭。
- 真实数据：目标 Server DB 包含两个 legacy DB 的 63 个不重复 session，8 个旧设备授权和原 credential profile 均可读取；Harness 目标 owner 目录包含 4 个 active JSONL。浏览器加载后 credential profile 总数为 2，其中旧记录仍在；新增记录来自 Harness 已有配置/凭据激活链路，未覆盖旧值。
- 幂等性：Server 第二次启动报告 72 条已存在记录全部 skipped；Agent 第二次加载报告 4 条全部 skipped。
- 源数据：两个 legacy DB 与 4 个旧 Agent JSONL 的 SHA-256 在迁移前后不变；源码 Plugin legacy roots 未新增文件。
- Web 浏览器：1600×813 视口中 4 条旧对话、新建对话入口和 `13/13` Plugin 状态均可见；页面无横向或页面级纵向溢出，截图为 `/tmp/harbors-harness-final.png`。应用 console error 为 0。
- `git diff --check` 与 Task 普通检查通过；现有 `.codex/skills/delegate-codex-subagents/**` 用户修改未被本 Task 改动。

## 影响与风险

### blocking

- 无。

### non_blocking

- legacy Plugin source 根仍以最终组件 `lstat` 和文件 `O_NOFOLLOW` 为主；若 repository root 到 source 根的父级被替换为 symlink，可能从非预期位置只读导入。目标链已逐层校验，不会因此写出 application root。责任人：后续 Framework hardening Task；解除条件：以 repository root 为锚逐级固定 source 目录身份并增加替换竞态测试。
- application migration 的真实双进程竞争已覆盖，但“持锁进程异常退出后等待 stale 回收”尚无独立子进程用例。责任人：后续 Framework hardening Task；解除条件：加入 crash/stale recovery 测试。
- Chrome 对 6 个现有 Panel iframe 报告同一 sandbox warning（`allow-scripts` 与 `allow-same-origin` 组合），reload 后重复；没有 application error，且不是本 Task 引入。责任人：Web Host 安全维护；解除条件：明确 panel sandbox 威胁模型并调整属性或记录接受理由。

### decision_candidates

- 是否设计 `globalData/projectData`、共享数据层级与稳定 project identity；推荐另建架构 Task，不与本次兼容迁移耦合。
- 是否删除项目 `.data/harbors.db`、`packages/server/.editor.db`、旧 Plugin 目录和 `~/.harbors/pi-agent/sessions`；当前推荐继续保留，待明确备份期和回滚窗口后再决定。

## 偏差与遗留

- 计划中的浏览器验收原拟使用 Playwright persistent session，但当前会话没有 `js_repl`/Playwright 包；最终改用本机 Chrome DevTools Protocol 完成功能、console、视口和截图检查，没有修改项目依赖。
- `kit:boundary` 需要已提交的 base/head，不能对当前未提交的 `current` diff直接验收；本次使用已通过的 `kits:check harness`、assembly、Web smoke 和全仓 Kit architecture boundary 覆盖当前边界。
- 旧源数据按约束未自动删除；这不是迁移未完成。

## 后续关注

### follow_up

- 单独评审 Plugin shared/project storage scope，不在本 Task 追加隐式层级。
- 在明确回滚期后再建立 legacy data cleanup Task，删除前再次核对目标并集、备份和用户授权。
- 为 legacy source directory identity 与 migration stale-lock recovery 增加安全硬化测试。
- 单独处理或记录 Panel iframe sandbox warning 的安全决策。

## 相关正式文档

- `docs/decisions/0002-web-only-host.md`
- `docs/architecture/system-overview.md`
- `docs/architecture/runtime-flows.md`
- `docs/architecture/plugin-runtime-model.md`
- `docs/guides/developing-plugins-and-kits.md`
- `docs/guides/development-workflow.md`
- `docs/tasks/2026-08-25-stabilize-application-data-root/task.md`
