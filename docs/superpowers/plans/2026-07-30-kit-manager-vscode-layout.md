# Kit Manager VS Code 式主从布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把生产 Kit Manager 改造成 VS Code Extensions 式列表—详情工作区，同时保留现有安装、热启停、历史版本和安全事务。

**Architecture:** `createKitManagerView` 继续作为唯一 Renderer 和 API 调用入口，新增搜索、筛选、选中 Kit、频道和详情标签这组纯本地 UI 状态。HTML 提供稳定的列表/详情骨架，View 从现有清洗快照派生列表条目、详情操作和版本轨道；CSS 负责 Harbors 视觉与桌面/移动主从布局，不修改 Registry、preload 或 IPC。

**Tech Stack:** 本地 HTML/CSS、Node.js ESM、JSDOM、`node:test`、Electron。

## Global Constraints

- 遵循 `docs/superpowers/specs/2026-07-30-kit-manager-vscode-layout-design.md`。
- 不修改 Kit Registry 格式、签名验证、发布策略、Framework 热更新或错误恢复事务。
- 不新增 preload/IPC 权限、远程资源、外部字体、图片依赖或虚假的字节下载百分比。
- 桌面采用固定列表与详情双栏；`< 720px` 使用列表/详情单页导航。
- 列表不渲染权限全集、历史版本下拉或删除按钮。
- 详情保留概览、权限、版本记录三个标签；版本记录使用 CSS 版本轨道。
- 所有行为修改先写失败测试并确认 RED，再写最小生产实现。
- 每个提交使用当前 `bug/source-kit-runtime-version` 分支允许的中文标签格式，只暂存任务涉及文件。

---

### Task 1: 建立主从工作区、搜索与选择状态

**Files:**

- Modify: `scripts/kit-manager.html:22-75`
- Modify: `scripts/lib/kit-manager-view.mjs:113-158,244-470`
- Modify: `scripts/lib/kit-manager-view.test.mjs:45-180`

**Interfaces:**

- Consumes: `snapshot.kits[]`、`kit.channels.stable`、`kit.channels.preview`、`kit.installed`。
- Produces: `#kit-search`、`[data-filter]`、`#kit-navigation`、`#kit-detail`，以及 View 内的 `uiState = { query, filter, channel, selectedKitId, selectedChannel, detailTab }`。
- Produces: 列表条目 `[data-role="kit-list-item"][data-kit-id][data-channel]`，选中项设置 `aria-selected="true"`。

- [ ] **Step 1: 写主从结构和默认选择的失败测试**

在 `scripts/lib/kit-manager-view.test.mjs` 新增测试，使用同时包含 CSV、MySQL 和一个未安装 Kit 的快照，断言：

```js
assert.ok(document.querySelector('#kit-search'));
assert.ok(document.querySelector('#kit-navigation'));
assert.ok(document.querySelector('#kit-detail'));
const items = document.querySelectorAll('[data-role="kit-list-item"]');
assert.equal(items.length, 3);
assert.equal(document.querySelector('[aria-selected="true"]').dataset.kitId, '@itharbors/kit-csv');
assert.match(document.querySelector('#kit-detail').textContent, /CSV/);
assert.equal(document.querySelector('[data-role="installed-version"]'), null);
assert.equal(document.querySelector('[data-action="uninstall"]'), null);
```

第二次调用 `view.render(nextSnapshot)`，在原 Kit 仍存在时断言选中项保持；删除原 Kit 后断言选择第一条可见 Kit。

- [ ] **Step 2: 运行聚焦测试并确认 RED**

运行：

```bash
node --test --test-name-pattern="主从|默认选择" scripts/lib/kit-manager-view.test.mjs
```

预期：FAIL，因为 HTML 没有 `#kit-search`、`#kit-navigation` 和 `#kit-detail`，旧 Renderer 仍渲染频道资源行。

- [ ] **Step 3: 写搜索和状态筛选的失败测试**

新增测试并通过真实 DOM 事件驱动：

