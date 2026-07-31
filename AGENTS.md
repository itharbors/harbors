# Harbors repository instructions

## Development validation

- Prefer `npm run dev:web` and browser-based testing during routine development when the behavior is shared by the Web and Electron hosts.
- Use Electron during development when the change depends on desktop-only behavior such as the Tray, BrowserWindow lifecycle, native dialogs, desktop IPC, notifications, updates, packaging, or operating-system integration.
- Always complete final acceptance in Electron; passing Web tests does not replace the Electron acceptance gate.

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
