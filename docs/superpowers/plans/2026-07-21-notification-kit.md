# Notification Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Notification Kit, loopback HTTP notification service, desktop badge/toast integration, and repository Skill that lets Agents notify the user.

**Architecture:** Electron owns an application-scoped in-memory notification store and a loopback-only HTTP server so notifications remain available when Kit windows are hidden or closed. A dedicated Kit accesses that Host through a server-side plugin, while a repository Skill invokes the same API through a Node helper. Pure state, HTTP, toast-queue, badge, and payload helpers stay outside Electron APIs so they can be tested deterministically.

**Tech Stack:** Node.js 20.19+, Electron 31, TypeScript 5, native Node HTTP/fetch, Vitest, Node test runner, existing ITHARBORS plugin/message/panel runtime.

## Global Constraints

- Bind the external API only to IPv4 loopback `127.0.0.1`; default port is exactly `17896` and `HARBORS_NOTIFICATION_PORT` is the only override.
- Keep all notification state in memory and retain at most 500 entries; do not add a persistence dependency.
- Accept only `info`, `success`, `warning`, and `error`; transient duration is 1,000–60,000 ms and defaults to 8,000 ms.
- Limit title to 120 characters, body to 2,000 characters, source to 80 characters, and request bodies to 16 KiB; reject undeclared fields.
- Display at most three desktop toasts, FIFO queue overflow, keep persistent toasts until closed, and never mark an auto-expired toast read.
- Preserve `contextIsolation: true` and `nodeIntegration: false`; do not expose arbitrary notification IDs through preload IPC.
- Keep web-only mode honest: the Kit loads but reports that the desktop Host is unavailable.
- Use exact branch-compatible commit titles in the form `[Feature] 中文摘要` without trailing punctuation.

---

## File Structure

- `scripts/lib/notification-host.mjs`: notification normalization, bounded store, subscription events, JSON HTTP routing, and Host lifecycle.
- `scripts/lib/notification-host.test.mjs`: state and real loopback HTTP coverage.
- `.agents/skills/notify-user/SKILL.md`: Agent-facing trigger rules and invocation contract.
- `.agents/skills/notify-user/scripts/notify.mjs`: CLI parsing and JSON request helper.
- `.agents/skills/notify-user/tests/notify.test.mjs`: helper/CLI tests without an Electron dependency.
- `kits/notifications/package.json`, `layout.json`, `main.html`, `secondary.html`, `vitest.config.ts`: Kit manifest and workspace shell.
- `kits/notifications/plugins/notification-center/main/src/index.ts`: server-side Host client and message methods.
- `kits/notifications/plugins/notification-center/panel.center/src/{index.html,index.ts,index.css}`: notification center UI.
- `kits/notifications/tests/kit-manifest.test.ts`: Kit composition and root test-gate assertions.
- `kits/notifications/plugins/notification-center/tests/{main.test.ts,panel.test.ts}`: Host-client and DOM behavior.
- `scripts/lib/notification-desktop.mjs`: toast queue, safe toast HTML, badge SVG, and count label helpers.
- `scripts/lib/notification-desktop.test.mjs`: queue/timer/escaping/badge tests.
- `scripts/notification-preload.cjs`: two-method toast IPC bridge.
- `scripts/electron.mjs`: Host lifecycle, toast windows, IPC, badge, tray, and Notification Kit focus integration.
- `scripts/lib/electron-launcher.mjs` and `.test.mjs`: unread-aware tray template contract.
- `package.json` and `package-lock.json`: workspace/test-gate registration.
- `readme.md`, `docs/architecture/system-overview.md`, `docs/architecture/runtime-flows.md`, and `docs/guides/developing-plugins-and-kits.md`: current behavior and Agent usage documentation.

### Task 1: Loopback Notification Store and HTTP API

**Files:**
- Create: `scripts/lib/notification-host.mjs`
- Create: `scripts/lib/notification-host.test.mjs`

