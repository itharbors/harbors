# 2026-08-20-agent-chat-media 实现总结

## 最终结论

Agent Chat 保留 Mermaid Markdown renderer Plugin、注册发现、异步渲染和安全降级链路。Audio/Whisper 语音输入属于早期原型，已在本 Task 合并前取消；最终交付不包含 Audio Plugin、模型文件、native-code 权限或语音输入 UI。前置修复 commit `68f8de1` 已通过 fast-forward 堆叠到本分支，Mermaid 资源加载、空 renderer 输出回退和多行代码保留均已修复；真实 Web 浏览器验收通过，Task 可进入 consolidation。

## 需求完成情况

- Mermaid Plugin 及 Chat renderer contribution 已保留在最终交付范围内。
- Chat 能发现已注册的 Mermaid renderer，并在加载或执行失败时回退为普通代码块。
- Audio/Whisper 语音输入在合并前取消，相关模型、依赖、权限和 UI 不属于本 Task 最终交付。
- Mermaid renderer 入口与 vendored Mermaid 资源均通过 Plugin public asset 路由加载。

## 主要改动

- Mermaid Plugin 通过 Chat contribution 声明支持的语言和 renderer entry。
- Chat 动态发现已注册 renderer，并在模块加载或执行失败时回退为普通代码块。
- Mermaid 运行时和 renderer 入口作为 Plugin 内 vendored public assets 保留；仅对该单个压缩资产设置精确 whitespace 例外。
- Chat 相关测试覆盖 renderer 占位、清理、多行代码保留、空输出回退和普通 Markdown 回退路径。
- 前置修复 commit `68f8de1`：`[Bug] 修复 Mermaid 资源加载与代码回退`；本 Task 提交在其之上，不复制前置修复。

## 关键决定

- Audio/Whisper 原型因模型体积、native-code 依赖和发布风险，在本 Task 合并前取消。
- Mermaid renderer 继续保持 Plugin 边界，不将运行时实现硬编码进 Chat 核心或 Framework。
- Mermaid 加载或执行失败时安全降级为普通代码块，不阻断整条消息渲染。
- Mermaid 入口继续通过 `entry: "./renderer.js"` 声明，由 Plugin public asset 路由解析到 `assets/renderer.js`；renderer 内部加载 `/api/assets/plugin/mermaid/mermaid.min.js`。

## 验证结果

- `pnpm exec tsx --test kits/agent-chat/plugins/chat/panel.main/src/transcript.test.ts kits/agent-chat/plugins/mermaid/renderer.test.ts`：25/25 通过。
- `node scripts/ce-plugin.mjs check kits/agent-chat/plugins/mermaid` 与 `node scripts/ce-plugin.mjs check kits/agent-chat/plugins/chat`：通过。
- `node packages/kit-cli/dist/cli.js build kits/agent-chat`：通过，`PLUGINS=9`。
- `node packages/kit-cli/dist/cli.js test kits/agent-chat` 与 `node packages/kit-cli/dist/cli.js validate kits/agent-chat`：通过，`FILES=8795`。
- 隔离 Web 栈 `HARBORS_GATEWAY_PORT=52480 HARBORS_SERVER_PORT=52481 HARBORS_CLIENT_PORT=52482 HARBORS_NOTIFICATION_PORT=52483 pnpm run dev:web --kit agent-chat` 启动成功；session/bootstrap 成功。
- HTTP asset 检查：`/api/assets/plugin/mermaid/renderer.js` 返回 200（1525 bytes），`/api/assets/plugin/mermaid/mermaid.min.js` 返回 200（3572296 bytes）。
- 真实浏览器复核（session `752fa37d-7f77-4c11-926c-3637b2d44dee`）：页面 reload 后 Turn 14 存在；助手消息内 Mermaid SVG=3；残留 `.markdown-code-block-renderer`=0；字面 `false` 消息=0；空 `pre>code`=0；`flowchart TD` fallback=0。

## 影响与风险

- Mermaid vendored 运行时约 3.57 MB，会增加 Agent Chat Kit 体积；发布前继续确认资源体积和加载行为。
- 真实 Web 验收已覆盖当前正向 SVG、无残留占位和无错误回退；后续发布仍应关注 Mermaid 语法错误时的普通代码块降级。
- Audio/Whisper 模型和 native-code 权限不进入最终交付，最终 Kit 不应依赖这些资源或权限。

## 偏差与遗留

- 原始需求包含 Audio/Whisper 语音输入，但该原型已在合并前取消，属于已记录的需求变更。
- Mermaid SVG 真实 Web 正向验收已完成；前置资源路径修复作为独立 commit 堆叠在本分支之前。
- 当前没有 Audio/Whisper 专项测试或交付资源，因为 Audio 不属于最终范围。

## 后续关注

- 发布前复查 vendored Mermaid 资产的体积、加载路径和安全配置。
- 后续可继续验证更多 Mermaid 语法错误样例均稳定回退为普通代码块。

## 相关正式文档

- [Task 需求快照](./task.md)