```js
const search = document.querySelector('#kit-search');
search.value = 'mysql';
search.dispatchEvent(new dom.window.Event('input'));
assert.deepEqual(
  [...document.querySelectorAll('[data-role="kit-list-item"]')].map((item) => item.dataset.kitId),
  ['@itharbors/kit-mysql'],
);
document.querySelector('[data-filter="installed"]').click();
assert.equal(document.querySelectorAll('[data-role="kit-list-item"]').length, 1);
assert.match(document.querySelector('#kit-detail').textContent, /MySQL/);
```

另断言无结果时 `#kit-list-empty` 可见且文案为“没有符合条件的 Kit”，详情显示选择方向而不是旧内容。

- [ ] **Step 4: 运行聚焦测试并确认 RED**

运行：

```bash
node --test --test-name-pattern="搜索|筛选" scripts/lib/kit-manager-view.test.mjs
```

预期：FAIL，因为搜索和筛选控件尚未绑定。

- [ ] **Step 5: 实现 HTML 骨架和最小本地 UI 状态**

把 Stable/Preview 两个大分区替换为：

```html
<section class="manager-workspace">
  <aside class="kit-browser" aria-label="Kit 列表">
    <div class="kit-browser__toolbar">
      <label class="search-field">
        <span class="sr-only">搜索 Kit</span>
        <input id="kit-search" type="search" placeholder="搜索 Kit">
      </label>
      <div class="filter-tabs" role="tablist" aria-label="Kit 筛选">
        <button type="button" data-filter="all" aria-selected="true">全部</button>
        <button type="button" data-filter="installed" aria-selected="false">已安装</button>
        <button type="button" data-filter="updates" aria-selected="false">有更新</button>
      </div>
      <label class="channel-filter">
        <span>频道</span>
        <select id="channel-filter">
          <option value="stable">稳定版</option>
          <option value="preview">预览版</option>
        </select>
      </label>
    </div>
    <p id="kit-list-empty" class="kit-list-empty" hidden></p>
    <div id="kit-navigation" class="kit-navigation" role="listbox"></div>
  </aside>
  <section id="kit-detail" class="kit-detail" aria-live="polite"></section>
</section>
```

保留页面级 Registry 状态、操作状态和 Footer。View 中以本地 `uiState` 派生当前频道的可见记录，使用事件监听更新 query/filter/channel 并重新渲染。默认优先选择第一条已安装 Kit；刷新后用 `kit.id + channel` 保持选择。

- [ ] **Step 6: 实现紧凑列表条目**

新增 `createListItem(kit, channel, reference)`，使用 `<button type="button" role="option">`，只渲染名称、一行摘要、版本和单一状态。点击只更新 `selectedKitId`、`selectedChannel` 并重新渲染列表与详情，不调用 API。

- [ ] **Step 7: 运行 Task 1 测试并确认 GREEN**

运行：

```bash
node --test scripts/lib/kit-manager-view.test.mjs
```

预期：新增主从、搜索和筛选测试通过；旧的四区资源行测试会因预期结构已被替换而需要在本任务内删除或改写为列表契约测试，其他行为测试暂时保留到 Task 2/3 迁移。

- [ ] **Step 8: 提交主从骨架**

```bash
git add scripts/kit-manager.html scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m "[Bug] 重构 Kit 管理器主从工作区"
```

### Task 2: 实现详情标签、主操作与安装进行态

**Files:**

- Modify: `scripts/lib/kit-manager-view.mjs:160-398`
- Modify: `scripts/lib/kit-manager-view.test.mjs:180-380`
- Modify: `scripts/kit-manager.html:22-90`

**Interfaces:**

- Consumes: Task 1 的 `uiState` 和当前选择 `{ kit, channel, reference }`。
- Produces: `[role="tab"][data-detail-tab]`、`[role="tabpanel"]`、`.kit-detail__actions` 和 `.kit-detail__progress`。
- Reuses: `api.install(input)`、`api.activate(input)`、`api.deactivate(id)`、`api.uninstall(id)` 与现有确认文案。

