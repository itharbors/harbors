# 2026-08-20-fix-mermaid-false-render 实现总结

## 最终结论

Chat 的 Markdown 代码块回退缺陷已修复：未注册语言现在调用 `marked` 默认 renderer，不再把 `false` 输出到消息中。回归测试、Chat/Mermaid 插件检查、Chat 构建和 Web 中的普通代码块回退验收均已完成。由于当前会话没有 Mermaid 示例且模型服务未配置凭据，本轮没有直接看到 Mermaid SVG，Mermaid SVG 端到端验收仍有限制，不能将其宣称为已通过。

## 需求完成情况

- 需求确认和 Task 建档：已完成。
- 未注册 fenced code 的 fallback 修复：已完成。
- 专项回归测试：已新增 2 条并通过，分别覆盖普通代码块 fallback 和已注册 Mermaid placeholder。
- Chat Node 测试、Chat/Mermaid 插件检查和 Chat 构建：已完成。
- Web 中普通代码块不再显示 `false`：已完成。
- Mermaid SVG 的真实 Web 会话端到端验收：尚未完成，受当前会话和模型凭据条件限制。

## 主要改动

源码和测试仅修改了：

- `kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx`：未注册代码块回退到 `marked` 默认 renderer。
- `kits/agent-chat/plugins/chat/panel.main/src/transcript.test.ts`：新增普通代码块 fallback 和已注册 Mermaid placeholder 两条回归测试。

Chat 构建刷新了 `dist` 忽略产物，该产物不纳入源码改动。

## 关键决定

- 先以 Chat Markdown renderer 的普通代码块回退作为最小修复边界，再验证 Mermaid 异步渲染链路。
- 测试应覆盖“不显示字面量 `false`”这一回归结果，并在 Web 中确认最终 SVG。

## 已确认事实

- `kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx` 的自定义 `Renderer.code` 原先在未命中注册语言时返回 `false as unknown as string`。
- 当前修复改为调用 `marked` 默认 renderer，避免 fenced code 直接输出字面量 `false`。
- Mermaid 插件仍通过占位节点和动态加载的 `renderer.js` 生成 SVG；本轮未具备包含 Mermaid 示例的会话，且模型服务未配置凭据，因此没有直接观察到 SVG。

## 验证结果

- Chat 全部 Node 测试：`83/83` 通过。
- Chat 和 Mermaid `ce-plugin check`：均 `exit 0`。
- Chat build：成功；刷新出的 `dist` 为忽略产物，不纳入源码改动。
- Web 重载现有会话后，原来显示字面量 `false` 的 fenced code 已显示为代码块；DOM 统计为 `29` 个 markdown message、`2` 个 `pre > code`、`0` 个 literal-false message、`0` 个 renderer placeholder。
- 本轮没有 Mermaid 示例消息，且模型服务未配置凭据，未直接完成 Mermaid SVG 的端到端浏览器验收。

## 尚未完成事项

- 在具备 Mermaid 示例和模型服务凭据的会话中补做一次 Web 验收，确认占位节点被 SVG 替换。
- 继续观察 Mermaid 加载或执行失败时是否稳定降级为普通代码块。

## 影响与风险

- 普通 fenced code 的 `false` 展示缺陷已有 Node 和 Web 回归证据覆盖。
- Mermaid SVG 链路缺少本轮真实会话证据，不能仅凭 fallback 修复结果宣称 Mermaid 图形端到端通过。
- 本 Task 不包含模型设置或聊天最终回复截断等其他问题；Mermaid SVG Web 验收仍未完成。

## 偏差与遗留

- Mermaid SVG 真实会话端到端验收受当前会话没有示例、模型服务未配置凭据影响，暂未完成；该限制不影响普通 fenced code fallback 的修复证据。

## 后续关注

- 在具备 Mermaid 示例和模型服务凭据的 Web 会话中补做 SVG 验收，并根据结果决定是否需要后续修复。

## 相关正式文档

- [Task 需求快照](./task.md)
