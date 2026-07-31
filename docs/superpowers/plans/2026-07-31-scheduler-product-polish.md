# Scheduler Product Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Scheduler Kit’s first screen and plan editor predictable, concise, responsive, and safe against accidental missed-trigger execution.

**Architecture:** Keep the existing service contract and DOM-rendered panel. Add pure scheduling-preview and validation helpers inside the panel module, then compose the header, jobs region, workbench, and editor from the same snapshot. Server validation remains the final authority; the panel provides earlier localized guidance.

**Tech Stack:** TypeScript, DOM APIs, CSS, Vitest/jsdom, Harbors Kit tooling

## Global Constraints

- Work only in `kit-change/scheduler/feature/scheduled-scripts`.
- Do not change the Scheduler service contract or persistence format.
- A one-time run must be more than 30 seconds in the future when saved from the UI.
- Interval cadence remains anchored to its original start time.
- All user-facing copy added in this change is Chinese.
- Preserve keyboard focus visibility and reduced-motion behavior.

---

### Task 1: Product-facing panel behavior

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`

**Interfaces:**
- Consumes: existing `SchedulerSnapshot`, `JobSchedule`, and `saveJob` service request
- Produces: `validateJobForm(form, now)`, `nextPreviewTimes(schedule, now, count)`, localized inline form errors, and busy form state

- [ ] **Step 1: Write the failing tests**

Add tests that assert one empty-state creation button, a compact header with timezone, rejection of a one-time value within 30 seconds of `snapshot.now`, the next three interval times, localized script-path errors, and disabled “正在保存…” feedback while `saveJob` is pending.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Expected: the new assertions fail because the compact header, validation, preview, localization, and busy state do not exist.

- [ ] **Step 3: Implement the minimal panel behavior**

Update the render order and editor helpers so UI validation runs before `saveJob`, previews refresh on input/change, recognized service errors are localized next to the script field, and pending saves render a disabled button without closing the form.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Expected: all scheduler panel tests pass with no warnings.

### Task 2: Focused visual hierarchy and responsive editor

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css`
- Test: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

**Interfaces:**
- Consumes: semantic classes emitted by Task 1
- Produces: compact header, operational status chip, execution preview rail, inline errors, busy state, and editor-first stacked layout

- [ ] **Step 1: Add the failing structural assertions**

Assert that an open form marks the board with `is-editing`, the editor has a focusable heading, errors use `role="alert"`, and controls expose `aria-describedby`/`aria-invalid` relationships.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Expected: accessibility and editor-state assertions fail.

- [ ] **Step 3: Implement styles and semantic state**

Reduce header height, remove decorative identity styles, use a single action hierarchy, style inline guidance and previews, increase action targets, and use CSS grid areas so the editor precedes the list below 920px.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Expected: all panel tests pass.

### Task 3: Kit verification and visual walkthrough

**Files:**
- Verify: `kits/scheduler/**`

**Interfaces:**
- Consumes: completed panel behavior and styles
- Produces: verified Scheduler Kit and browser-reviewed local preview

- [ ] **Step 1: Run focused and full Kit checks**

Run: `npm test -- kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`

Run: `npm run kit:check -- scheduler`

Expected: both commands exit 0 with no test failures.

- [ ] **Step 2: Inspect repository changes**

Run: `git status --short`, `git diff --check`, and `git diff`.

Expected: only Scheduler product-polish files and their design/plan documentation changed; no whitespace errors.

- [ ] **Step 3: Walk through the local UI**

Open the existing Scheduler preview, verify the empty state, create form, interval preview, inline error, pending feedback, and stacked layout. Keep the working preview tab open for the user.

- [ ] **Step 4: Commit the implementation**

Stage only the listed documentation, panel source, stylesheet, and tests. Commit with `[Feature] 优化定时脚本创建体验`.

### Task 4: Walkthrough-driven visual refinement

**Files:**
- Modify: `kits/scheduler/plugins/scheduler-panel/tests/panel.test.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.ts`
- Modify: `kits/scheduler/plugins/scheduler-panel/panel.scheduler/src/index.css`

- [ ] **Step 1: Lock the empty-editor composition with a failing test**

Assert that opening creation with no jobs marks the board as `is-empty-editor`, omits the empty jobs section, and retains the editor.

- [ ] **Step 2: Implement the restrained control-surface visual system**

Flatten the canvas and panels, center an empty editor, simplify metadata, reserve elevation for the editor, and provide distinct hover, active, focus, and disabled states without false movement affordances.

- [ ] **Step 3: Verify and preview**

Run the focused panel tests, the Scheduler Kit check, build the Kit, and inspect the existing local preview at desktop and narrow widths.