- [ ] **Step 1: 写详情标签和权限语义的失败测试**

新增测试，选择包含 `filesystem` 与 `native-code` 的 Kit 后断言：

```js
assert.deepEqual(
  [...document.querySelectorAll('[data-detail-tab]')].map((tab) => tab.textContent),
  ['概览', '权限', '版本记录'],
);
document.querySelector('[data-detail-tab="permissions"]').click();
assert.match(document.querySelector('[role="tabpanel"]').textContent, /文件访问/);
const nativePermission = document.querySelector('[data-permission="native-code"]');
assert.match(nativePermission.textContent, /原生代码/);
assert.equal(nativePermission.dataset.risk, 'high');
```

切换回概览后断言当前频道、版本、发布者和验证状态可见。

- [ ] **Step 2: 运行测试并确认 RED**

```bash
node --test --test-name-pattern="详情标签|权限语义" scripts/lib/kit-manager-view.test.mjs
```

预期：FAIL，因为详情标签尚未实现。

- [ ] **Step 3: 写主操作和进行态的失败测试**

分别构造未安装、已安装未启用、已启用和可更新快照，断言详情主按钮文案依次为 `安装`、`启用`、`停用`、`更新`。复用 pending Promise 驱动安装：

```js
document.querySelector('[data-action="install"]').click();
await installStarted;
assert.equal(document.querySelector('.kit-detail__progress').hidden, false);
assert.match(document.querySelector('.kit-detail__progress').textContent, /正在下载并验证/);
assert.equal(document.querySelector('.kit-detail__spinner').getAttribute('aria-hidden'), 'true');
assert.equal(document.querySelector('[data-action="install"]').disabled, true);
```

安装完成和抛错后分别断言进度清理、操作状态与控件恢复。

- [ ] **Step 4: 运行测试并确认 RED**

```bash
node --test --test-name-pattern="主操作|安装进行态" scripts/lib/kit-manager-view.test.mjs
```

预期：FAIL，因为操作仍位于旧列表行。

- [ ] **Step 5: 实现详情标题、标签和权限面板**

新增 `renderDetail(selection)`：标题区包含名称、发布者、验证标记、摘要、状态和 `.kit-detail__actions`；标签按钮更新 `uiState.detailTab`。权限面板逐项使用 `PERMISSION_LABELS`，原生代码设置 `data-risk="high"`，权限缺失和无额外权限继续使用现有明确文案。

- [ ] **Step 6: 把主操作迁移到详情**

从旧 `createRow` 移除操作渲染，按以下优先级只渲染一个主按钮：

1. builtin → 禁用的“内置”；
2. 当前频道版本未安装 → “安装”或“更新”；
3. 当前频道版本已安装但未启用 → “启用”或“重试”；
4. 当前 Kit 有 active → “停用”。

删除放入详情 `…` 菜单按钮展开的本地菜单和详情底部危险区域，两处指向同一个 `uninstall(kit)`，但 DOM 任一时刻只保留一个可见删除按钮。操作进行时保持列表选择可用，只禁用会产生事务的 `button[data-action]` 与版本按钮。

- [ ] **Step 7: 把安装进度迁移到详情**

`install` 接收详情节点而不是旧 row，在确认后设置 `data-operation="install"`，显示 `.kit-detail__progress` 和圈形进度；成功或失败时在 `finally` 中清理。全局 `operation-status` 继续同步中文动作与公开错误。

- [ ] **Step 8: 运行 Task 2 测试并确认 GREEN**

```bash
node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-window.test.mjs
```

- [ ] **Step 9: 提交详情与操作**

```bash
git add scripts/kit-manager.html scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m "[Bug] 完善 Kit 详情与状态操作"
```

### Task 3: 用版本轨道替换历史版本下拉

**Files:**

- Modify: `scripts/lib/kit-manager-view.mjs:185-215,292-348`
- Modify: `scripts/lib/kit-manager-view.test.mjs:230-465`
- Modify: `scripts/lib/kit-manager-acceptance.test.mjs:416-459`

