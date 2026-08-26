# Preview 快照清理与独立网页视口总结

## 最终结论

已完整移除 Harness Preview 的安全快照能力，并在不放宽代理 sandbox 或跨源隔离的前提下，为 HTTP(S) 预览增加独立逻辑视口、直接交互/模拟鼠标切换及受约束的虚拟鼠标控制。实现、自动验证和真实 Web 浏览器核心链路验收均已完成。

## 需求完成情况

- 安全快照协议、抓取实现、状态、切换/重试界面、`srcdoc` 渲染和对应测试已删除。
- HTTP(S) 页面仅通过受限代理加载；本地 HTML 改为转义后的代码文本预览。
- 每个网页页签可设置 320–3840 × 240–2160 的独立逻辑视口，默认 1280 × 720，Panel 缩放不会改写该值。
- 直接交互和模拟鼠标共享同一 iframe；模式切换保留页面、滚动、平移和视口尺寸。
- 模拟鼠标支持滑动移动、轻点左键、550ms 长按 `contextmenu`、边缘自动平移和 Escape 退出。
- 控制桥接校验来源、origin、代理会话、消息结构、整数坐标和实际 iframe 视口。

## 主要改动

- 删除 `main/src/web.ts`、`web.test.ts` 及 `fetchWebPage` manifest/主进程入口。
- 在 Preview Panel 中新增视口尺寸、裁剪画布、平移状态、虚拟光标和交互模式控制。
- 在代理页面注入最小控制桥接；注入逻辑覆盖 HTML/XHTML、raw-text、plaintext 与 CDATA 等解析边界。
- 调整窄 Panel 控制区为两列自适应布局，避免按钮文字在 300px 面板内纵向挤压。

## 关键决定

- 用户的新产品决定覆盖历史“代理 + 快照回退”方向：快照完整删除，不保留隐藏开关或兼容分支。
- 代理 iframe 继续只使用 `allow-scripts`，不增加 `allow-same-origin`；跨源交互通过严格校验的 `postMessage` 桥接完成。
- 本地 HTML 不再作为可执行页面加载，以文本代码预览收敛行为和安全边界。
- 本 Task 未产生需要升级为正式架构文档的新决策。

## 验证结果

- `node scripts/ce-plugin.mjs build kits/harness/plugins/preview`：通过。
- Preview 源码、proxy、panel 与 built bundle 测试：43/43 通过。
- `node scripts/ce-plugin.mjs check kits/harness/plugins/preview`：通过。
- `pnpm run kits:check harness`：`KIT=harness STATUS=passed`。
- `git diff --check`、业务路径边界、生产源码与 dist 快照残留反搜：通过。
- 真实 Chromium 验收覆盖：大/小逻辑视口、Panel 动态缩放、模式切换、同一 iframe 保持、滑动、轻点、长按、边缘自动平移、真实滚动、Escape、reduced-motion、恶意控制消息拒绝、有效消息执行及代理失败状态。
- 浏览器验收发现并修复 300px 窄 Panel 控制按钮纵向挤压；修复后完整自动验证再次通过。最终视觉检查工具在嵌套 iframe 点击稳定性等待处超时，但页面与代理 iframe 正常加载，未发现新的产品错误。

## 影响与风险

- `blocking`: 无。
- `non_blocking`: 目标网站仍可拒绝 `isTrusted=false` 的合成事件；HTTPS 宿主下本地 HTTP 代理的 mixed-content 限制保持不变；最终一次 CSS 视觉复查受 Playwright 嵌套 iframe 稳定性等待超时影响，但修复前完整浏览器链路、修复代码审查及修复后全量自动验证均通过。
- 业务代码严格限制在 `kits/harness/plugins/preview/**`；其余变更仅为本 Task 档案。

## 偏差与遗留

- 未实现跨重启的视口尺寸持久化、浏览器原生右键菜单或绕过目标网站非可信事件限制，均符合非目标。
- `decision_candidates`: 无。

## 后续关注

- `follow_up`: 在更多真实第三方页面上持续观察合成鼠标事件兼容性；若出现站点级差异，按独立兼容任务处理，不回退代理隔离边界。

## 相关正式文档

- 无。本次结论与边界已在 Task 文档中闭环，不修改历史 Task 或仓库级架构文档。
