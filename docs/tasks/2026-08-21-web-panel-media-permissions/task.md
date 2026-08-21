# 2026-08-21-web-panel-media-permissions

Task ID: `2026-08-21-web-panel-media-permissions`
Type: `feature`

## Summary

为 Web Panel iframe 声明受控的麦克风和摄像头 Permissions Policy 委托，保留浏览器用户授权作为实际访问门槛，并补充宿主属性回归测试。

## 背景与问题

`packages/client/src/layout/panel.ts` 的 Web Panel iframe 需要为可能包含媒体采集交互的 Panel 预留浏览器 Permissions Policy 委托。此前 iframe 没有声明 `microphone` 和 `camera`，即使受信任的 Web Panel 在用户交互后调用浏览器媒体 API，也会在策略层被宿主拒绝。

当前仓库没有发现插件直接调用 `getUserMedia` 或等价媒体采集 API；因此本 Task 只确认宿主声明和安全边界，不声称已经完成某个具体媒体产品流程。

## 目标

- 在有 `src` 且可用的 Web Panel iframe 上声明 `allow="microphone; camera"`。
- 保留既有最小 sandbox：仅允许脚本和同源，不增加表单、弹窗、顶层导航、下载或其他宿主能力。
- 通过 Client 定向测试锁定 iframe 的 Permissions Policy 和 sandbox 属性，避免后续回归。
- 由主 Agent 使用真实 Web 浏览器确认实际 Panel 均获得正确属性且加载过程不会自动触发设备权限提示。

## 范围

- `packages/client/src/layout/panel.ts` 的 Web Panel iframe 属性。
- `packages/client/tests/layout/panel.test.ts` 的 iframe 属性回归测试。
- 本 Task 的中文需求、验证和交接文档。

## 非目标

- 不实现具体摄像头/麦克风采集 UI，不调用或模拟 `getUserMedia`。
- 不修改插件消息协议、Panel contribution schema、Server、Kit 或任何桌面宿主能力。
- 不绕过浏览器权限提示，不预授权设备，不新增跨源 iframe 或网络代理能力。
- 不把 iframe 的 Permissions Policy 委托视为用户授权；具体媒体消费者的提示、拒绝和设备释放流程另立后续验收。

## 验收标准

- 有效 `src` 的 Web Panel iframe 的 `allow` 属性严格为 `microphone; camera`。
- 无 `src` 或 `availability="unavailable"` 时不创建 iframe，因此不会产生媒体权限委托。
- iframe 继续使用且仅使用 `allow-scripts allow-same-origin` sandbox token。
- Client Panel 定向测试、typecheck 或 build 通过，`git diff --check` 通过。
- 主 Agent 在真实 Web Panel 中确认：真实 Kit 装配的 Panel iframe 均正常加载，`allow` 精确为 `microphone; camera`，加载过程不会自动触发设备权限提示，且没有无关非 iframe 内容获得该委托。

## 约束

- Web 是唯一宿主；不加入 Electron、桌面窗口、原生 IPC 或系统级设备授权假设。
- `allow` 只是 Permissions Policy 委托，不能代替浏览器和用户的实际授权；错误和拒绝必须由 Panel 自行处理。
- Panel iframe 当前使用 `allow-same-origin`，因此只对已纳入 Harbors Panel 运行时的受信任同源内容保留该委托；不得把任意不受信任外部页面接入该路径。
- 当前仓库未发现媒体 API 调用；本 Task 只验收属性委托和无自动提示，不伪造具体媒体消费者的提示/拒绝自动化证据。
- 保留工作区中与本 Task 无关的现有改动，不修改其他 Plugin、Kit、Preview、Chat、Server 或 Task。

## 需求变更

- 本 Task 按用户授权在当前本地 `main` 工作区补建，不创建分支或 worktree，不在本子任务中提交、push 或创建 PR。
- 初始审查发现 Audio 插件已移除且仓库没有现成媒体调用，因此将验收重点收窄为通用 Web Panel 权限委托、最小 sandbox 回归和主 Agent Web 验收；不扩展为媒体功能实现。