**Interfaces:**

- Consumes: `kit.installed.versions[]`、`active`、`pending`、`previous`、`badVersions[]`。
- Produces: `.version-track` 和 `[data-version][data-version-state]`，每个可操作版本包含 `[data-action="activate-version"][data-version]`。
- Reuses: `activateInstalledVersion(kit, version)`，继续传递 `{ id, version, retryBad }`。

- [ ] **Step 1: 写版本轨道排序和状态的失败测试**

使用 `versions: ['2.0.0', '1.10.0', '1.9.0']`、active `1.10.0`、bad `2.0.0`，切换到版本记录标签并断言：

```js
const nodes = [...document.querySelectorAll('.version-track [data-version]')];
assert.deepEqual(nodes.map((node) => node.dataset.version), ['2.0.0', '1.10.0', '1.9.0']);
assert.equal(nodes[0].dataset.versionState, 'bad');
assert.equal(nodes[1].dataset.versionState, 'active');
assert.equal(nodes[1].querySelector('[data-action="activate-version"]'), null);
assert.equal(nodes[2].dataset.versionState, 'installed');
```

停用快照中，最近版本的按钮文案应为“启用”；异常版本按钮文案为“重试”；普通历史版本为“切换”。

- [ ] **Step 2: 运行测试并确认 RED**

```bash
node --test --test-name-pattern="版本轨道" scripts/lib/kit-manager-view.test.mjs
```

预期：FAIL，因为 Renderer 仍使用 `<select data-role="installed-version">`。

- [ ] **Step 3: 写版本动作参数的失败测试**

点击普通历史版本和异常版本按钮，分别断言：

```js
['activate', { id: '@itharbors/kit-sqlite', version: '1.9.0', retryBad: false }]
['activate', { id: '@itharbors/kit-sqlite', version: '2.0.0', retryBad: true }]
```

并断言确认文案包含准确版本和“重新加载所有 Kit 窗口”。

- [ ] **Step 4: 运行测试并确认 RED**

```bash
node --test --test-name-pattern="版本动作" scripts/lib/kit-manager-view.test.mjs
```

- [ ] **Step 5: 实现版本轨道**

新增 `renderVersionTrack(kit)`，按现有 Manager 已提供的 SemVer 降序数组渲染版本节点。节点状态优先级为 active、pending、bad、installed；只为非 active/pending 节点创建显式按钮，并把版本写入 `data-version`。无已安装版本时显示“尚未保留本机版本”。

- [ ] **Step 6: 迁移端到端验收定位器**

在 `scripts/lib/kit-manager-acceptance.test.mjs` 中：

- 停用后点击 `[data-action="activate-version"][data-version="1.10.0"]`；
- 版本切换点击 `[data-action="activate-version"][data-version="1.2.3"]`；
- 删除在详情危险区域点击 `[data-action="uninstall"]`。

保留 runtime generation、Manager window identity、版本文件存在性和卸载删除文件的全部断言。

- [ ] **Step 7: 运行版本与验收测试并确认 GREEN**

```bash
node --test scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs
```

- [ ] **Step 8: 提交版本轨道**

```bash
git add scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs
git commit -m "[Bug] 改用版本轨道管理历史版本"
```

### Task 4: 落地 Harbors 视觉、响应式与最终验收

**Files:**

- Modify: `scripts/kit-manager.css:1-430`
- Modify: `scripts/lib/kit-manager-view.test.mjs:45-180`
- Modify only if verification exposes a defect: `scripts/kit-manager.html`
- Modify only if verification exposes a defect: `scripts/lib/kit-manager-view.mjs`

**Interfaces:**

- Consumes: Task 1–3 的 `.manager-workspace`、`.kit-browser`、`.kit-navigation`、`.kit-list-item`、`.kit-detail`、`.detail-tabs` 和 `.version-track`。
- Produces: 68px 品牌轨道、320px 桌面列表栏、`< 720px` 单页模式、可见焦点和 reduced-motion 行为。

