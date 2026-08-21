# 2026-08-20-fix-mermaid-false-render

Task ID: `2026-08-20-fix-mermaid-false-render`
Type: `bug`

## 背景与问题

Agent Chat 通过 Markdown 渲染扩展点识别 Mermaid 代码块，并异步交给 Mermaid 插件生成 SVG。当前 Chat 的 `marked` 自定义代码块渲染器在未命中已注册语言时返回布尔值 `false`；在当前 `marked` 版本中该返回值会被直接输出为文本，因此对话中的 Mermaid 区块可能显示为 `false`，普通 fenced code 也存在同样的回退风险。

## 目标

- 修复 Chat Markdown 代码块的默认回退，使未注册语言仍渲染为普通 `<pre><code>` 代码块，不显示字面量 `false`。
- 保持已注册的 Mermaid 代码块进入 Mermaid 渲染器并显示 SVG。
- 增加能稳定复现该回归的自动化测试，并完成 Web 浏览器可见行为验收。

## 范围

- `kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx`：代码块 Markdown 渲染与 Mermaid 占位节点路径。
- `kits/agent-chat/plugins/chat/panel.main/src/transcript.test.ts`：普通代码块回退和已注册 Mermaid 代码块的回归测试。
- `kits/agent-chat/plugins/mermaid/renderer.js`：仅在需要支持测试或修复 Mermaid 调用契约时调整；默认不扩大 Mermaid 插件职责。
- `kits/agent-chat/plugins/mermaid/package.json` 及 Agent Chat Kit 内相关构建装配：仅用于必要的构建和运行验收。

## 非目标

- 不改变 Mermaid 图表语法、主题、安全级别或 Mermaid 资源内容。
- 不改变 Chat 消息协议、服务端 trace、对话持久化和其他 Markdown 语法的既有语义。
- 不处理模型服务设置页、语音输入、最终回复截断等相邻问题。
- 不加入 Electron 或桌面宿主行为；本 Task 只支持 Web 宿主。

## 验收标准

- 普通 `ts`、`json` 等未注册 fenced code 经 `renderMarkdownHtml` 后包含 `<pre><code>`，且不等于或包含错误的字面量 `false`。
- 注册 `mermaid` 语言后，Mermaid fenced code 生成带 `data-lang="mermaid"` 和代码内容的渲染占位节点，并由异步渲染器替换为 SVG。
- Mermaid 加载或执行失败时，Chat 能安全降级为可读的普通代码块，而不是显示 `false` 或空白。
- Chat 相关 Node 回归测试通过；Agent Chat 范围内插件构建/检查通过。
- 在 Web 浏览器中发送或载入包含以下内容的助手消息，页面显示图形 SVG 而非 `false`：

  ````md
  ```mermaid
  graph TD
  A[开始] --> B[结束]
  ```
  ````

- Web 验收同时确认普通 fenced code 保持 `<pre><code>` 展示，且 Mermaid 占位节点不会永久残留。

## 约束

- 用户要求直接在当前 `main` 修复，不创建分支或 worktree，不 push。
- 变更限定在 `kits/agent-chat` 内，遵守 Plugin/Kit 边界。
- 自动化测试应优先覆盖 Chat 的纯 Markdown 输出；若需要测试模块级语言注册状态，应采用可控的依赖注入或纯函数边界，避免依赖测试顺序和全局缓存污染。
- 仅在实际执行后记录测试和浏览器验收结果，不将尚未运行的检查标记为通过。

## 需求变更

本 Task 新增于发现既有 Mermaid 集成在 Web 中显示 `false` 之后；当前将普通代码块回退、Mermaid 异步 SVG 渲染、自动化测试和 Web 验收统一纳入缺陷修复范围。
