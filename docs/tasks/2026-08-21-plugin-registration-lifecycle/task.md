# 2026-08-21-plugin-registration-lifecycle

Task ID: `2026-08-21-plugin-registration-lifecycle`
Type: `refactor`

## Summary

统一 Session Plugin 与 Application Plugin 的生命周期语义，分离注册索引、manifest 加载信息和运行实例，修复 unload/reload、Application generation 重启以及注册态 manifest 快照不一致的问题。

## 背景与问题

当前 `PluginModule.register()` 会读取并解析 manifest，将 `PluginInfo`、贡献项、能力和入口保存到注册索引；`load()` 随后复用这份快照。这样 Register、Load 的职责混杂，manifest 在插件目录发生变化后可能继续使用旧信息，Unload 也无法明确清除所有加载态。

Session Editor 和 Application Runtime 还分别依赖“注册后即可读取完整 `PluginInfo`”的行为。Application Runtime 的父进程会预解析 manifest，Supervisor 的后续 generation 又可能复用旧的 `PreparedPlugin`，导致显式 reload、人工 retry 和子进程崩溃后的自动 recover 语义不一致。

## 目标

- `Register` 只维护注册索引：绝对路径、`kind` 和 `source`；不读取、不校验、不缓存 manifest，不执行插件代码，也不产生贡献。
- `Load` 从注册索引对应的路径读取并校验最新 manifest，解析入口、能力、assets 和 contributions，加载插件代码，执行 lifecycle，并挂载 Panel、Message、Menu 及其他 owner 资源。
- `Unload` 清除该插件的全部加载信息、实例、贡献、运行时句柄、credentials lease、generation 关联和缓存；保留注册索引。
- `Unregister` 删除注册索引及其临时读取状态；运行中的插件必须先完成 Unload。
- Session 与 Application 使用相同的状态转移、刷新、清理、失败和重试语义，仅通过进程内执行适配器和 Supervisor/子进程执行适配器承载不同执行边界。
- 每次显式 reload 都从索引重新读取最新 manifest 和 code，并创建新的 generation；Application 子进程崩溃后的自动 recover 恢复当前 generation 已冻结的 manifest、entry、contribute 和 capabilities，不读取可能处于半更新状态的磁盘文件。
- 显式 retry 必须明确选择语义：人工加载最新版本时走 reload/new generation；仅恢复当前代时走 recover，不读取磁盘 manifest。
- 对并发 Load、Unload、reload、retry 和 generation 替换进行串行化；旧 generation 的请求、snapshot 和 owner 清理完成前，新 generation 不得接管资源。

## 范围

- `packages/plugin` 的注册索引、manifest 读取、PluginInfo 生命周期、状态机、Load/Unload/Unregister API 和 credentials 生命周期。
- `packages/server` 的 Session Editor/Kit 装配、Panel/Message/Menu owner 清理、Application Runtime、Supervisor、Application plugin snapshot 和 generation 恢复。
- 插件 runtime facade 中注册态与加载态的 API 区分，以及依赖这些 API 的插件管理调用方。
- 对应的 Framework、Application、Plugin runtime、Panel asset、credentials、reload/retry 和失败清理测试。
- 生命周期架构说明、Task 调研记录和必要的中文 API/迁移文档。

## 非目标

- 不改变插件 manifest schema、贡献协议、消息 request/broadcast 语义或 Panel/Message/Menu 的业务协议。
- 不把 Application 插件改为在父进程执行；Application 仍通过 Supervisor 在独立子进程运行，统一的是生命周期语义而不是执行位置。
- 不新增 Electron、桌面打包、原生窗口生命周期、托盘、更新器或桌面 IPC 假设；Web 是唯一 Web 宿主。
- 不改变 Kit、Session、Application 的所有权边界，不把 Application 插件的 Panel、Window、Layout 或 browser message 能力放开。
- 不实现插件热更新文件监听、版本发布、安装器、远程下载或持久化插件市场。
- 不以保留注册态完整 manifest 快照的方式兼容旧 `getInfo` 语义；需要 manifest 的调用方必须使用显式 inspect/preflight 或加载态 API。