- [ ] **Step 1: 写 CSS 布局和可访问性失败测试**

读取 CSS 并通过 JSDOM 断言：

```js
assert.equal(workspaceStyle.display, 'grid');
assert.equal(workspaceStyle.gridTemplateColumns, '320px minmax(0, 1fr)');
assert.equal(listItemStyle.display, 'grid');
assert.match(css, /@media\s*\(max-width:\s*719px\)/);
assert.match(css, /\.manager-workspace\[data-mobile-view="detail"\]/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /:focus-visible/);
```

另断言六个设计令牌和 `.version-track` 连接线存在，旧 `.kit-row__release`、`.kit-row__installed` 不再出现在 CSS。

- [ ] **Step 2: 运行测试并确认 RED**

```bash
node --test --test-name-pattern="主从视觉|响应式" scripts/lib/kit-manager-view.test.mjs
```

预期：FAIL，因为生产 CSS 仍是四列资源行。

- [ ] **Step 3: 实现桌面视觉**

把 CSS 收敛到规格中的六个颜色令牌。`.manager-workspace` 使用 `320px minmax(0, 1fr)`；列表表面与详情使用白色，选中条目使用 3px 操作蓝边线和低对比蓝背景。详情标题、标签、权限行和危险区域保持明确层级，删除不与主按钮同权重。

`.version-track` 使用伪元素绘制竖线和 10px 节点；active 为实心操作蓝，bad 为风险色，installed 为画布色空心节点。只在安装圈形进度和移动端面板切换使用动画。

- [ ] **Step 4: 实现窄屏单页模式**

在 `< 720px` 隐藏非当前面板；列表条目被选择后给 `.manager-workspace` 设置 `data-mobile-view="detail"`，详情顶部显示 `[data-action="back-to-list"]`。返回按钮仅改变本地 UI 状态。`prefers-reduced-motion: reduce` 下取消 spinner 动画和面板过渡。

- [ ] **Step 5: 运行 Manager 聚焦测试**

```bash
node --test scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/kit-manager-ipc.test.mjs scripts/lib/kit-manager-preload.test.mjs scripts/lib/kit-manager-window.test.mjs
```

- [ ] **Step 6: 用 Web 预览做桌面与窄屏视觉走查**

在生产预览页面验证：

- 1440×900 下列表和详情同时可见，首屏能看到至少四个列表条目；
- 搜索、已安装筛选、稳定/预览频道、详情标签和 `…` 菜单可用；
- 安装、更新、停用、启用和版本按钮状态清晰；
- 720px 边界上下无水平裁切，移动端返回列表可用；
- 长名称、长版本号、多权限和离线错误不溢出；
- 页面只有版本轨道一个高识别度装饰，背景网格和边线不过度竞争。

- [ ] **Step 7: 运行完整仓库检查**

```bash
CI=1 npm run check
```

预期：exit 0，所有测试失败数为 0。

- [ ] **Step 8: 启动 Electron 做最终验收**

使用仓库已有 Electron 启动命令打开 Kit Manager，确认原生窗口尺寸、键盘焦点、刷新、安装进行态、启停和版本切换与 Web/JSDOM 一致，Manager 本身不因热更新重启。

- [ ] **Step 9: 提交视觉和验收修复**

```bash
git add scripts/kit-manager.css scripts/kit-manager.html scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-manager-acceptance.test.mjs
git commit -m "[Bug] 完成 Kit 管理器 VS Code 式界面"
```

## Completion Audit

- [ ] 逐项对照设计规格，确认页面结构、状态、版本轨道、响应式和非目标均满足。
- [ ] `git diff --check` 与全部聚焦测试通过。
- [ ] `CI=1 npm run check` 使用最终工作树并返回 exit 0。
- [ ] Electron 原生窗口完成最终验收。
- [ ] `git status --short` 干净，提交仅包含本次 Kit Manager 和配套文档/测试。