**Interfaces:**
- Produces: `parseNotificationPort(value): number`; `createNotificationStore(options?): NotificationStore`; `createNotificationHost({ store, port?, host? }): { start(): Promise<number>, stop(): Promise<void> }`.
- `NotificationStore` exposes `create(input)`, `snapshot()`, `markRead(id)`, `markAllRead()`, `remove(id)`, `subscribe(listener)`, and `dispose()`.
- Store events have `{ type: 'created' | 'changed' | 'removed', notification?, id?, snapshot }` and fire after state mutation.

- [ ] **Step 1: Write failing state tests**

Add Node tests that inject `randomUUID` and `now`, then assert exact normalized output and lifecycle semantics:

```js
test('creates normalized notifications and updates unread state', () => {
  const store = createNotificationStore({
    randomUUID: () => 'notification-1',
    now: () => new Date('2026-07-21T10:00:00.000Z'),
  });
  const created = store.create({ title: ' Done ', body: 'Built', level: 'success' });
  assert.deepEqual(created, {
    id: 'notification-1', title: 'Done', body: 'Built', level: 'success',
    source: null, durationMs: 8000, persistent: false,
    createdAt: '2026-07-21T10:00:00.000Z', read: false,
  });
  assert.equal(store.snapshot().unreadCount, 1);
  assert.equal(store.markRead('notification-1').read, true);
  assert.equal(store.snapshot().unreadCount, 0);
});
```

Cover every rejected field/type/range, unknown IDs, event emission, read-all, deleting unread entries, 500-entry eviction preferring the oldest read entry, and `dispose()` idempotency.

- [ ] **Step 2: Run state tests and verify RED**

Run: `node --test scripts/lib/notification-host.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `notification-host.mjs`.

- [ ] **Step 3: Implement normalization and the bounded store**

Implement explicit allowed-key and size checks, immutable response copies, and typed application errors:

```js
const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const ALLOWED_INPUT_KEYS = new Set([
  'title', 'body', 'level', 'source', 'durationMs', 'persistent',
]);

export function createNotificationStore({
  randomUUID = crypto.randomUUID,
  now = () => new Date(),
  maxEntries = 500,
} = {}) {
  const notifications = [];
  const listeners = new Set();
  const api = {
    create(input) { return createEntry(notifications, listeners, input, { randomUUID, now, maxEntries }); },
    snapshot() { return snapshotEntries(notifications); },
    markRead(id) { return markEntryRead(notifications, listeners, id); },
    markAllRead() { return markAllEntriesRead(notifications, listeners); },
    remove(id) { return removeEntry(notifications, listeners, id); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); notifications.length = 0; },
  };
  return api;
}
```

Implement the named private helpers in the same module with no additional public surface.
`persistent: true` produces `durationMs: null`; optional empty body becomes `''`; absent source becomes
`null`. Eviction removes the first read entry found from the oldest end, otherwise the oldest entry.

- [ ] **Step 4: Write failing real HTTP tests**

Use `port: 0` so tests bind an OS-selected loopback port. Assert `GET /health`, create/list/read/read-all/delete, `Content-Type`, 400 validation JSON, 404/405, malformed JSON, and a payload larger than 16 KiB:

```js
const store = createNotificationStore({ randomUUID: () => 'id-1' });
const host = createNotificationHost({ store, port: 0 });
const port = await host.start();
const response = await fetch(`http://127.0.0.1:${port}/v1/notifications`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Agent finished' }),
});
assert.equal(response.status, 201);
assert.equal((await response.json()).id, 'id-1');
await host.stop();
```

- [ ] **Step 5: Run HTTP tests and verify RED**

Run: `node --test scripts/lib/notification-host.test.mjs`

Expected: state tests PASS and HTTP tests FAIL because `createNotificationHost` is not exported.

- [ ] **Step 6: Implement HTTP routing and lifecycle**

Use `node:http`, reject any configured host other than `127.0.0.1`, collect at most 16,384 bytes, and map `NotificationError` to its status/code. `start()` resolves the actual numeric port; `stop()` stops accepting connections, calls `store.dispose()`, and is idempotent.

- [ ] **Step 7: Run Task 1 verification**

Run: `node --test scripts/lib/notification-host.test.mjs`

Expected: all notification store and HTTP tests PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add scripts/lib/notification-host.mjs scripts/lib/notification-host.test.mjs
git commit -m '[Feature] 新增本地通知接口'
```

