# 插件注册与加载生命周期收口

## 结果

本 Task 已完成 Session Plugin 与 Application Plugin 的注册、预检、加载、卸载、重试和
generation 生命周期收口。注册索引现在只保存绝对路径、`kind`、`source`；manifest 由显式
`inspect()` 读取，`load()` 每次从磁盘读取并校验最新内容，Loaded PluginInfo 与注册态分离。

## 需求完成情况

验收目标已覆盖：注册不读 manifest、load-time 最新 manifest、unload/unregister 清理、
Session/Application 边界、显式 retry reload、自动 recover 冻结快照、generation 串行、owner
清理、credentials revoke-and-drain，以及失败和重试路径。

## 主要改动

- `packages/plugin`
  - 新增 `PluginRegistration`、`inspect()`、`getRegistration()` API。
  - `register()` 不再读取 manifest、执行入口或校验贡献；`getInfo()` 只返回已加载实例信息。
  - Load/Unload 通过统一串行队列；并发操作、加载中 unregister 有稳定边界。
  - Load 失败、Unload、Unregister 清理实例、credentials lease、owner 资源和 CommonJS 缓存；
    credentials 按实际加载 manifest 的 capability 创建并 revoke-and-drain。
- `packages/server`
  - Session Editor 迁移到显式 inspect，并提供 host owner cleanup。
  - Application prepare 使用 inspect；显式 retry 先刷新 manifest 与 entry，再创建新 generation；
    自动 recover 继续复用当前准备好的冻结快照。
  - generation 初始化 payload 改为动态读取当前 prepared snapshot；Application runner 的
    `getInfo()` 仅暴露 loaded info，并支持 registration 查询。
  - Application dispose 删除临时 manifest 注册；生命周期 detach 继续通过有序 transition 队列
    保证旧代清理与新代 attach 顺序。
- 架构文档和 Plugin/Server 回归测试已迁移到新的 registration/inspect/loaded-info 边界。

## 关键决定

- registration index 不保存 manifest 快照；所有 manifest 依赖显式走 inspect 或 load。
- Application 显式 retry 采用 reload/new generation，子进程故障自动恢复采用当前代冻结快照。
- 继续保持 Web-only 宿主和 Application 插件独立子进程边界。

## 验证结果

- `pnpm --filter @itharbors/magnet run test`：33 tests passed
- `pnpm --filter @itharbors/server run typecheck`：passed
- Plugin/Server 关键生命周期、Application process、Supervisor、retry、runner、credentials
  回归：217 tests passed
- `pnpm run test:toolchain`：passed，完成受影响 workspace 构建及内置插件构建
- `git diff --check`：passed

Server 全量测试中，除上述针对性集合外存在若干既有 integration/editor fixture 失败；它们不
涉及本次生命周期断言，关键生命周期集合已单独重复通过。未进行 Web 浏览器验收，因为本次
改动没有 Kit 装配或共享可见 UI 行为变化。

## 影响与风险

改动仅覆盖 `packages/plugin`、`packages/server`、直接相关测试、Plugin 生命周期架构文档及本
Task 文档；未修改 kits 或 plugins 业务实现，也未引入桌面宿主假设。保留 `getInfo()` 的加载态
语义后，依赖注册态 manifest 的调用方必须继续使用 `inspect()`；旧调用方若将注册视为已加载，
会得到稳定的 undefined，需要按新 API 迁移。

## 偏差与遗留

Server 全量测试中存在若干 integration/editor fixture 失败，本次未扩大范围处理；受影响的
Plugin、Framework 生命周期和 Application process 关键集合已重复通过。

## 后续关注

后续若要恢复全量 Server 绿灯，应单独定位 integration/editor fixture 的环境或测试隔离问题；
不应重新把 manifest 读取放回 register。

## 相关正式文档

- `docs/architecture/plugin-runtime-model.md`
- `docs/tasks/2026-08-21-plugin-registration-lifecycle/task.md`

## 最终结论

实现、针对性验证和本地收口材料已完成；当前分支可供后续本地 squash merge。
