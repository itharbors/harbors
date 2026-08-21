# Preview 安全网页预览与本地代理总结

## 最终结论

自动化检查已通过，主 Agent live Web 验收确认 Preview 能通过实际 message broadcast 打开 arXiv，动态代理 URL 使用当前页面 hostname 和随机端口，代理 iframe 使用 `sandbox=allow-scripts` 与 `referrerpolicy=no-referrer`，目标页面可以真实渲染。Task 已完成 verification 和 consolidation；后续仍需在提交前保留本总结中的残余风险说明。

## 需求完成情况

- 已补建 `2026-08-21-preview-safe-web` feature Task。
- 已完成实现与自动化验证阶段。
- 主 Agent 已完成 live Web 渲染验收；交互控制层无法激活 Preview Panel 控件，且同样无法改变既有 Chat Turn 展开状态，因此该工具限制不能归因于 Preview。

## 主要改动

- Preview main 增加受限 HTTP(S) 快照抓取和本地代理生命周期管理。
- Preview proxy 增加 DNS/IP 校验、逐跳重定向校验、固定解析地址、请求/会话/资源/并发/响应体/超时限制、Cookie 隔离和 HTML/CSS 资源重写。
- Preview panel 增加代理 URL 响应校验、代理/安全快照切换、DOMPurify 清洗、iframe sandbox/CSP/referrer-policy 和关闭代理会话。
- Preview 面板不再依赖 root 冒泡事件委托，改为每次渲染后直接绑定模式切换、重试、Tab 激活和关闭按钮，补充源码与构建后 bundle 的真实 mount+click 交互回归覆盖。
- Web Tab 视图和导航按钮现在携带显式 `data-preview-session-key`，按钮 handler 按固化的 session/tab 查找状态，不依赖点击时的全局 selected session；链接事件也会使挂载时延迟的 conversation `getState` 结果失效，避免异步竞态覆盖刚打开的 Tab。
- 补充代理、快照、IPv6 地址边界、代理 URL 和 Web 视图回归测试。

## 关键决定

- 代理监听暂使用 `0.0.0.0`，以支持当前 Web 宿主可能由远程浏览器访问；随机高熵会话 ID、短生命周期和严格路径是代理访问凭据。
- HTTPS 页面不启动 HTTP 本地代理，避免混合内容；安全快照仍可用。
- 代理 iframe 仅启用 `allow-scripts`，不授予 `allow-same-origin`、表单、弹窗、下载或顶层导航能力；快照 iframe 使用空 sandbox。
- IPv6 判定改为解析 128 位地址，覆盖完整展开的 IPv4-mapped、IPv4-compatible、ULA、link-local、multicast、6to4 私网编码和 Teredo 保留前缀。

## 验证结果

- Preview 四组测试：通过，37 项（含源码与构建后 bundle 的真实 mount+click 模式切换、重试和关闭）。
- `node scripts/ce-plugin.mjs check kits/agent-chat/plugins/preview`：通过。
- `npm run build --prefix kits/agent-chat`：通过。
- `npm run test:kit --prefix kits/agent-chat`：通过。
- `git diff --check`：通过。
- 主 Agent live Web：通过实际 message broadcast 打开 arXiv；动态代理 URL 使用当前 hostname 和随机端口；代理 iframe 的 `sandbox=allow-scripts`、`referrerpolicy=no-referrer` 正确；目标页面真实渲染。
- Browser 控制层点击限制：无法激活 Preview Panel iframe 控件，既有 Chat Turn 展开按钮也无状态变化，不能据此判定 Preview 交互失败。

## 影响与风险

- 监听 `0.0.0.0` 会让随机代理端口在宿主网络接口上可达；会话路径是 bearer secret，但若 URL 被日志、截图或其他网络观察者获得，可在会话过期前读取该会话允许的公网资源。live Web 已证明当前 Web 宿主可达，但部署时仍需确认网络边界符合预期。
- 代理首版不承诺登录、表单、下载、弹窗或完整跨窗口交互；页面脚本和资源能力受强制 CSP 与 sandbox 限制。
- 本子 Agent 环境没有可用 Browser 连接（浏览器发现返回空列表），未能独立取得真实 Web 页面点击证据；主 Agent 已在其 Web 会话完成 live 渲染验收，构建后 bundle 的 mount+click 测试也已通过。
- 当前代码仅修改 Preview Plugin 和本 Task 文档；工作区内其他 Chat、Client 和其他 Task 改动未纳入本 Task。

## 偏差与遗留

- Browser 控制层无法激活任何 Panel iframe 控件，包括既有 Chat Turn 展开按钮；因此未取得控件点击变化证据，但该限制不具有 Preview 特异性。
- 没有提交、push、创建 PR 或创建分支/worktree。

## 后续关注

- 如需后续交互专项验证，应使用能正常操作 Panel iframe 的浏览器控制通道；当前 live Web 渲染验收已完成。
- 在远程 Web 宿主场景确认 `buildProxyUrl` 使用的页面 hostname 能访问同一宿主上的动态代理端口；若网络策略不允许，应在后续 Task 重新设计代理暴露方式，而不是放宽 iframe 安全边界。

## 相关正式文档

- `docs/guides/testing.md`
- `docs/guides/developing-plugins-and-kits.md`
- `docs/architecture/plugin-runtime-model.md`
