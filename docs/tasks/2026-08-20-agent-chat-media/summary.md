# 2026-08-20-agent-chat-media 实现总结

## 最终结论

Agent Chat 保留 Mermaid Markdown renderer Plugin、注册发现、异步渲染和安全降级链路。Audio/Whisper 语音输入属于早期原型，已在本 Task 合并前取消；最终交付不包含 Audio Plugin、模型文件、native-code 权限或语音输入 UI。Mermaid SVG 的真实 Web 正向验收尚未完成，因此本 Task 当前不能进入 consolidation。

## 需求完成情况

- Mermaid Plugin 及 Chat renderer contribution 已保留在最终交付范围内。
- Chat 能发现已注册的 Mermaid renderer，并在加载或执行失败时回退为普通代码块。
- Audio/Whisper 语音输入在合并前取消，相关模型、依赖、权限和 UI 不属于本 Task 最终交付。
- Mermaid SVG 真实 Web 浏览器验收尚未完成。

## 主要改动

- Mermaid Plugin 通过 Chat contribution 声明支持的语言和 renderer entry。
- Chat 动态发现已注册 renderer，并在模块加载或执行失败时回退为普通代码块。
- Mermaid 运行时作为 Plugin 内 vendored 资产保留；仅对该资产设置精确 whitespace 例外。
- Chat 相关测试覆盖 renderer 占位、清理和普通 Markdown 回退路径。

## 关键决定

- Audio/Whisper 原型因模型体积、native-code 依赖和发布风险，在本 Task 合并前取消。
- Mermaid renderer 继续保持 Plugin 边界，不将运行时实现硬编码进 Chat 核心或 Framework。
- Mermaid 加载或执行失败时安全降级为普通代码块，不阻断整条消息渲染。

## 验证结果

- 目标 Plugin 的构建/manifest 检查和相关 Node 测试按当时工作流执行。
- 普通 Markdown 回退和 Mermaid renderer 占位路径已有自动化测试；后续 Mermaid fallback 修复由独立的 `2026-08-20-fix-mermaid-false-render` Task 记录。
- Mermaid 真实 Web 正向渲染仍需在可交互浏览器中复验，当前没有 SVG 端到端验收证据。

## 影响与风险

- Mermaid vendored 运行时会增加 Agent Chat Kit 体积，需要在发布前继续确认资源体积和加载行为。
- Mermaid SVG 真实 Web 验收尚未完成，动态 renderer 的资源路径、加载和失败降级仍需浏览器证据。
- Audio/Whisper 模型和 native-code 权限不进入最终交付，最终 Kit 不应依赖这些资源或权限。

## 偏差与遗留

- 原始需求包含 Audio/Whisper 语音输入，但该原型已在合并前取消，属于已记录的需求变更。
- Mermaid SVG 尚未完成真实 Web 正向验收，Task verification 仍处于进行中。
- 当前没有 Audio/Whisper 专项测试或交付资源，因为 Audio 不属于最终范围。

## 后续关注

- 在可交互 Web 浏览器中载入 Mermaid 示例，确认占位节点最终替换为 SVG。
- 验证 Mermaid 资源加载失败和 Mermaid 语法错误时都能稳定回退为普通代码块。
- 发布前复查 vendored Mermaid 资产的体积、加载路径和安全配置。

## 相关正式文档

- [Task 需求快照](./task.md)
