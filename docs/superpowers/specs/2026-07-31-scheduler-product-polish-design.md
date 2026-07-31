# Scheduler Product Polish Design

## Context

The Scheduler Kit already supports one-time and interval Node.js jobs, missed-trigger policies, manual runs, and retained history. A product walkthrough found that the first screen presents competing creation paths and does not give enough confidence about what will run and when.

The user approved the walkthrough recommendations by asking for the issues to be fixed without further questions.

## Product goal

Make creating a scheduled script predictable: the user should see one primary path, select a real local script, understand the active timezone, preview the next execution, and be prevented from accidentally creating an already-missed one-time job.

## Design

### Header and empty state

- Replace the oversized identity block and seconds clock with a compact product header.
- Show the service state and local timezone as operational metadata.
- Use direct Scheduler vocabulary: “定时脚本”, “计划任务”, and “即将执行”.
- Keep one primary “新建计划” action. The empty-state action remains only when the section header action is not rendered.
- Hide the upcoming-runs rail while no jobs exist unless the creation form is open.

### Plan editor

- Open the editor only after an explicit creation or edit action.
- Prefer a local file chooser when the host supports it, while retaining the absolute-path input as the source of truth and keyboard-accessible fallback.
- Display the local timezone next to time controls.
- Continuously derive an execution preview from the form values. Interval plans show the next three occurrences; one-time plans show the selected occurrence.
- Default new times five minutes into the future rather than one minute.
- Treat one-time times that are not more than 30 seconds in the future as invalid. This prevents an ordinary save from immediately entering the missed-trigger path.
- For an interval whose start has passed, preview the next future occurrence and explain that missed intervals are not replayed individually.
- Express the missed-trigger choices as outcomes in plain Chinese.

### Validation and action feedback

- Show persistent, field-adjacent errors for the plan name, script path, time, and interval.
- Translate service errors at the panel boundary and attach recognized script-path failures to that field.
- On submit, disable form actions and show “正在保存…”. Preserve the form if saving fails.
- Focus the first invalid field. When a form opens, focus the plan-name field and scroll the editor into view on stacked layouts.

### Responsive behavior

- Keep the two-column desktop workbench.
- Below 920px, render the editor before the jobs section while it is open so the response to “新建计划” is immediately visible.
- Maintain visible focus rings, reduced-motion behavior, and touch targets of at least 40px.

## Visual direction

The interface remains a restrained runtime control surface: deep harbor blue, signal amber, cool paper, and a narrow utility typeface for timestamps. The single signature element is the upcoming execution rail; English decorative labels and the large “S” badge are removed because they do not encode task state.

### Visual refinement after walkthrough

- Use a plain cool-gray canvas and opaque white surfaces. Remove the grid texture, glass blur, and repeated panel shadows; only the open editor receives a restrained elevation.
- Render service health and timezone as operational metadata instead of pill-shaped controls.
- When there are no jobs and creation is open, hide the empty jobs card and center the editor as the primary task.
- Keep amber exclusive to time and upcoming-execution semantics. Neutral empty markers use harbor blue.
- Hover states increase contrast without moving non-interactive cards or buttons. Pressed buttons move down one pixel, focus rings remain visible, and hover-only rules are limited to devices that support hover.
- Use the system Chinese UI type stack for headings and body copy, with tabular monospace numerals only where timing benefits from alignment.

## Testing

- Panel tests cover the single empty-state action, past one-time rejection, interval previews, localized path errors, busy feedback, and the updated header.
- Existing action, polling, history, and service tests remain green.
- The official `npm run kit:check -- scheduler` command verifies the publishable Kit.
- A local browser walkthrough verifies desktop and stacked layout behavior.
- The browser walkthrough also verifies button hover/pressed feedback, input hover/focus feedback, and the empty-editor composition.
