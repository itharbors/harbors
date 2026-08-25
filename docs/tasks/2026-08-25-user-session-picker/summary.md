# 工作台用户与 Session 选择交付摘要

## 最终结论

Framework 已建立最小的 `User 1:N Session 1:N Kit runtime` 模型。授权设备绑定稳定用户，Session 持久化 owner；本地管理入口可以选择用户、继续既有 Session 或新建 Session，远程设备只能访问所属用户的 Session。该能力隔离的是身份、消息路由和 Editor runtime，不把 Session 宣称为 Project 安全边界。

## 需求完成情况

- 用户使用 Server 生成的 opaque `userId`，显示名可编辑且允许重名。
- 设备授权可以创建或绑定用户，授权状态返回公开用户摘要。
- Session 保存 `ownerUserId`，工作台 API 支持按当前用户列出和创建 Session。
- 本地管理入口可切换用户；远程设备固定为授权绑定用户，统一访问策略覆盖 Session、bootstrap、SSE、消息、菜单、窗口、面板与本地 Web 文件路由。
- 工作台入口提供“用户 → Session → Kit”流程；切换用户会清除旧 Session，选择或新建 Session 后地址栏与 Kit 链接同步更新。
- 旧授权设备和 ownerless Session 采用非破坏兼容策略保留，并提供本地认领入口。
- 数据库迁移对已知旧 schema 做幂等升级；未知 schema 失败关闭，发布竞争发生时会重新预检实际目标后再写入。

## 主要改动

- Server 新增用户存储、工作台上下文 API、Session owner 与统一访问策略。
- Gateway 覆盖客户端提供的 forwarded header，只把真实入站 socket 地址传给 Server；Server 仅在立即上游为 loopback 时信任该单值合法 IP。
- Client 增加授权显示名输入、用户/Session 选择器、创建、重命名、认领和错误/空状态。
- plugin-types 增加工作台用户与 Session 公开协议。
- 补齐身份访问矩阵、迁移原子性、Session 路由、Client 入口与交互回归测试。
- 更新 Kit/Session 模型和系统概览文档。
- 修正隔离 Web Host 的 Plugin 存储根，使 data/cache/temp 严格位于 applicationData 下并可启动真实 Kit runtime。

## 关键决定

- `displayName` 只用于展示；安全寻址使用不可猜测的 `userId` 与 `sessionId`。
- Session owner 由 Server 权威持久化和校验，不信任远程 Client 提交的任意用户身份。
- 本地主机管理者可以选择用户；远程设备的用户由授权绑定决定，不能在入口切换身份。
- 每个 Kit runtime 继续拥有独立 Editor；同一 Session 可以拥有多个 Kit runtime，但不新增第二份 Editor registry。
- ownerless 历史 Session 不自动归属任意远程用户，仅由本地管理入口显式认领。
- 不引入 Project、SSO、多人协同、编辑锁或 Electron/桌面宿主假设。

## 验证结果

- `pnpm --filter @itharbors/gateway test`：3 files、20 tests 通过，包含真实 HTTP 代理 hop。
- `pnpm --filter @itharbors/server test`：65 files、783 tests 通过。
- `pnpm --filter @itharbors/client test`：33 files、289 tests 通过。
- Gateway、Server、Client typecheck 通过；`@itharbors/plugin-types` build 通过。
- `node --test scripts/lib/web-host-runner.test.mjs`：4 tests 通过。
- `git diff --check` 通过；独立验证确认 diff 只涉及 Framework Gateway/Client/Server、协议、Web Host 验收辅助、两份架构文档和本 Task。
- 浏览器验证通过：用户选择、新建 Session、地址栏同步、Kit 链接携带 Session、切换用户清除旧 Session、切回用户复用已有 Session，以及空状态/禁用状态均符合预期。
- 真实 Gateway/Server/Client 三进程 Web Host 中，浏览器完成“用户 → 新建 Session → Default Kit”，最终 URL 为 `?kit=default&session=<id>`，Default Kit 的插件列表、详情、消息调试、日志与状态栏完整渲染。
- Gateway/Server 安全矩阵覆盖本地直连、本地 Gateway、远程 Gateway、直连远程伪造 header、重复/数组/非法 header 与 IPv4-mapped IPv6。