### Task 2: Agent Notification Skill and Safe CLI

**Files:**
- Create: `.agents/skills/notify-user/SKILL.md`
- Create: `.agents/skills/notify-user/scripts/notify.mjs`
- Create: `.agents/skills/notify-user/tests/notify.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `POST http://127.0.0.1:${port}/v1/notifications` from Task 1.
- Produces: `parseNotifyArgs(args): NotificationInput`; `sendNotification(input, options?): Promise<Notification>` and an executable Node CLI.

- [ ] **Step 1: Write failing CLI unit tests**

Test exact payload parsing, default source `Codex`, port selection, success output, non-2xx error text, unknown/missing flags, invalid level/duration, and connection failure. Inject `fetchImpl` into `sendNotification`:

```js
assert.deepEqual(parseNotifyArgs([
  '--title', 'Task done', '--body', 'Tests passed', '--level', 'success', '--persistent',
]), {
  title: 'Task done', body: 'Tests passed', level: 'success',
  source: 'Codex', persistent: true,
});
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `node --test .agents/skills/notify-user/tests/notify.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `notify.mjs`.

- [ ] **Step 3: Implement the helper and CLI entry**

Parse only `--title`, `--body`, `--level`, `--source`, `--duration`, and `--persistent`. Build the URL with `HARBORS_NOTIFICATION_PORT || '17896'`. Detect direct execution with `pathToFileURL(process.argv[1]).href === import.meta.url`; print the returned notification id on success and `Notification failed: <message>` to stderr before setting `process.exitCode = 1` on failure.

- [ ] **Step 4: Write the Skill instructions**

Use frontmatter `name: notify-user`. Require notifications for meaningful completion, blocked attention, or asynchronous failure; prohibit high-frequency progress spam. Document transient and persistent examples, health diagnosis, argument limits, and that Electron desktop mode must be running. Instruct agents to run the bundled script rather than hand-crafting JSON.

- [ ] **Step 5: Register the Skill test in the root gate and verify**

Append `.agents/skills/notify-user/tests/notify.test.mjs` to the existing `node --test` invocation in `package.json` without removing existing files.

Run: `node --test .agents/skills/notify-user/tests/notify.test.mjs`

Expected: all CLI tests PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add .agents/skills/notify-user/SKILL.md \
  .agents/skills/notify-user/scripts/notify.mjs \
  .agents/skills/notify-user/tests/notify.test.mjs package.json
git commit -m '[Feature] 新增 Agent 通知 Skill'
```

### Task 3: Notification Center Kit and Plugin

**Files:**
- Create: `kits/notifications/package.json`
- Create: `kits/notifications/layout.json`
- Create: `kits/notifications/main.html`
- Create: `kits/notifications/secondary.html`
- Create: `kits/notifications/vitest.config.ts`
- Create: `kits/notifications/tests/kit-manifest.test.ts`
- Create: `kits/notifications/plugins/notification-center/package.json`
- Create: `kits/notifications/plugins/notification-center/main/src/index.ts`
- Create: `kits/notifications/plugins/notification-center/tests/main.test.ts`
- Create: `kits/notifications/plugins/notification-center/panel.center/src/index.html`
- Create: `kits/notifications/plugins/notification-center/panel.center/src/index.ts`
- Create: `kits/notifications/plugins/notification-center/panel.center/src/index.css`
- Create: `kits/notifications/plugins/notification-center/tests/panel.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 snapshot/read/read-all/delete endpoints and `HARBORS_NOTIFICATION_PORT`.
- Produces plugin methods `getSnapshot()`, `markRead(id)`, `markAllRead()`, `removeNotification(id)`, and `openCenterPanel()` under `@itharbors/notification-center`.
- Produces Panel polling every 1,000 ms and visible unavailable/retry states.

