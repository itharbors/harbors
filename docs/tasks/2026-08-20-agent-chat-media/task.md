# 2026-08-20-agent-chat-media

Task ID: `2026-08-20-agent-chat-media`
Type: `feature`

## 背景与问题

Agent Chat 需要支持可插拔的 Markdown 代码块渲染器，使已注册的 Plugin 可以安全提供 Mermaid 图表渲染，并在渲染器不可用或失败时回退为普通代码块。

## 目标

Agent Chat 需要安全加载已注册的 Mermaid Markdown renderer，并在不可用或失败时回退为普通代码块。

## 范围

- `kits/agent-chat/plugins/mermaid/**`：Mermaid renderer Plugin、打包资源和 contribution。
- `kits/agent-chat/plugins/chat/**`：renderer 注册发现、异步渲染、安全降级和相关测试。
- `kits/agent-chat/kit.json`、`kits/agent-chat/package.json`、`kits/agent-chat/pnpm-lock.yaml`：Mermaid Plugin 装配与依赖。

## 非目标

- 不实现云端语音服务、实时转写、音频上传或录音持久化。
- 不把 Mermaid 运行时放入 Framework、Server 或通用 Client。
- 不支持任意 Markdown 代码块执行任意 JavaScript；renderer 必须来自已注册 Plugin。
- 不引入 Electron 或桌面宿主能力。

## 消息边界

- Mermaid Plugin 通过 Chat 的 Markdown renderer contribution 声明支持的语言和 renderer entry。
- Chat 只向已登记的 renderer 请求模块并执行渲染。
- renderer 加载或执行失败时，Chat 回退为转义后的 `<pre><code>`，不阻断整条消息渲染。

## 验收标准

- Chat 能注册和注销 Markdown renderer。
- Mermaid 代码块可以请求对应 renderer；未知语言及失败场景保持普通代码块显示。
- renderer 资源来自 Kit 内已注册 Plugin，且不扩大宿主能力边界。
- 目标 Plugin 测试、Kit 构建/校验和 Web 浏览器验收按仓库测试指南执行。

## 约束

- 只支持 Web 宿主，不加入 Electron、原生窗口生命周期、托盘、更新器或桌面 IPC。

## 需求变更

- 原 Audio/Whisper 语音输入是早期原型，已在本 Task 合并前取消；Audio Plugin、模型文件、native-code 权限和语音 UI 不属于最终交付，也不进入重建后的历史。
- Mermaid 运行时保留为 vendored 资产，并通过插件目录 `.gitattributes` 对该单个压缩资产设置精确 whitespace 例外。
