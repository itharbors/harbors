# Harbors repository instructions

## Development validation

- Use `npm run dev:web` and browser-based testing by default to develop, debug, and complete acceptance for Framework and Kit changes.
- Harbors has one supported Web host. Do not add Electron, desktop packaging, native window lifecycle, tray, updater, or desktop IPC assumptions to Framework or Kit code.
- Validate server-side changes with focused tests and validate visible shared behavior in the browser.

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
