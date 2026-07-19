# SQLite Navigation and Toolbar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make object group headings visually consistent and give the data toolbar a stable two-row layout without wrapped button labels.

**Architecture:** Keep existing object grouping and data actions unchanged, but add shared semantic classes and two explicit toolbar row containers in the Panel renderer. CSS owns the visual unification, fixed row heights, nowrap behavior, and narrow-width horizontal overflow.

**Tech Stack:** TypeScript DOM APIs, CSS Grid/Flexbox, Vitest, jsdom.

## Global Constraints

- Shadow/system objects remain collapsed by default and read-only.
- Toolbar actions keep their existing handlers and disabled states.
- The toolbar has exactly two rows; controls never wrap text vertically.
- No service, protocol, or database behavior changes.

---

### Task 1: Lock the desired DOM and CSS behavior

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/tests/accessibility.test.ts`

**Interfaces:**
- Consumes: existing mounted Panel DOM and `index.css` source.
- Produces: regression coverage for `.object-group-title`, `.data-toolbar-row`, default-collapsed system objects, two-row grid sizing, and nowrap controls.

- [x] **Step 1: Add failing tests**

Add a Panel assertion that all four object kinds use `.object-group-title`, the shadow group is a closed `details[data-object-kind="shadow"]`, and its `summary` uses the shared title class. Add a toolbar assertion that `.data-toolbar` has exactly two `.data-toolbar-row` children, with record/search/export actions in the primary row and all filter controls in the filter row.

Add CSS assertions for a fixed two-row toolbar, a matching `.data-view` first track, shared group-title rules, hidden native summary markers, `white-space: nowrap`, and non-shrinking controls.

- [x] **Step 2: Verify RED**

Run: `npm run test -w @itharbors/kit-sqlite -- plugins/sqlite-workbench/tests/panel.test.ts plugins/sqlite-workbench/tests/accessibility.test.ts`

Expected: FAIL because the current renderer has one flat toolbar, system headings do not share a title class, and the required CSS contracts are absent.

### Task 2: Implement the unified navigation and toolbar layout

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`
- Modify: `docs/superpowers/specs/2026-07-19-sqlite-kit-product-fixes-design.md`

**Interfaces:**
- Produces: `.object-group-title`, `details[data-object-kind]`, `.data-toolbar-primary`, and `.data-toolbar-filters` DOM contracts.
- Consumes: existing `actionButton`, `groupSchemaObjects`, search/filter state, and action handlers without modification.

- [x] **Step 1: Implement the minimal renderer changes**

Assign the group kind to `data-object-kind`, apply `.object-group-title` to both `h2` and `summary`, and keep only shadow groups as closed `details`. Split toolbar children between primary and filter row containers while retaining the current order inside each row.

- [x] **Step 2: Implement the minimal CSS**

Set `.data-view` to a fixed two-row toolbar track, make `.data-toolbar` a two-row grid, and style each row as non-wrapping flex content with horizontal overflow. Unify `h2` and `summary` title rules and draw a small stateful arrow for the system group.

- [x] **Step 3: Verify GREEN and the repository**

Run: `npm run test -w @itharbors/kit-sqlite -- plugins/sqlite-workbench/tests/panel.test.ts plugins/sqlite-workbench/tests/accessibility.test.ts && npm run test -w @itharbors/kit-sqlite && node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench && npm run check && git diff --check`

Expected: every command exits 0; SQLite reports no failed tests.

- [x] **Step 4: Build, inspect in the running browser, commit, and push**

Run: `node scripts/ce-plugin.mjs build kits/sqlite/plugins/sqlite-workbench`, then stage the exact design, plan, Panel source, CSS, and test files; commit as `[Optimize] 统一 SQLite 导航与工具栏布局` and push the current branch.
