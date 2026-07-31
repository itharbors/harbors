# Kit Manager Chinese Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Kit Manager 的固定界面文案完整切换为简体中文，同时保留品牌、技术名和外部数据原文。

**Architecture:** 保持现有单语言 HTML 与视图渲染架构，不引入 i18n 运行时。静态文案继续由 `kit-manager.html` 提供，状态、权限、按钮和操作反馈继续由 `createKitManagerView` 生成，测试通过真实 JSDOM 页面验证最终用户可见内容。

**Tech Stack:** Electron、HTML、原生 JavaScript ES modules、JSDOM、Node.js test runner

## Global Constraints

- 保留 `ITHARBORS`、`Kit`、`CSV`、`SQLite`、`MySQL` 等品牌与技术名称。
- Stable 和 Preview 在界面中分别显示为“稳定版”和“预览版”，内部通道标识保持 `stable` 与 `preview`。
- Registry 在用户界面显示为“Kit 仓库”，代码和错误对象中的技术标识保持不变。
- 不翻译 Registry 提供的 Kit 名称、发布者、摘要、版本号和服务端返回的原始错误消息。
- 不引入语言切换器、i18n 依赖、远程资源、内联脚本或 HTML 注入路径。

---

### Task 1: 中文化 Kit Manager 页面与交互

**Files:**
- Modify: `scripts/kit-manager.html`
- Modify: `scripts/lib/kit-manager-view.mjs`
- Test: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**
- Consumes: `createKitManagerView({ document, api, confirmInstall })` 的既有 API 与 Registry snapshot 数据结构。
- Produces: 接口不变；HTML 和视图生成的固定用户文案改为简体中文。

- [ ] **Step 1: Write the failing localization tests**

在 `scripts/lib/kit-manager-view.test.mjs` 中更新或新增断言，验证：

```js
assert.equal(value.document.documentElement.lang, 'zh-CN');
assert.match(value.document.body.textContent, /Kit 管理/);
assert.match(value.document.querySelector('#registry-status').textContent, /正在加载 Kit 仓库/);
assert.match(stable.textContent, /等待重启/);
assert.match(stable.textContent, /原生代码 — 高风险/);
assert.equal(button.textContent, '内置');
assert.match(confirmations[0], /包含原生代码/);
assert.match(value.document.querySelector('#operation-status').textContent, /正在安装/);
```

同时把既有英文状态、操作反馈和错误回退断言改成设计中对应的中文结果；Kit 名称、摘要以及模拟的服务端错误消息继续断言原文。

- [ ] **Step 2: Run the view tests and verify RED**

Run:

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

Expected: FAIL，因为页面 `lang` 仍为 `en`，固定文案仍为英文。

- [ ] **Step 3: Translate static page copy**

修改 `scripts/kit-manager.html`：

```html
<html lang="zh-CN">
```

将页面标题、引导语、加载状态、刷新按钮、稳定版与预览版分区、空状态和页脚说明翻成中文。`ITHARBORS`、`Kit` 和产品名保持原样。

- [ ] **Step 4: Translate dynamic view copy**

修改 `scripts/lib/kit-manager-view.mjs` 中的固定字符串：

```js
const PERMISSION_LABELS = Object.freeze({
  network: '网络访问',
  filesystem: '文件访问',
  'native-code': '原生代码 — 高风险',
  'application-startup': '随 ITHARBORS 启动',
});
```

同步中文化状态、验证时间、回退文案、确认提示、操作反馈、通道标签、版本标签、按钮、Registry 状态和空列表提示；保留 `publicMessage(error)` 返回的非空服务端消息原文。

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/kit-manager-window.test.mjs
```

Expected: 所有测试通过，退出码为 0。

- [ ] **Step 6: Review and commit the localized page**

Run:

```bash
git diff --check
git diff -- scripts/kit-manager.html scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git add scripts/kit-manager.html scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m '[Bug] 中文化 Kit 管理器页面'
```

Expected: 提交只包含上述三个文件。

### Task 2: 完成仓库与 Electron 验收

**Files:**
- Verify only: `scripts/kit-manager.html`
- Verify only: `scripts/lib/kit-manager-view.mjs`
- Verify only: `scripts/lib/kit-manager-view.test.mjs`

**Interfaces:**
- Consumes: Task 1 的中文化界面。
- Produces: 自动化检查与实际 Electron 页面验收证据，不产生额外生产接口。

- [ ] **Step 1: Run the complete repository check**

Run:

```bash
CI=1 npm run check
```

Expected: 构建、测试和插件检查全部通过，退出码为 0。

- [ ] **Step 2: Launch Electron and inspect the live Kit Dock**

使用当前开发环境启动 Electron 并打开 Kit Dock，确认：页面标题、Registry 状态、稳定版/预览版分区、权限、状态和按钮均为中文；`ITHARBORS`、`Kit`、`CSV`、`SQLite`、`MySQL` 保留原文；无布局截断或意外英文固定文案。

- [ ] **Step 3: Verify repository state**

Run:

```bash
git diff --check
git status --short
```

Expected: 无空白错误，工作树干净。