## 验收标准

1. Register 后仅能查询路径、kind、source 等注册索引；不会读取或校验 manifest，不执行入口，不挂载任何 Panel、Message、Menu、service 或 credentials 资源。
2. Load 每次读取并校验当前磁盘 manifest；manifest、入口、Panel entry、assets 或能力发生变化时，下一次 reload 使用新内容；无效 manifest 在代码执行和贡献挂载前失败。
3. Unload 后 `listLoaded()`、loaded `PluginInfo`、实例、贡献、owner 资源、credentials lease、缓存和 Application generation 关联均被清除，且注册索引仍存在；随后 Load 可重新读取最新 manifest。
4. Unregister 只允许作用于非运行插件，并删除路径注册索引及相关临时状态；Unregister 后不能通过注册查询或 Load 找到该路径。
5. Session 与 Application 对 `register → load → unload → unregister`、reload、失败清理、owner cleanup、重复调用和错误恢复具有一致的可观察语义；执行适配器仍分别保持进程内和 Supervisor/子进程边界。
6. 显式 reload/retry（最新版本语义）重新读取 manifest 和 code 并创建新的 generation；Application 子进程崩溃后的自动 recover 只恢复当前 generation 冻结的 manifest、entry、contribute 和 capabilities，不读取磁盘；旧 generation 的 pending command、snapshot 和 owner 清理完成后，新的 generation 才能启动。
7. 失败插件进入稳定的 `Failed`/`Quarantined` 状态后不会自动带着残留 owner 资源重启；人工 retry 必须明确选择 reload 或同代 recover，失败原因和清理失败可诊断且不污染健康插件。
8. 并发 Load/Unload/reload/retry 被串行化；credentials 操作在 revoke-and-drain 完成前不能让新 generation 接管同一 owner；重复 Unload、Unregister 和恢复请求具有幂等或稳定错误结果。
9. 依赖注册态 manifest 的 Session/Application/plugin 管理调用方迁移到明确的 registration、inspect 或 loaded-info API；Panel、Message、Menu、assets 和 credentials 回归测试覆盖新旧边界。
10. 目标 Plugin、Framework、Server/Application 测试按变更边界通过；Kit 装配或共享可见行为受影响时完成 Web 浏览器验收；不以桌面宿主作为验收目标。

## 约束

- 保持当前工作区其他改动，不覆盖、回退或清理无关文件；本轮允许直接写入当前分支，不创建新的分支或 worktree。
- 不修改 `docs/tasks/2026-08-21-plugin-registration-lifecycle/status.json`、`summary.md` 或本 Task 指定范围之外的文件。
- 正式 API 必须区分注册索引、显式 manifest inspect/preflight 和 Loaded PluginInfo，避免把临时读取结果伪装成注册状态。
- Application 父进程不得为了复用 Session Load 而导入 Application 插件；共享代码限于 manifest/schema、状态/事务契约和可验证的生命周期协调逻辑。
- generation 替换必须遵循旧进程终止、pending command drain、owner cleanup、lifecycle detach 和 snapshot 收敛顺序；清理失败不得静默吞掉并启动新 generation。
- credentials lease 必须按本次 Load 实际解析出的插件身份和 capabilities 绑定，并在 Unload/recover 之间 revoke-and-drain；错误、日志和 fixture 不包含 token、cookie、密钥或连接串。
- 提交信息若后续授权提交，使用 `[Refactor] 统一插件注册与加载生命周期`，末尾不加句号。

## 需求变更

本 Task 已按用户确认从“检查 Preview manifest 刷新”扩大为统一 Session/Application 插件生命周期语义；保留不同执行适配器和 Web-only 宿主约束，新增 generation、串行化、drain、owner cleanup、Failed/Quarantined、显式 reload 与 recover 的验收要求。当前分支直写已获授权，不创建独立 worktree，不提交。