- [ ] **Step 1: Write the failing Kit manifest test**

Assert name, menu root, the single plugin, single-panel layout, active panel, window titles, and root test-gate registration:

```ts
expect(pkg.name).toBe('@itharbors/kit-notifications');
expect(pkg['ce-editor'].kit.plugin).toEqual(['@itharbors/notification-center']);
expect(layout.windows[0].layout).toEqual({
  type: 'leaf', panel: '@itharbors/notification-center.center', panelType: 'simple',
});
expect(rootPackage.scripts.test).toContain('npm run test -w @itharbors/kit-notifications');
```

- [ ] **Step 2: Run manifest test and verify RED**

Run: `npx vitest run kits/notifications/tests/kit-manifest.test.ts`

Expected: FAIL because the Kit files do not exist.

- [ ] **Step 3: Add the Kit shell and workspace registration**

Create the manifest with package name `@itharbors/kit-notifications`, test script `vitest run --config vitest.config.ts`, menu root `{ "id": "notifications", "label": "Notifications" }`, default layout, main/secondary entries, and the single plugin. Add `npm run test -w @itharbors/kit-notifications` to the root test sequence. Run `npm install --package-lock-only` to register the workspace in `package-lock.json`.

- [ ] **Step 4: Write failing plugin Host-client tests**

Capture `editor.plugin.define`, import the main module with a query-string cache buster, call lifecycle `load`, and inject `globalThis.fetch`. Assert exact URLs/methods, URL-encoded IDs, returned JSON, the `204` delete path, structured Host error propagation, and connection failure rewritten as `Desktop notification service is unavailable`.

- [ ] **Step 5: Run main tests and verify RED**

Run: `npm run test -w @itharbors/kit-notifications -- --run plugins/notification-center/tests/main.test.ts`

Expected: FAIL because the plugin main entry is missing.

- [ ] **Step 6: Implement the plugin methods**

Build `HOST_BASE_URL` from the validated environment port. Use one `hostRequest(path, init?)` helper that parses success JSON, returns `undefined` for 204, includes Host error messages, and maps fetch connection errors to the unavailable message. Define these exact methods:

```ts
methods: {
  getSnapshot: () => hostRequest('/v1/notifications'),
  markRead: (id: unknown) => hostRequest(`/v1/notifications/${encodeId(id)}/read`, { method: 'POST' }),
  markAllRead: () => hostRequest('/v1/notifications/read-all', { method: 'POST' }),
  removeNotification: (id: unknown) => hostRequest(`/v1/notifications/${encodeId(id)}`, { method: 'DELETE' }),
  openCenterPanel: () => runtime.window.openPanel('@itharbors/notification-center.center'),
}
```

- [ ] **Step 7: Write failing Panel DOM tests**

In jsdom, mount with a mocked `message.request`, use fake timers, and assert title/count, new-to-old cards, level/source/time/body text, unread class, empty state, unavailable state, one-second refresh, mark-read, delete, mark-all-read, retry, and interval cleanup in `unmount()`.

- [ ] **Step 8: Run Panel tests and verify RED**

Run: `npm run test -w @itharbors/kit-notifications -- --run plugins/notification-center/tests/panel.test.ts`

Expected: FAIL because the Panel module is missing.

- [ ] **Step 9: Implement the accessible Panel**

Create semantic buttons and status output without `innerHTML` for notification data. Store a single interval id and an `inFlight` guard. On action success call `refresh()` immediately; on failure render the unavailable panel with a Retry button. Use `aria-live="polite"` for status and `time[datetime]` for timestamps. Style the center as a responsive dark workspace with level accents, readable wrapping, and visible keyboard focus.

- [ ] **Step 10: Build and run Task 3 verification**

Run:

```bash
node scripts/ce-plugin.mjs build kits/notifications/plugins/notification-center
npm run test -w @itharbors/kit-notifications
node scripts/ce-plugin.mjs check kits/notifications/plugins/notification-center
```

Expected: plugin builds/checks and all Notification Kit tests PASS.

- [ ] **Step 11: Commit Task 3**

