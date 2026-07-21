# MySQL Connection Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复单 Kit 浏览器中 MySQL 连接栏的裁切、折行和重叠。

**Architecture:** 将连接栏由三列单行网格改成品牌区跨行、表单与状态上下分层的两列网格。Kit 布局、面板声明和 CSS 统一使用 112px 高度。

**Tech Stack:** TypeScript、CSS Grid、Vitest、Electron 单 Kit 开发服务器

## Global Constraints

- 保留现有深色 MySQL 工作台视觉语言。
- 不改变连接逻辑、主工作区或对象栏。
- 1092px 面板宽度下不得裁切、重叠或折行操作按钮。

---

### Task 1: 连接栏响应式结构

**Files:**
- Modify: `kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts`
- Modify: `kits/mysql/tests/kit-manifest.test.ts`
- Modify: `kits/mysql/plugins/mysql-explorer/panel.connection/src/index.css`
- Modify: `kits/mysql/plugins/mysql-explorer/package.json`
- Modify: `kits/mysql/layout.json`

**Interfaces:**
- Consumes: 现有 `.connection-deck`、`.connection-form`、`.connection-readout` DOM 结构
- Produces: 112px 两层连接栏布局

- [ ] **Step 1: Write the failing test**

  断言 Kit 分栏和面板最小高度为 112px，并断言 CSS 使用两层网格、品牌跨行、状态位于第二行、按钮不可换行。

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts kits/mysql/tests/kit-manifest.test.ts`

  Expected: FAIL，现有值仍为 78px/70px 且没有两层布局规则。

- [ ] **Step 3: Write minimal implementation**

  将布局和面板最小高度改为 112px；CSS 网格使用 `194px minmax(720px, 1fr)` 两列及两行，品牌跨行，表单与状态分别占右侧两行，并禁止按钮文字换行。

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- kits/mysql/plugins/mysql-explorer/tests/connection-panel.test.ts kits/mysql/tests/kit-manifest.test.ts`

  Expected: PASS。

- [ ] **Step 5: Build and visually verify**

  Run: `node scripts/ce-plugin.mjs build kits/mysql/plugins/mysql-explorer`

  在内置浏览器中刷新页面，读取连接面板尺寸并截图，确认内容高度不超过 112px且控件不重叠。

- [ ] **Step 6: Run the repository checks**

  Run: `npm run check`

  Expected: PASS。

- [ ] **Step 7: Commit**

  Stage only the five implementation/test files and these design documents, then commit with `[Bug] 修复 MySQL 连接栏布局`.
