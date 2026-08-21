# Preview 安全网页预览与本地代理

Task ID: `2026-08-21-preview-safe-web`
Type: `feature`

## 背景与问题

Preview 需要在 Web 宿主内预览 HTTP(S) 网页，同时避免将目标站点的脚本、Cookie、重定向和嵌入策略直接带入宿主页面。已有未提交实现增加了安全快照、受限本地代理、资源重写和生命周期关闭，但缺少正式 Task、集中验收记录与安全边界证明。

## 目标

- 在 Web 宿主中提供受限的 HTTP(S) 网页代理预览，并保留安全快照回退模式。
- 对代理和快照请求执行协议、DNS/IP、重定向、响应大小和请求次数限制，阻止 SSRF 与 DNS rebinding。
- 隔离代理会话 Cookie，重写页面资源到当前代理会话，移除目标站点的 frame 嵌入限制，并在插件卸载/关闭时释放监听器和会话。
- 以 iframe sandbox、CSP、DOMPurify 和无 referrer 的方式限制快照及代理页面对宿主的影响。

## 范围

- `kits/agent-chat/plugins/preview/**` 内的 Preview main/panel 代码、代理、快照、状态管理和回归测试。
- `docs/tasks/2026-08-21-preview-safe-web/**` 内本 Task 的正式记录。

## 非目标

- 不修改 Chat、Client、Server、Framework 或其他 Plugin。
- 不引入 Electron、桌面宿主、原生窗口或桌面 IPC 假设。
- 不在本 Task 内进行 Web 浏览器验收；浏览器验收由主 Agent 在 Task consolidation 前执行。
- 不实现登录态、表单提交、下载、弹窗、跨窗口导航或完整浏览器功能。

## 验收标准

- Preview 的四组聚焦测试通过：代理服务、快照抓取、代理 URL/响应校验、Web 视图与快照清洗。
- 代理监听地址和浏览器可达性经过 Web 宿主验收；远程 Web 宿主场景不得被未经确认的监听范围误导或放大暴露面。
- 初始 URL 及每次重定向均重新解析并校验全部 DNS 地址，拒绝 loopback、私网、link-local、保留地址、云元数据和凭据 URL，并固定连接到已校验地址。
- 代理仅接受 GET/HEAD、限制会话/资源/请求/并发/响应体大小和超时，关闭会话及插件卸载后不残留监听器。
- 代理 Cookie 按会话、主机和 RFC 路径边界隔离，不转发浏览器 Cookie；页面资源和 CSS 引用重写到当前会话路径。
- 代理响应移除 frame 嵌入限制并施加宿主侧 CSP；快照通过 DOMPurify、srcdoc sandbox 和 CSP 禁止脚本、嵌入、外联资源和表单。
- `ce-plugin check`、Agent Chat kit build/test:kit、四组 Preview 测试和 `git diff --check` 通过；Task 在 Web 验收前保持 verification/consolidation 未完成。

## 约束

- 安全检查必须 fail closed；无法解析、无法固定 DNS 或无法验证代理响应时拒绝/失败，不泄露目标站点敏感错误细节。
- Preview 改动必须留在 Kit 专属 Plugin 目录内；不得通过共享代码绕过 Plugin 边界。
- 所有状态变更通过 `npm run task:status` CLI，原因、风险和交接信息写入 `summary.md` 或 `.work/`，不手工修改 `status.json`。
- 本地代理首版使用 Web 可达的 HTTP 监听，但应明确监听范围、远程 Web 宿主限制和部署风险，不得把浏览器验收前的假设写成已完成事实。

## 需求变更

- 本 Task 由已有 Preview 未提交改动补建，类型为 `feature`，Task ID 固定为 `2026-08-21-preview-safe-web`。
- 主 Agent 负责 Web 浏览器验收；在其完成前，本 Task 不得将 verification 或 consolidation 标记为 completed。