```bash
git add kits/notifications package.json package-lock.json
git commit -m '[Feature] 新增通知中心 Kit'
```

### Task 4: Electron Toast Queue, Badge, Tray, and Host Integration

**Files:**
- Create: `scripts/lib/notification-desktop.mjs`
- Create: `scripts/lib/notification-desktop.test.mjs`
- Create: `scripts/notification-preload.cjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `createNotificationStore`, `createNotificationHost`, and events; Task 3 Kit package name `@itharbors/kit-notifications`.
- Produces: `createToastQueue({ limit, schedule, cancelSchedule, onShow, onHide })`; `createNotificationHtml(notification)`; `createBadgeOverlayDataUrl(count)`; `formatNotificationCount(count)`; unread-aware `buildTrayTemplate`.
- Preload exposes only `window.notificationToast.openCenter()` and `window.notificationToast.closeToast()`.

- [ ] **Step 1: Write failing pure desktop tests**

Use injected fake timers/adapters to assert three visible toasts, FIFO overflow, transient expiration, persistent no-timer behavior, manual close, removal, reflow callback order, and idempotent disposal. Assert HTML escapes `<`, `>`, `&`, quotes, badge displays `99+`, zero yields `null`, and labels use `Notifications (N)`.

```js
const queue = createToastQueue({
  limit: 3,
  schedule: (fn, ms) => timers.add(fn, ms),
  cancelSchedule: (token) => timers.delete(token),
  onShow: (notification) => shown.push(notification.id),
  onHide: (notification, reason) => hidden.push([notification.id, reason]),
});
```

- [ ] **Step 2: Run desktop tests and verify RED**

Run: `node --test scripts/lib/notification-desktop.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `notification-desktop.mjs`.

- [ ] **Step 3: Implement pure desktop helpers**

The queue keeps `visible` insertion order and `pending` FIFO order. It schedules only non-persistent items, calls `onHide(item, 'expired' | 'closed' | 'removed' | 'disposed')`, and promotes pending items after every hide. Generate toast HTML entirely from escaped strings, with `data-action="open"` and `data-action="close"` listeners calling the two preload methods. Generate a self-contained SVG data URL for Windows overlay badges.

- [ ] **Step 4: Extend tray template tests and implementation**

Pass `unreadCount` and `notificationKitName` into `buildTrayTemplate`. The matching Kit label is exactly `Notifications` at zero and `Notifications (4)` above zero; other Kit labels are unchanged. Keep existing unavailable/quit behavior and callbacks.

- [ ] **Step 5: Write source-level Electron lifecycle assertions**

Extend `electron-launcher.test.mjs` to read `scripts/electron.mjs` and assert it imports/starts/stops the Host, supplies the Host port to the child env, registers/removes both toast IPC handlers, applies badges to newly created Kit windows, and uses the dedicated preload. These assertions complement the pure adapter tests without booting Electron inside Node.

- [ ] **Step 6: Implement the dedicated preload**

Expose exactly:

```js
contextBridge.exposeInMainWorld('notificationToast', {
  openCenter: () => ipcRenderer.invoke('harbors:notification-open-center'),
  closeToast: () => ipcRenderer.invoke('harbors:notification-close-toast'),
});
```

- [ ] **Step 7: Integrate Host lifecycle into Electron**

Before `startFramework()`, create the store, subscribe the desktop adapter, start the Host, and assign the actual port. Spawn Framework with `{ ...process.env, HARBORS_NOTIFICATION_PORT: String(notificationPort) }`. During quit, stop accepting Host requests before destroying tray/framework resources, and dispose queue/window state idempotently.

- [ ] **Step 8: Integrate toast windows and safe IPC**

Import `screen`; create 360 px wide frameless, always-on-top, skip-taskbar BrowserWindows using `notification-preload.cjs`, `contextIsolation: true`, and `nodeIntegration: false`. Map `webContents.id` to notification id. IPC handlers infer the id from `event.sender.id`; open marks read, closes the toast, and focuses `@itharbors/kit-notifications`, while close only hides that toast. Position/reflow visible windows 16 px from the current display work-area right/bottom edge with 12 px gaps.