## 影响与风险

- 所有运行时承载路由现在都会进行 Session owner 校验；后续新增 Session 路由时必须接入相同策略。
- Gateway 是原始客户端地址的覆盖边界；Server 只有在立即 socket 为 loopback 时才读取单一合法 forwarded IP。部署若绕过唯一 Gateway，仍必须保证 Server 不向不可信网络暴露管理语义。
- 数据库新增 `users` 表及 owner 字段；升级逻辑对未知 schema 有意失败关闭，避免静默破坏身份数据。
- 当前身份仍是单机 Web Host 内的授权身份，不是互联网账号，也不提供 Project 级资源隔离。

## 偏差与遗留

- 浏览器自动化无法直接填写原生 `window.prompt`，创建用户动作由同源工作台 API 准备验收数据；Client 单测覆盖 prompt 提交行为，真实浏览器覆盖创建后的选择流程。
- 实现阶段为闭合安全与验收边界，计划范围扩展到 `packages/gateway`、`scripts/lib/web-host-*`、协议入口导出和应用数据库迁移；扩围已回写 `task.md`，未修改 Kit 或 Plugin 业务实现。

## 后续关注

- 若未来引入 Project，应单独定义 Project 与 Session、文件系统和权限的关系，不能复用本次 owner 语义直接宣称项目隔离。

## 相关正式文档

- `docs/architecture/kit-and-session-model.md`
- `docs/architecture/system-overview.md`

## blocking

- 无。

## non_blocking

- 浏览器原生 prompt 未由自动化直接填写；Client 单测已覆盖提交，浏览器使用同源 API 准备用户后覆盖其余流程。

## decision_candidates

- 无。Project 级隔离仍明确属于未来独立设计，不在本 Task 自动形成 ADR。

## follow_up

- 无。

## Decision Delta

- **architecture｜User、AuthorizedDevice 与 Session owner**：来源为用户确认的“选择既有 Session 或重新分发”体验、Task 需求与 Server/Client 实现；影响 Framework 身份、授权、Session、运行时路由和入口；状态为已实现并验证；正式落点为 `docs/architecture/kit-and-session-model.md` 与 `docs/architecture/system-overview.md`；反向检索 `User 1:N AuthorizedDevice`、`User 1:N Session`、`ownerUserId` 均命中。
- **architecture｜Gateway 原始客户端地址信任边界**：来源为 consolidation 独立审查发现的 loopback 提权缺口及后续安全修复；影响唯一 Web Host 的 Gateway→Server 身份解析；状态为已修复、独立 code-review 与代理链测试通过；正式落点为 `docs/architecture/kit-and-session-model.md` 的本地管理员与 forwarded 地址约束；反向检索 `X-Forwarded-For`、`真实 socket loopback`、`本地主机管理员` 均命中。
- **architecture｜Session owner 不是 Project 安全边界**：来源为最初产品讨论与 Task 非目标；影响后续 Project、workspacePath、文件系统隔离设计；状态为已明确；正式落点为 `docs/architecture/kit-and-session-model.md`；反向检索 `Project`、`workspacePath`、`文件系统级隔离` 均命中。
- **Task-only｜隔离 Web Host Plugin 存储根修复**：来源为浏览器验收暴露的 `PLUGIN_STORAGE_UNAVAILABLE`；只用于闭合本 Task 的隔离 Web Host 验收，未形成新的通用开发规则；状态为已修复并以 4 项 runner 测试和真实 Kit bootstrap 验证；落点为本 summary、可执行 helper 与回归测试。
- **Task-only｜原生 prompt 自动化限制与计划扩围**：来源为浏览器工具能力和 implementation/consolidation 评审；只影响本 Task 的验收方式与过程记录；状态为已披露；落点为本 summary 的“偏差与遗留”和 `non_blocking`；不提升为长期架构规则。
