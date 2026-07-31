# Kit Web 优先开发规则实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将普通 Kit 的开发与最终验收入口统一为 Web 默认，并只在涉及桌面专属能力或双端差异时要求 Electron 验收。

**Architecture:** 规则由根目录 `AGENTS.md` 提供面向 Agent 的简明约束，由 `docs/guides/development-workflow.md` 提供面向开发者的完整说明。`scripts/lib/kit-docs.test.mjs` 以文档契约测试锁定 Web 默认路径、Electron 触发条件和“不设置统一 Electron 门禁”的边界。

**Tech Stack:** Markdown、Node.js `node:test`、`node:assert/strict`

## Global Constraints

- 普通 Kit 开发、调试和最终验收默认使用 `npm run dev:web` 与浏览器。
- 只有涉及 Electron 专属能力或明确的 Web/Electron 差异时，Electron 才是必需门禁。
- 同时影响共享界面和桌面专属行为的改动，分别验证浏览器共享路径与 Electron 专属路径。
- 不修改 Web 或 Electron 运行时代码。
- 所有提交保留在当前 `feature/skill-manager-kit` 分支，并使用 `[Feature]` 提交标题。

---

### Task 1: 固化并实施 Kit Web 优先开发规则

**Files:**
- Modify: `scripts/lib/kit-docs.test.mjs`
- Modify: `AGENTS.md:3-7`
- Modify: `docs/guides/development-workflow.md:79-85`

**Interfaces:**
- Consumes: `read(relativePath)` 与 `compact(value)` 文档测试辅助函数。
- Produces: 一条文档契约测试，以及两处语义一致的开发规则。

- [ ] **Step 1: 写入失败的文档契约测试**

在 `scripts/lib/kit-docs.test.mjs` 的开发生命周期测试之后加入：

```js
test('Kit development defaults to Web and requires Electron only for desktop-specific changes', async () => {
  const agents = compact(await read('AGENTS.md'));
  const workflow = compact(await read('docs/guides/development-workflow.md'));
  const combined = `${agents} ${workflow}`;

  assert.match(agents, /ordinary Kit[^.]{0,120}npm run dev:web[^.]{0,80}default/iu);
  assert.match(workflow, /普通 Kit[^。]{0,120}npm run dev:web[^。]{0,80}默认/iu);
  for (const desktopBoundary of [
    'Tray',
    'BrowserWindow',
    '原生对话框',
    '桌面 IPC',
    '通知',
    '自动更新',
    '打包',
    '操作系统集成',
    'Web 与 Electron',
  ]) assert.match(combined, new RegExp(desktopBoundary, 'iu'), desktopBoundary);
  assert.doesNotMatch(combined, /所有改动[^。]{0,80}(必须|仍必须)[^。]{0,80}Electron/iu);
});
```

- [ ] **Step 2: 运行聚焦测试并确认旧规则使其失败**

Run: `node --test scripts/lib/kit-docs.test.mjs`

Expected: FAIL，失败点为 `AGENTS.md` 没有把普通 Kit 的最终验收设为 Web 默认，或开发指南仍包含统一 Electron 门禁。

- [ ] **Step 3: 更新根目录 Agent 规则**

将 `AGENTS.md` 的 `Development validation` 三条规则替换为：

```markdown
- For ordinary Kit changes whose behavior is shared by the Web and Electron hosts, use `npm run dev:web` and browser-based testing by default to develop, debug, and complete final acceptance.
- Use Electron when a change depends on or alters desktop-only behavior such as the Tray, BrowserWindow lifecycle, native dialogs, desktop IPC, notifications, updates, packaging, operating-system integration, or an explicit Web/Electron difference.
- When a change spans shared Kit behavior and desktop-only behavior, validate the shared path in the browser and the desktop-specific path in Electron. An Electron smoke check remains optional for ordinary Kit changes, not a universal gate.
```

- [ ] **Step 4: 更新开发指南**

将 `docs/guides/development-workflow.md` 的 `Web 优先、Electron 收口` 小节替换为：

```markdown
### Kit Web 优先、桌面能力按需验收

普通 Kit 的开发、调试和最终验收默认使用 `npm run dev:web` 与浏览器。只要改动在 Web 与 Electron
中共享实现，浏览器验收即可作为该改动的界面验收证据，无需再执行统一的 Electron 收口。

涉及系统托盘、BrowserWindow 生命周期、原生对话框、桌面 IPC、通知、自动更新、打包、操作系统
集成，或明确修改 Web 与 Electron 不同的控件、入口或行为时，必须使用 Electron 开发或完成补充
验收。同时影响共享 Kit 行为和桌面专属行为时，分别验证浏览器共享路径与 Electron 专属路径。
普通 Kit 可以自愿执行 Electron 冒烟检查，但它不是统一门禁。
```

- [ ] **Step 5: 运行聚焦测试并确认规则契约通过**

Run: `node --test scripts/lib/kit-docs.test.mjs`

Expected: PASS，所有文档测试无失败。

- [ ] **Step 6: 扫描冲突表述并检查差异**

Run: `rg -n "所有改动.*Electron|Web 优先、Electron 收口|passing Web tests does not replace|最终交付.*Electron" AGENTS.md docs/guides/development-workflow.md`

Expected: 无输出。

Run: `git diff --check && git diff -- AGENTS.md docs/guides/development-workflow.md scripts/lib/kit-docs.test.mjs`

Expected: 无空白错误；差异只包含已批准的规则与契约测试。

- [ ] **Step 7: 运行完整仓库测试**

Run: `npm test`

Expected: PASS，所有测试无失败；允许仓库原有的显式跳过测试。

- [ ] **Step 8: 提交实现**

```bash
git add AGENTS.md docs/guides/development-workflow.md scripts/lib/kit-docs.test.mjs docs/superpowers/plans/2026-07-31-web-first-kit-development.md
git commit -m "[Feature] 调整 Kit Web 优先开发规则"
```
