# 2026-08-20-fix-mermaid-false-render 实现总结

## 最终结论

Chat Markdown 代码块的错误回退和 Mermaid Web 资源链路均已修复。未注册语言继续显示为可读的普通代码块，不再输出字面量 `false`；Mermaid 代码块能够在真实 Web 会话中生成 SVG，异步占位节点会被替换，资源路由可正常加载。验证和收口阶段已完成，未创建 Pull Request。

## 需求完成情况

- 未注册 fenced code 的安全回退：已完成。
- 已注册 Mermaid 代码块的异步 SVG 渲染：已完成。
- Mermaid 加载或执行失败时的可读代码块降级：已完成。
- Chat/Mermaid 自动化测试、构建和插件检查：已完成。
- 真实 Web 浏览器验收：已完成。

## 主要改动

- `kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx`：普通代码块统一回退为 `<pre><code>`；Mermaid 占位节点保留可读回退内容，并从嵌套 `pre > code` 的 `textContent` 恢复源码，避免 HTML 清理和 DOM 重建导致 `data-code` 为空。
- `kits/agent-chat/plugins/chat/panel.main/src/transcript.test.ts`：覆盖普通代码块回退、Mermaid 占位节点及失败降级路径。
- `kits/agent-chat/plugins/mermaid`：修正 renderer 与 Mermaid 静态资源的公共根路径，补充 renderer 合约及 DOMPurify 相关测试。

## 关键决定

- 普通代码块不依赖注册语言状态，始终由安全的 `<pre><code>` 回退承载源码。
- Mermaid 源码不再依赖可能被 sanitizer/DOM 重建清空的任意多行 `data-code` 属性，而是从占位节点内的代码块文本读取。
- 资源入口按插件公共资产根路径提供，使 `/api/assets/plugin/mermaid/renderer.js` 和 Mermaid runtime 均可被 Web 宿主加载。

## 验证结果

- `pnpm exec tsx --test kits/agent-chat/plugins/chat/panel.main/src/transcript.test.ts kits/agent-chat/plugins/mermaid/renderer.test.ts`：25/25 通过。
- `pnpm --dir kits/agent-chat run build`：通过。
- `node scripts/ce-plugin.mjs check kits/agent-chat/plugins/chat`：通过。
- `node scripts/ce-plugin.mjs check kits/agent-chat/plugins/mermaid`：通过。
- `git diff --check`：通过。
- 真实 Web 验收使用现有无凭据 AGNET 会话 Turn 14：助手 Mermaid SVG 数量为 `3`，占位节点为 `0`，空代码块为 `0`，普通代码块为 `32`。页面中唯一匹配 `false` 的内容是旧对话正文中描述该缺陷的内联代码，不是渲染产物。
- 带 runtime session query 的资源请求均返回 `200`：`/api/assets/plugin/mermaid/renderer.js`、`/api/assets/plugin/mermaid/mermaid.min.js`。
- 真实复现先确认旧资源路由返回 `404`；修正资产公共根路径后又确认 sanitizer/DOM 重建会使 `data-code` 为空，最终改为读取嵌套 `pre > code` 文本，并补充 DOMPurify 测试。
- 此前 `pnpm run kits:check agent-chat` 在隔离 staged repo 中因既有 package `yazl` 缺失失败；该问题属于无关的基线依赖，不影响本 Task 的针对性验证。

## 影响与风险

- 普通 fenced code、Mermaid SVG 成功渲染及 Mermaid 失败降级均有自动化覆盖；真实 Web 验收覆盖了 SVG、占位节点清理和普通代码块可见性。
- Mermaid 资源现通过插件公共资产路由提供，资源路径变更仅影响该插件的 Web 装配。
- `yazl` 缺失仍是隔离 staged repo 的既有基线依赖问题，未在本 Task 中扩大修复范围。

## 偏差与遗留

- 无本 Task 范围内的未完成事项。
- 未创建或提交 Pull Request，`pullRequest` 保持 `null`。

## 后续关注

- 若后续修复基线依赖，应单独处理隔离 staged repo 中的 `yazl` 缺失，不并入本 Task。

## 相关正式文档

- [Task 需求快照](./task.md)
