# Scheduler Tabler-Style Admin Redesign

## Context

The Scheduler Kit already supports creating, editing, pausing, manually running, and deleting scheduled Node.js jobs, plus retained run history and missed-trigger policies. The current screen is visually cleaner than the first version, but it still reads as a collection of custom cards rather than a mature administration surface.

The approved reference is the open-source [Tabler Admin Template](https://preview.tabler.io/). The redesign borrows Tabler's information density, page hierarchy, data-table patterns, semantic status colors, and interaction feedback without importing Tabler or copying its application shell. Harbors already owns the outer navigation and window chrome.

## Product goal

Make Scheduler feel like a dependable back-office operations page. A user should be able to scan workload health, find a job, understand its next execution, perform common actions, and inspect recent failures without moving between competing cards.

## Scope

This change redesigns the existing Scheduler panel only. It does not change the service contract, persistence format, scheduling semantics, permissions, or Kit dependencies.

## Page structure

### Page header

- Render a compact breadcrumb line, `Scheduler / 定时脚本`, above the title.
- Keep the title and one-line description on the left.
- Render service health and timezone as quiet operational metadata.
- Keep `新建计划` as the only primary page action on the right.
- On narrow screens, stack the action below the title without hiding service health.

### Operational summary

Render four compact summary cards immediately below the header:

1. `计划总数`: all saved jobs.
2. `已启用`: enabled jobs.
3. `正在运行`: current active job IDs.
4. `失败记录`: failed or interrupted runs among the retained history.

All values come from the existing snapshot. Summary cards are informational and must not imply clickability. Status color appears only on the value marker, not as a full-card tint.

### Job management table

Replace the job-card grid with one bordered table card. Columns are:

- `计划`: job name with absolute script path as secondary monospace text.
- `触发规则`: human-readable once or interval schedule plus missed-trigger policy.
- `下次执行`: localized date/time, or `暂无安排` when disabled or exhausted.
- `状态`: semantic badge for running, enabled, or paused.
- `操作`: run, edit, pause/resume, and delete controls.

Desktop actions use compact labeled buttons. Below 760 px, each row becomes a stacked record while preserving the same content order and action names; the table header is visually hidden but semantics remain understandable.

Row hover uses a subtle cool-blue background and stronger border contrast, without translation or scale. The row itself is not clickable. Destructive styling stays quiet until the delete control is hovered or focused.

When no jobs exist, the table card remains as the stable page anchor and shows one concise empty row with guidance. The header's `新建计划` button remains the single creation action.

### Plan editor drawer

Creation and editing open a fixed right-side drawer rather than changing the main grid. The drawer:

- Is 480 px wide on desktop and full width below 620 px.
- Uses a dimmed backdrop and `role="dialog"` with an accessible name.
- Keeps its header and action footer sticky while fields scroll independently.
- Closes from `取消`, the close button, the Escape key, or backdrop click when no save is pending.
- Warns before closing when fields have been changed.
- Traps focus while open and restores focus to the action that opened it.

The form keeps all existing fields, validation, local script chooser, timezone guidance, schedule preview, and pending-save state. Related interval inputs share one compact grid. Schedule preview becomes a Tabler-style alert panel with the next occurrences listed in tabular numerals.

### Run history table

Render retained history as a second table card below jobs. Columns are:

- status signal and plan name;
- trigger source;
- scheduled/start time;
- duration or running state;
- output disclosure.

The disclosure remains native `details`/`summary`. Output uses a dark monospace panel. Deleted jobs continue to display `已删除计划`, never the raw job ID.

## Visual system

Use a local token layer inspired by Tabler:

- Canvas: `#f6f8fb`
- Surface: `#ffffff`
- Primary text: `#182433`
- Muted text: `#667382`
- Border: `#e6e7e9`
- Primary blue: `#066fd1`
- Success: `#2fb344`
- Warning: `#f59f00`
- Danger: `#d63939`

Use the system Chinese UI font stack for content and a system monospace stack for paths, dates, and aligned values. Cards use an 8 px radius, one-pixel borders, and no default elevation. The drawer is the only elevated surface.

Buttons, rows, inputs, disclosures, and the drawer close control have distinct hover, active, focus-visible, and disabled states. Hover rules are scoped to hover-capable devices. Motion uses only transform and opacity, is brief, and is disabled by `prefers-reduced-motion`.

## Behavior and data flow

The panel continues to render from `SchedulerSnapshot`. Summary metrics and table rows are derived during rendering and do not create new service calls. Existing action handlers remain the source of mutations. Opening the drawer preserves polling behavior; background snapshots update service status and records without replacing unsaved form input.

The drawer introduces local presentation state for its open/closed status, dirty state, and focus restoration. Saving still validates in the panel before calling `saveJob`, then refreshes the snapshot after success.

## Error and empty states

- Service-unavailable state remains a full-page recovery surface with a specific retry action.
- Action errors appear as a compact page alert above the summary cards.
- Field errors remain adjacent to their inputs and focus the first invalid field.
- Empty jobs and empty history render inside their respective table cards so page geometry stays stable.
- Saving disables drawer dismissal and shows `正在保存…` on the primary action.

## Accessibility

- Preserve semantic headings, regions, tables, buttons, labels, time elements, and native disclosures.
- Add a skip link to the main job table.
- The drawer uses dialog semantics, focus containment, Escape handling, focus restoration, and scroll containment.
- All icon-only controls have Chinese `aria-label` values and decorative SVGs use `aria-hidden="true"`.
- Use visible `:focus-visible` treatment and never depend on color alone for status.
- Keep touch targets at least 40 px and browser zoom unrestricted.

## Testing

Panel tests will cover:

- the four summary metrics;
- job and history table structure and content;
- empty-table creation behavior;
- drawer open/close semantics and focus restoration;
- Escape and dirty-close confirmation;
- existing form validation, preview, pending-save, polling, and actions;
- semantic badges and accessible labels.

Verification includes the focused panel suite, the complete Scheduler Kit suite, the official `kit:check`, and a local browser walkthrough at desktop and narrow widths. The walkthrough checks normal, hover, focus, drawer, empty, populated, and unavailable states.

## Out of scope

- Importing Bootstrap, Tabler CSS, or a component framework.
- Adding search, sorting, pagination, bulk actions, dark mode, or new scheduler APIs.
- Recreating Tabler's global sidebar, navigation bar, account menu, or notifications.
- Changing scheduling or missed-trigger behavior.
