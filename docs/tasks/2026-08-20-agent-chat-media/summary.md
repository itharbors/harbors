# 2026-08-20-agent-chat-media 实现总结

## 最终结论

Agent Chat 已加入 Mermaid Markdown renderer Plugin、注册发现、异步渲染和安全降级链路。Audio/Whisper 语音输入属于早期原型，已在本 Task 合并前取消；最终交付不包含 Audio Plugin、模型文件、native-code 权限或语音输入 UI。

## 主要改动

- Mermaid Plugin 通过 Chat contribution 声明支持的语言和 renderer entry。
- Chat 动态发现已注册 renderer，并在模块加载或执行失败时回退为普通代码块。
- Mermaid 运行时作为 Plugin 内 vendored 资产保留；仅对该资产设置精确 whitespace 例外。
- Chat 相关测试覆盖 renderer 占位、清理和普通 Markdown 回退路径。

## 验证与遗留

- 目标 Plugin 的构建/manifest 检查和相关 Node 测试按当时工作流执行。
- Mermaid 真实 Web 正向渲染仍需在可交互浏览器中复验；曾观察到现有会话中的 Mermaid 区块显示异常，因此不能宣称 Web 端到端验收已完成。
- Audio 原型未进入最终树，Whisper 模型和 sherpa 依赖已从交付内容清除。

## 相关正式文档

- [Task 需求快照](./task.md)
