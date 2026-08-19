# 2026-08-19-kit-config-layers 总结

## 最终结论

配置层的声明权已经从 Framework 与业务 Plugin 迁移到 Kit。Kit 在 `kit.json` 中声明逻辑层和抽象 storage，Web 宿主把 `application-data` 解析为 `~/.harbors`，Framework 只消费宿主创建的配置 backend。

## 需求完成情况

- Kit manifest 已支持 `config.schemaVersion/defaultsLayer/writeLayer/layers`。
- default Kit 与 Agent Chat Kit 已声明内存 default 层和 SQLite global 层。
- project 层已从 Agent Chat Settings schema、运行时和界面移除。
- Plugin 公开配置 API 已移除 `registerTypes`。
- global 配置按 Kit ID 和 layer 持久化；default 配置只驻留当前 Editor 内存。
- Kit 切换支持配置 activate/deactivate 的 commit/rollback。
- 模型服务、凭据与 DSH 迁移均未纳入本次实现。

## 主要改动

- `packages/kit-core` 增加 Kit 配置声明类型、严格 schema 和路径安全校验。
- `packages/server/src/framework/config` 改为抽象 backend 注入模型。
- `packages/server/src/config-storage` 增加内存/SQLite backend 装配和 Kit namespace。
- Server/App/Editor 增加宿主 storage root 注入和 Kit 配置生命周期。
- Agent Chat Settings 只保留 default/global 读取与 global 用户覆盖。
- 新增正式架构文档 `docs/architecture/kit-configuration-model.md`。

## 关键决定

- manifest 只允许 `root: application-data` 和安全相对路径，不允许 Kit 写绝对路径。
- 正式 Web 入口将 application-data 映射到用户主目录的 `.harbors`，Framework 不感知该物理路径。
- SQLite 主键为 `(kit_id, layer_name, key)`，Kit 版本不参与 namespace，确保同一 Kit 跨版本继续使用 global 配置。
- 未声明 config 的兼容 Kit 会使配置模块 deactivate，而不是继承上一 Kit 的层。
- `get/set/delete` 暂保留显式层参数，供 Settings 注入 default；后续模型与凭据设计不在本 Task 中展开。

## 验证结果

- Kit Core TypeScript build：通过。
- Kit Core schema：56 个测试通过（通过 Server 已安装的 Vitest 执行）。
- Server typecheck：通过。
- Framework config、config-storage、Editor、start-config、server lifecycle：69 个测试通过。
- Agent Chat Settings：4 个测试通过；Settings 与 Agent Plugin check 通过。
- default 与 agent-chat Kit validate：通过。
- Web 浏览器验收：Settings 只显示全局保存层和默认值来源，无 project 层；控制台无错误。
- `git diff --check`：通过。

## 影响与风险

- 首次加载带持久化层的 Kit 会在 `~/.harbors/config.sqlite` 创建配置表。
- Plugin 不能再自行注册层；依赖旧 `registerTypes` 的 Plugin 必须改由所属 Kit 声明层。
- 显式层参数仍允许 Settings 写入 default，后续若引入更严格的默认值 contribution host，应进一步收紧该能力。

## 偏差与遗留

- `pnpm --filter @itharbors/kit-core run test` 因该 package 未安装自身的 Vitest 可执行文件而无法直接启动；相同 56 个 schema 测试已通过 Server workspace 的 Vitest 完成。
- 根脚本 `pnpm run kit:check` 未传 `scripts/check-kit.mjs` 要求的 Kit slug/output 参数，因此在所有 TypeScript build 通过后退出；两个目标 Kit 已分别执行 validate 并通过。
- `tests/integration/integration.test.ts` 仍有 3 个既有失败：显式 Kit runtime 使用 `${sessionId}::${kit}` 存入 editorMap，而 bootstrap/window 路由按裸 sessionId 查询。本次没有扩大范围修改 SessionRuntimeRegistry 路由设计。

## 后续关注

- 单独讨论通用模型服务、Relay/Token 中转站配置 schema。
- Token 的 Profile ID 可进入 `ctx.config`，真实 Token 继续由 `ctx.credentials` 保存。
- 若收紧显式层写入，需要先把 Settings 默认值注入迁移为宿主内部能力。

## 相关正式文档

- `docs/architecture/kit-configuration-model.md`
- `docs/tasks/2026-08-19-kit-config-layers/task.md`
