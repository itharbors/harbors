# CSV Theme Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every CSV panel render with the same dark workbench palette and visual hierarchy as the SQLite Kit, even when the Harbors iframe host forces `html` and `body` to be transparent.

**Architecture:** Keep the four CSV panels isolated and self-contained, but give each one the same semantic color tokens used by SQLite. Apply the opaque workbench surface to each panel's real full-size root container rather than relying on `body`, while preserving the CSV delimiter ruler, file facts, and field-ledger identity.

**Tech Stack:** CSS, TypeScript, Vitest, Harbors panel build pipeline

## Global Constraints

- The CSV Kit remains read-only and keeps all existing interaction behavior.
- Do not change virtualized row/header dimensions in this visual fix.
- Use SQLite's exact semantic colors: ink `#0b1116`, deck `#121a21`, raised deck `#18222a`, grid `#26323b`, strong grid `#374650`, text `#dce5e8`, muted text `#84949d`, teal `#57c8b5`, amber `#e2b86b`, and coral `#ff7d72`.
- Teal communicates primary/active/success, amber communicates focus/readonly/indexing/CSV delimiter instrumentation, and coral communicates errors.
- Each panel's real root container must paint its own dark background because the host may override `html` and `body` to transparent.

---

### Task 1: Protect the panel theme contract

**Files:**
- Modify: `kits/csv/package.json`
- Modify: `kits/csv/tests/panel-accessibility.test.ts`
- Modify: `kits/csv/tests/kit-manifest.test.ts`
- Modify: `kits/csv/plugins/csv-explorer/panel.connection/src/index.css`
- Modify: `kits/csv/plugins/csv-explorer/panel.explorer/src/index.css`
- Modify: `kits/csv/plugins/csv-data/panel.data/src/index.css`
- Modify: `kits/csv/plugins/csv-data/panel.schema/src/index.css`
- Modify: `kits/csv/plugins/csv-data/tests/data-panel.test.ts`

**Interfaces:**
- Consumes: built panel `dist/index.css` files produced by `npm run build -w @itharbors/kit-csv`.
- Produces: four opaque, dark CSV panel roots sharing SQLite's semantic theme tokens.

- [ ] **Step 1: Write the failing regression test**

Add Vitest coverage that reads the four built stylesheets, verifies dark color-scheme and canonical SQLite tokens, verifies that `.csv-connection`, `.field-ledger`, and both `.workspace` roots paint an opaque workbench background, and locks the Kit host accent to SQLite's `#56b6a9`.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `npm run build -w @itharbors/kit-csv && npx vitest run --config kits/csv/vitest.config.ts kits/csv/tests/panel-accessibility.test.ts`

Expected: FAIL because the current CSV stylesheets use the brass/sage palette and leave the real panel roots transparent.

- [ ] **Step 3: Apply the SQLite visual language to all four CSV panels**

Replace the CSV brass/sage surface tokens with SQLite's semantic dark tokens, add `color-scheme: dark`, paint the four real roots, align the Kit host accent, and remap primary, focus, success, readonly/indexing, selected, and error states. Keep existing DOM contracts and virtualized dimensions unchanged.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `npm run build -w @itharbors/kit-csv && npx vitest run --config kits/csv/vitest.config.ts kits/csv/tests/panel-accessibility.test.ts`

Expected: PASS.

- [ ] **Step 5: Run complete verification and inspect the real UI**

Run:

```bash
CSV_THEME_OUTPUT="$(mktemp -d)"
npm test -w @itharbors/kit-csv
npm run kit:check -- csv --output-directory "$CSV_THEME_OUTPUT"
```

Reload the existing CSV Kit URL in the in-app browser and compare connection, explorer, data, and schema panels against the SQLite Kit at the same viewport. Confirm no white/transparent panels remain and capture a screenshot.

- [ ] **Step 6: Commit and push**

```bash
git add docs/superpowers/plans/2026-07-25-csv-theme-alignment.md kits/csv/package.json kits/csv/tests/kit-manifest.test.ts kits/csv/tests/panel-accessibility.test.ts kits/csv/plugins/csv-explorer/panel.connection/src/index.css kits/csv/plugins/csv-explorer/panel.explorer/src/index.css kits/csv/plugins/csv-data/panel.data/src/index.css kits/csv/plugins/csv-data/panel.schema/src/index.css kits/csv/plugins/csv-data/tests/data-panel.test.ts
git commit -m "[Bug] 修复 CSV 主题背景与配色"
git push
```
