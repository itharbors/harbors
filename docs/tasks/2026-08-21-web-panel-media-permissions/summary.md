# 2026-08-21-web-panel-media-permissions

## 最终结论

建议保留 Web Panel iframe 的 `microphone; camera` Permissions Policy 委托，作为受信任 Web Panel 的可选媒体采集能力入口；该声明不等同于用户授权。本 Task 的真实 Web 验收已完成，具体媒体消费者的提示/拒绝流程留作后续关注。

## 需求完成情况

- 已完成 iframe 属性实现与 Client 回归测试。
- 已确认当前仓库没有直接调用 `getUserMedia` 或等价媒体采集 API，未扩展具体媒体产品功能。
- 已完成真实 Web Panel 属性与无自动提示验收；当前仓库无媒体 API 消费者，因此未声称完成具体媒体采集流程。

## 主要改动

- `packages/client/src/layout/panel.ts`：Web Panel iframe 声明 `allow="microphone; camera"`，保留既有 sandbox。
- `packages/client/tests/layout/panel.test.ts`：断言媒体 Permissions Policy 委托和 sandbox 属性。

## 关键决定

- 仅对实际创建的 Web Panel iframe 设置委托；无 `src` 或不可用 Panel 不创建 iframe。
- 保留 `allow-scripts allow-same-origin`，不新增表单、弹窗、顶层导航、下载或桌面宿主权限。
- 不在自动化测试中模拟浏览器设备权限；本 Task 的 Web 验收聚焦真实 iframe 属性、加载和无自动提示。

## 验证结果

- `pnpm --filter @itharbors/client exec vitest run tests/layout/panel.test.ts`：通过，14 个测试通过。
- `pnpm --filter @itharbors/client run typecheck`：通过。
- `pnpm --filter @itharbors/client run build`：通过。
- `git diff --check`：通过。
- `npm run task:status -- check 2026-08-21-web-panel-media-permissions`：通过。
- Web 浏览器验收：通过。独立服务 `http://127.0.0.1:49390` 完成真实 Agent Chat Kit 装配，共 6 个 Panel iframe（`conversation.list`、`chat.main`、`preview.preview`、`settings.settings`、`plugin.list`、`debug.debug`）；每个 DOM `allow` 均精确为 `microphone; camera`，全部正常加载，加载过程没有触发设备权限提示，页面保持可用。

## 影响与风险

- `allow` 只委托 Permissions Policy，不会自动打开摄像头或麦克风；浏览器仍需用户授权。
- 当前仓库没有媒体 API 调用，现有 Web 验收只能证明权限委托属性和无自动提示；后续接入媒体 Panel 时必须保留用户可见的请求/拒绝处理。
- `allow-same-origin` 要求 Panel 来源继续受 Harbors 受信任运行时约束，不应将任意外部页面接入该路径。

## 偏差与遗留

- 当前没有真实媒体消费者，未执行主动请求/拒绝端到端流程；这不阻塞本 Task 的属性委托边界，作为后续媒体功能的验收项保留。

## 后续关注

- 后续引入真实媒体消费者时，补充主动请求、用户拒绝、设备释放和错误恢复的 Web 验收。
- 若未来引入跨源或不受信任 Panel，应重新设计按 Panel 能力声明的最小权限策略，不能继续对所有 iframe 广泛委托。

## 相关正式文档

- `docs/superpowers/specs/2026-07-18-architecture-hardening-design.md`
- `docs/architecture/core-principles.md`
