# 2026-08-21-fix-chat-link-activation

## 最终结论

自动化验证已完成，主 Agent 已在 live Web 中确认链接 DOM 结构正确；交互点击验收受浏览器控制层无法激活 Panel iframe 控件的环境限制，不能将该限制归因于本次代码。Task 验收材料已收口，但仍保留交互覆盖风险。

## 需求完成情况

- 已补建 Bug Task 并填写需求、范围、验收标准和约束。
- 已将链接监听绑定到 Transcript 实际挂载的 `.chat-surface` JSX capture handlers。
- 已修复 `pointerup` 的 `button: -1` 兼容性，并使普通激活统一由合成 `click` 处理。
- 已让指针移动、释放和取消事件在拖拽离开消息列表时仍能清理控制器状态。
- 主 Agent live Web DOM 验收已完成：链接存在于 `.chat-surface` 和 `.message-list-container`，`href="#"`、`data-original-href` 保持正确。
- 交互点击无法验收：Browser 控制层无法激活任何 Panel iframe 控件，连既有 Turn 4 展开按钮的 `aria-expanded` 也不改变；因此没有取得 `chat.normalizeLink` 的 live click 证据，也不宣称该交互结果已通过。

## 主要改动

- `app.tsx` 将 `handleLinkClick` 传给 Transcript。
- `transcript.tsx` 在 `.chat-surface` JSX 上安装稳定 controller 的 capture handlers；`pointerup` 不再直接广播，点击阶段负责一次性处理链接激活，并兼容未定义的 MouseEvent button。
- `markdown-links.test.ts` 增加 `pointerup button: -1` 后合成点击只广播一次的回归测试。
- 改为直接在 Transcript 实际挂载的 `.chat-surface` JSX 上使用 React capture props（pointerdown/move/up/cancel、click），通过稳定 controller/ref 转发到 App，完全移除 effect 和原生 DOM listener 依赖。
- JSX handler 适配层同时支持 React 包装事件和 Preact/兼容层直接传入的原生事件（`nativeEvent ?? event`），并增加两种输入形式的测试。
- 链接识别改为兼容跨 DOM realm 的 `composedPath()` 元素；释放阶段信任按下时的主指针资格，避免异常 `isPrimary`/`button` 值抑制合法点击。

## 关键决定

- 采用 Transcript `.chat-surface` 的 React/兼容层 capture props，确保真实挂载的 Panel 内容直接进入 controller；消息列表内的动态链接仍由祖先节点委托覆盖。
- 指针按下时检查主指针资格，释放时不重复依赖 `button`，因为部分浏览器的 `pointerup.button` 为 `-1`。

## 验证结果

- `pnpm exec tsx --test kits/agent-chat/plugins/chat/panel.main/src/markdown-links.test.ts`：通过，12/12（含 React 包装事件与直接原生事件两条 JSX capture 链路）。
- `node scripts/ce-plugin.mjs check kits/agent-chat/plugins/chat`：通过。
- `node scripts/ce-plugin.mjs build kits/agent-chat/plugins/chat`：通过。
- `git diff --check -- kits/agent-chat/plugins/chat/panel.main/src/app.tsx kits/agent-chat/plugins/chat/panel.main/src/markdown-links.test.ts kits/agent-chat/plugins/chat/panel.main/src/transcript.tsx`：通过。
- Web DOM 验收：主 Agent live Web 已通过，确认链接位于 `.chat-surface`/`.message-list-container`，`href="#"` 和 `data-original-href` 正确。
- Web 交互验收：受 Browser 控制层限制未完成；无法激活 Panel iframe 内任何控件，既有 Turn 4 展开按钮同样无响应，因此没有可归因于本 Task 的 `chat.normalizeLink` 点击证据。

## 影响与风险

- 变更限定在 Agent Chat Chat Plugin 及本 Task 文档，不触碰 Preview、Client 或服务端。
- 仍需在可实际操作 Panel iframe 的浏览器控制环境中确认普通外链、文件链接、插件协议链接、触摸点击、键盘点击和拖拽抑制的可见行为；当前 live DOM 结构已确认，交互覆盖因工具限制保留风险。

## 偏差与遗留

- 用户要求的本地提交由主 Agent 统一完成；本子任务不提交、不 push。
- Browser 控制层无法操作 Panel iframe 是环境限制，不是代码失败证据；该限制已在验证结果和影响风险中如实记录。

## 后续关注

- 后续如需消除残余风险，应在能够真实操作 Panel iframe 的浏览器控制环境中验证一次点击只触发一次 `chat.normalizeLink`/`chat.link.clicked`，并验证拖拽离开链接不触发广播。
- 由主 Agent 将本 Task 文件与 Chat 代码一同创建本地 commit；本子任务不提交、不 push。

## 相关正式文档

- `docs/guides/developing-plugins-and-kits.md`
- `docs/guides/testing.md`
