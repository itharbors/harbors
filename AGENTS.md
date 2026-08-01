# Harbors repository instructions

## Development validation

- For ordinary Kit changes whose behavior is shared by the Web and Electron hosts, use `npm run dev:web` and browser-based testing by default to develop, debug, and complete final acceptance.
- Use Electron when a change depends on or alters desktop-only behavior such as the Tray, BrowserWindow lifecycle, native dialogs, desktop IPC, notifications, updates, packaging, operating-system integration, or an explicit Web/Electron difference.
- When a change spans shared Kit behavior and desktop-only behavior, validate the shared path in the browser and the desktop-specific path in Electron. An Electron smoke check remains optional for ordinary Kit changes, not a universal gate.

## Commit messages

Use exactly one of these title formats:

- `[Init] 摘要` — repository initialization only.
- `[Feature] 摘要` — new features and their accompanying tests or documentation.
- `[Bug] 摘要` — bug and regression fixes.
- `[Docs] 摘要` — standalone documentation changes.
- `[Refactor] 摘要` — structure and maintainability changes without intended behavior changes.
- `[Optimize] 摘要` — performance and resource-usage improvements.
- `[Test] 摘要` — standalone test changes.
- `[Chore] 摘要` — dependencies, build tooling, and routine maintenance.

Keep the tag capitalization exact, write a concise Chinese summary without a trailing period, and keep each commit focused on one reviewable change. See `docs/guides/development-workflow.md` for the full convention.
