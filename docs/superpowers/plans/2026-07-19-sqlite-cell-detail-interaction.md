# SQLite Cell Detail Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent automatic cell-detail drawers during ordinary table browsing while preserving explicit full-value inspection for long text and BLOB values.

**Architecture:** Add a small pure predicate in the existing Panel module to decide whether a serialized value needs expansion. Render an accessible expand control only for those cells and reuse the existing read-only detail drawer without changing main-process protocols.

**Tech Stack:** TypeScript, DOM APIs, Vitest, jsdom, existing SQLite workbench styles.

## Global Constraints

- Single click selects the row and never opens field detail.
- Only long, multiline, or BLOB values expose field detail.
- Existing record-edit interactions and database write protections remain unchanged.
- No new dependency or server interface.

---

### Task 1: Make full-value inspection explicit

**Files:**
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts`
- Modify: `kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css`
- Test: `kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts`

**Interfaces:**
- Produces: `isExpandableCellValue(value: SerializedValue): boolean`
- Consumes: existing `formatValue`, `state.cellDetail`, `renderCellDetail`, and row-selection behavior.

- [x] **Step 1: Write failing Panel tests**

Add assertions that clicking a short cell selects its row without creating `[data-cell-detail]`, while values longer than 80 characters, multiline values, and BLOB values render one accessible expand button that opens the drawer. Assert the drawer contains a read-only label.

- [x] **Step 2: Verify the new tests fail for the expected reason**

Run: `npm run test -w @itharbors/kit-sqlite -- plugins/sqlite-workbench/tests/panel.test.ts`

Expected: FAIL because every cell currently opens the drawer and no explicit expand control/read-only label exists.

- [x] **Step 3: Implement the minimal behavior**

Treat BLOB values, multiline values, and formatted values longer than the table preview limit as expandable. Remove the cell single-click drawer action, render an accessible button only for expandable values, and make double-click open details only for those cells. Add the drawer's visible “只读字段” label and restrained button styling.

- [x] **Step 4: Verify focused and complete checks**

Run:

```bash
npm run test -w @itharbors/kit-sqlite -- plugins/sqlite-workbench/tests/panel.test.ts
npm run test -w @itharbors/kit-sqlite
node scripts/ce-plugin.mjs check kits/sqlite/plugins/sqlite-workbench
npm run check
git diff --check
```

Expected: all commands exit 0; the SQLite suite reports no failures.

- [x] **Step 5: Commit and push the exact files**

```bash
git add docs/superpowers/specs/2026-07-19-sqlite-cell-detail-interaction-design.md docs/superpowers/plans/2026-07-19-sqlite-cell-detail-interaction.md kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.ts kits/sqlite/plugins/sqlite-workbench/panel.workbench/src/index.css kits/sqlite/plugins/sqlite-workbench/tests/panel.test.ts
git commit -m "[Optimize] 调整 SQLite 字段详情交互"
git push
```