- [ ] **Step 9: Integrate badge and tray refresh**

On every store event, update `app.setBadgeCount` on non-Windows platforms; on Windows convert the SVG URL with `nativeImage.createFromDataURL` and call `setOverlayIcon` on every live Kit window. Set tray tooltip to `ITHARBORS — N unread notifications`, rebuild its context menu with the unread-aware template, and apply the current Windows overlay when a Kit window is created.

- [ ] **Step 10: Run Task 4 verification**

Run:

```bash
node --test scripts/lib/notification-desktop.test.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/notification-host.test.mjs
node -c scripts/notification-preload.cjs
npx tsc --noEmit
```

Expected: all Node tests PASS, preload syntax is valid, and TypeScript workspace check exits 0.

- [ ] **Step 11: Commit Task 4**

```bash
git add scripts/lib/notification-desktop.mjs scripts/lib/notification-desktop.test.mjs \
  scripts/notification-preload.cjs scripts/electron.mjs \
  scripts/lib/electron-launcher.mjs scripts/lib/electron-launcher.test.mjs package.json
git commit -m '[Feature] 集成桌面通知与任务栏角标'
```

### Task 5: Documentation, Full Verification, and Manual Electron Acceptance

**Files:**
- Modify: `readme.md`
- Modify: `docs/architecture/system-overview.md`
- Modify: `docs/architecture/runtime-flows.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`

**Interfaces:**
- Documents the exact API, Skill command, Electron-only limitation, lifecycle, and transient/persistent semantics produced by Tasks 1–4.

- [ ] **Step 1: Add current-behavior documentation**

Document Notification Kit in the Kit list and architecture. Add this executable Agent example:

```bash
node .agents/skills/notify-user/scripts/notify.mjs \
  --title "任务完成" \
  --body "构建与测试已通过" \
  --level success
```

Document `--persistent`, the `127.0.0.1:17896` default, `HARBORS_NOTIFICATION_PORT`, in-memory lifecycle, the fact that web-only mode has no desktop Host, and the six HTTP endpoints.

- [ ] **Step 2: Run focused verification from a clean build state**

Run:

```bash
npm run clean
node --test scripts/lib/notification-host.test.mjs \
  scripts/lib/notification-desktop.test.mjs \
  scripts/lib/electron-launcher.test.mjs \
  .agents/skills/notify-user/tests/notify.test.mjs
npm run test -w @itharbors/kit-notifications
node scripts/ce-plugin.mjs build kits/notifications/plugins/notification-center
node scripts/ce-plugin.mjs check kits/notifications/plugins/notification-center
```

Expected: every focused test/build/check PASS.

- [ ] **Step 3: Run the repository gate**

Run: `npm run check`

Expected: build, all tests, change-workflow tests, and all plugin checks PASS.

- [ ] **Step 4: Run Electron acceptance**

Start `npm run dev`, wait for `/health`, and create one 1,000 ms transient and one persistent notification with the Skill script. Verify:

- tray/launcher count becomes 2;
- two bottom-right toasts stack without covering each other;
- transient toast disappears after one second but remains unread in the center;
- persistent toast remains until close;
- clicking a toast marks it read and opens Notification Kit;
- Mark all read resets count and Delete removes history;
- closing Notification Kit does not stop later Skill notifications.

If the environment cannot expose a graphical desktop or a non-current OS, record the exact unverified visual/platform items; do not claim them from unit tests alone.

- [ ] **Step 5: Inspect scope and commit docs**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Confirm only notification feature, Skill, tests, generated plugin dist, lockfile, and related docs are present.

```bash
git add readme.md docs/architecture/system-overview.md \
  docs/architecture/runtime-flows.md docs/guides/developing-plugins-and-kits.md
git commit -m '[Feature] 完善通知 Kit 使用文档'
```

- [ ] **Step 6: Final branch audit**

Run:

```bash
git status --short
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: clean worktree, five implementation commits plus the design/plan commits, and no whitespace errors.
