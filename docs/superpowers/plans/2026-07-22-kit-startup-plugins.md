# Kit Startup Plugins and Lazy Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an application-scoped startup plugin hook so background capabilities can start with Harbors while Kit sessions and windows remain lazy-loaded.

**Architecture:** Kit manifests declare `ce-editor.kit.startup.plugins`. The server owns an `ApplicationRuntime` that loads those plugins into a restricted runtime, exposes application bootstrap/menu APIs, and unloads them in reverse order. Electron starts the shell notification host first, waits for the application runtime, loads only the initial Kit window, and routes global menu actions separately from session menu actions. The Notifications Kit is split into a startup background plugin and an ordinary UI plugin.

**Tech Stack:** TypeScript, Node.js, Electron, Koa, Vitest, Node test runner, pnpm workspaces.

## Global Constraints

- [ ] Keep ordinary `ce-editor.kit.plugin` behavior session-scoped and backward compatible.
- [ ] Startup plugins must not receive session, panel, window, layout, or Kit APIs.
- [ ] A startup plugin failure degrades application startup but does not prevent the server or shell from running.
- [ ] A Kit session/window is created only when the user opens that Kit, except for the configured initial visible Kit.
- [ ] The Electron main process must not import or execute arbitrary Kit plugin code.
- [ ] Every production change starts with an observed failing test.
- [ ] Stage explicit paths only and use repository commit conventions.

## Task 1: Parse and Validate the Startup Plugin Manifest Slot

**Files:**

- Modify: `scripts/lib/kit-catalog.mjs`
- Modify: `scripts/lib/kit-catalog.test.mjs`
- Modify: `packages/server/src/plugin/resolver.ts`
- Modify: `packages/server/src/plugin/resolver.test.ts`

- [ ] **Step 1: Add failing Electron catalog tests**

Add fixtures that declare:

```json
{
  "ce-editor": {
    "kit": {
      "startup": { "plugins": ["@itharbors/notification-background"] },
      "plugin": ["@itharbors/notification-center"]
    }
  }
}
```

Assert `discoverKits()` returns `startupPlugins`, rejects non-string/duplicate entries, and rejects overlap between startup and ordinary plugins.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `node --test scripts/lib/kit-catalog.test.mjs`

Expected: assertions fail because `startupPlugins` is absent and invalid manifests are accepted.

- [ ] **Step 3: Implement catalog parsing**

Normalize both plugin arrays, preserve manifest order, and return:

```js
{
  name,
  label,
  menuRoot,
  directory,
  manifestPath,
  startupPlugins
}
```

Treat malformed startup declarations and startup/ordinary overlap as manifest errors so the invalid Kit is excluded with its diagnostic.

- [ ] **Step 4: Add failing server resolver tests**

Add a resolver entry point that resolves a plugin against a specific Kit directory and returns its real path. Test scoped packages, relative package roots, missing plugins, and symlink-equivalent paths.

- [ ] **Step 5: Run resolver tests and observe RED**

Run: `pnpm --filter @itharbors/server test -- resolver.test.ts`

- [ ] **Step 6: Implement canonical resolution**

Return canonical real paths so later application discovery can deduplicate identical startup plugins and detect same-name/different-path conflicts.

- [ ] **Step 7: Verify and commit**

Run:

```bash
node --test scripts/lib/kit-catalog.test.mjs
pnpm --filter @itharbors/server test -- resolver.test.ts
```

Commit: `[Feature] 支持 Kit 声明启动插件`

## Task 2: Add a Restricted Application Plugin Runtime

**Files:**

- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/server/src/framework/plugin/index.ts`
- Modify: `packages/server/src/framework/plugin/types.ts`
- Modify: `packages/server/src/framework/plugin/index.test.ts`
- Create: `packages/server/src/application/service-registry.ts`
- Create: `packages/server/src/application/service-registry.test.ts`

- [ ] **Step 1: Add failing runtime-scope tests**

Load a fixture plugin in application scope and assert its lifecycle receives only:

```ts
type ApplicationPluginRuntime = {
  plugin: PluginRuntime['plugin']
  menu: PluginRuntime['menu']
  message: PluginRuntime['message']
  service: PluginRuntime['service']
  host: PluginRuntime['host']
}
```

Assert `sessionId`, `kit`, `panel`, `window`, `layout`, `command`, and browser-facing APIs are absent. Also assert the session scope remains unchanged.

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `pnpm --filter @itharbors/server test -- framework/plugin/index.test.ts`

- [ ] **Step 3: Add explicit plugin load scopes**

Extend plugin loading with an options object:

```ts
type PluginLoadOptions =
  | { scope: 'session'; host: PluginRuntimeHost }
  | { scope: 'application'; host: ApplicationPluginRuntimeHost }
```

Build the runtime from a whitelist for each scope. Do not create a full editor runtime and delete fields afterward.

- [ ] **Step 4: Add failing service ownership tests**

Test that application plugins can register/get services, cannot overwrite another owner, and that `clearOwner(owner)` removes only that owner's registrations.

- [ ] **Step 5: Run service tests and observe RED**

Run: `pnpm --filter @itharbors/server test -- application/service-registry.test.ts`

- [ ] **Step 6: Implement the application service registry**

Expose owner-bound registration through the restricted runtime and preserve owner cleanup for rollback and shutdown.

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm --filter @itharbors/server test -- framework/plugin/index.test.ts application/service-registry.test.ts
pnpm --filter @itharbors/server typecheck
```

Commit: `[Feature] 新增应用级插件运行时`

## Task 3: Build ApplicationRuntime Discovery, Lifecycle, and Rollback

**Files:**

- Create: `packages/server/src/application/catalog.ts`
- Create: `packages/server/src/application/catalog.test.ts`
- Create: `packages/server/src/application/runtime.ts`
- Create: `packages/server/src/application/runtime.test.ts`
- Create: `packages/server/src/application/types.ts`
- Modify: `packages/server/src/config.ts`

- [ ] **Step 1: Add failing catalog tests**

Cover all discovery rules:

- multi-Kit mode scans all configured Kit roots;
- single-Kit mode scans only the selected Kit;
- same plugin name and same real path loads once;
- same plugin name and different real paths is a conflict;
- startup/ordinary overlap is rejected;
- deterministic order is Kit order then manifest order.

- [ ] **Step 2: Observe catalog RED**

Run: `pnpm --filter @itharbors/server test -- application/catalog.test.ts`

- [ ] **Step 3: Implement server-side startup discovery**

Return both loadable plugin specifications and per-Kit diagnostics. Discovery errors contribute to degraded status rather than throwing away all valid plugins.

- [ ] **Step 4: Add failing lifecycle tests**

Assert state transitions and cleanup:

```text
starting -> ready -> stopping -> stopped
starting -> degraded -> stopping -> stopped
```

For a failing plugin, assert only that owner's menus, routes, and services roll back. On dispose, assert successfully loaded plugins unload in reverse order.

- [ ] **Step 5: Observe runtime RED**

Run: `pnpm --filter @itharbors/server test -- application/runtime.test.ts`

- [ ] **Step 6: Implement ApplicationRuntime**

Expose:

```ts
interface ApplicationRuntime {
  start(): Promise<ApplicationBootstrap>
  getBootstrap(): ApplicationBootstrap
  triggerMenu(menuId: string): Promise<unknown>
  request(plugin: string, method: string, ...args: unknown[]): Promise<unknown>
  subscribe(listener: (event: ApplicationEvent) => void): () => void
  dispose(): Promise<void>
}
```

Attach menu and server-message contributions after each successful load. Validate that application plugins do not contribute panels, window entries, layouts, or browser message endpoints. Publish bootstrap updates when phase or menu state changes.

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm --filter @itharbors/server test -- application/catalog.test.ts application/runtime.test.ts
pnpm --filter @itharbors/server typecheck
```

Commit: `[Feature] 实现应用级启动插件生命周期`

## Task 4: Expose Application Bootstrap, Menu, and Event APIs

**Files:**

- Create: `packages/server/src/routes/application-bootstrap.ts`
- Create: `packages/server/src/routes/application-bootstrap.test.ts`
- Create: `packages/server/src/routes/application-menu-trigger.ts`
- Create: `packages/server/src/routes/application-menu-trigger.test.ts`
- Create: `packages/server/src/routes/application-events.ts`
- Create: `packages/server/src/routes/application-events.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/server.test.ts`

- [ ] **Step 1: Add failing route tests**

Verify:

- `GET /api/application/bootstrap` returns phase, plugin statuses, warnings, and menu tree;
- `POST /api/application/menu/trigger` invokes only application-owned menu items;
- `/sse/application` emits initial bootstrap and subsequent updates;
- invalid menu IDs return a client error;
- plugin method failures return structured errors without stopping the server.

- [ ] **Step 2: Observe route RED**

Run: `pnpm --filter @itharbors/server test -- routes/application-*.test.ts`

- [ ] **Step 3: Wire the routes**

Construct one ApplicationRuntime per server process. Keep it outside `SessionRuntimeRegistry`; session creation and disposal must not affect it.

- [ ] **Step 4: Add failing server lifecycle tests**

Assert `start()` awaits application startup before resolving, both `ready` and `degraded` permit listening, and `stop()` disposes sessions before the application runtime and server resources.

- [ ] **Step 5: Observe server RED**

Run: `pnpm --filter @itharbors/server test -- server.test.ts`

- [ ] **Step 6: Implement startup selection and disposal**

Pass an explicit single-Kit startup scope only when `CE_DEFAULT_KIT` was supplied by the launcher/user. In normal multi-Kit mode discover every Kit. Always make disposal idempotent.

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm --filter @itharbors/server test
pnpm --filter @itharbors/server typecheck
```

Commit: `[Feature] 提供应用级插件接口`

## Task 5: Make Electron Kit Windows Lazy and Consume Application Menus

**Files:**

- Modify: `scripts/electron.mjs`
- Modify: `scripts/electron.test.mjs`
- Modify: `scripts/lib/electron-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Create: `scripts/lib/application-runtime-client.mjs`
- Create: `scripts/lib/application-runtime-client.test.mjs`

- [ ] **Step 1: Add failing application client tests**

Test bootstrap fetching, application menu triggering, SSE parsing across split chunks, reconnect after disconnect, and explicit close without reconnect.

- [ ] **Step 2: Observe client RED**

Run: `node --test scripts/lib/application-runtime-client.test.mjs`

- [ ] **Step 3: Implement the Electron-side client**

Use HTTP from Electron main. Keep application menu state in the shell; never evaluate plugin modules there. Retry SSE with a bounded delay while the app is running.

- [ ] **Step 4: Add failing lazy-window and menu tests**

Assert:

- startup creates only the initial Kit window;
- tray selection creates a previously unopened Kit window;
- reopening an already loaded Kit focuses it without a new session;
- the application menu appears before any non-default Kit is opened;
- global items call `/api/application/menu/trigger`;
- session items continue through session IPC;
- notification shell service starts before the Framework wait.

- [ ] **Step 5: Observe launcher RED**

Run:

```bash
node --test scripts/lib/electron-launcher.test.mjs
node --test scripts/electron.test.mjs
```

- [ ] **Step 6: Replace eager prewarming**

Remove `prewarmKitWindows()`. After the server bootstrap reaches `ready` or `degraded`, create/show only the first catalog Kit. Preserve `openKit()` as the single lazy create-or-focus path used by tray clicks and notification actions.

- [ ] **Step 7: Compose application and session menus**

The app root is sourced from ApplicationRuntime. Loaded Kit roots are sourced from live sessions only. Keep tray entries for every discovered Kit so unopened Kits remain reachable.

- [ ] **Step 8: Verify and commit**

Run:

```bash
node --test scripts/lib/application-runtime-client.test.mjs
node --test scripts/lib/electron-launcher.test.mjs
node --test scripts/electron.test.mjs
pnpm check
```

Commit: `[Feature] 支持 Kit 窗口按需加载`

## Task 6: Split Notifications into Background and UI Plugins

**Files:**

- Modify: `kits/notifications/package.json`
- Create: `kits/notifications/plugins/notification-background/package.json`
- Create: `kits/notifications/plugins/notification-background/main/src/index.ts`
- Create: `kits/notifications/plugins/notification-background/main/src/index.test.ts`
- Create: `kits/notifications/plugins/notification-background/main/src/codex-skill-installer.ts`
- Create: `kits/notifications/plugins/notification-background/main/src/codex-skill-installer.test.ts`
- Delete: `kits/notifications/plugins/notification-center/main/src/codex-skill-installer.ts`
- Delete: `kits/notifications/plugins/notification-center/main/src/codex-skill-installer.test.ts`
- Modify: `kits/notifications/plugins/notification-center/package.json`
- Modify: `kits/notifications/plugins/notification-center/main/src/index.ts`
- Modify: `kits/notifications/plugins/notification-center/main/src/index.test.ts`
- Modify: `scripts/lib/notification-skill-resource.mjs`
- Modify: `scripts/lib/notification-skill-resource.test.mjs`
- Modify: `scripts/build-electron.mjs`

- [ ] **Step 1: Add failing split-plugin tests**

Assert the background plugin contributes only the global Install Skill action and server method, and the center plugin contributes notification history/read/delete/open-center UI without the installer.

- [ ] **Step 2: Observe plugin RED**

Run the notification plugin test commands defined by their packages.

- [ ] **Step 3: Move the installer into the startup plugin**

Create `@itharbors/notification-background`, move the installer implementation and resource ownership, and declare it under:

```json
"startup": {
  "plugins": ["@itharbors/notification-background"]
}
```

Keep `@itharbors/notification-center` under ordinary `plugin`.

- [ ] **Step 4: Update packaged resource resolution**

Build and resolve `notify-user` from the background plugin's output. Preserve development, packaged, interrupted-install, and atomic replacement behavior.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @itharbors/notification-background test
pnpm --filter @itharbors/notification-center test
node --test scripts/lib/notification-skill-resource.test.mjs
pnpm check
```

Commit: `[Feature] 拆分通知后台与界面插件`

## Task 7: Document, Verify, Review, and Update the Pull Request

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/guides/plugin-development.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-22-kit-startup-plugins-design.md` only if implementation decisions require clarification

- [ ] **Step 1: Update user and developer documentation**

Document the manifest field, application runtime restrictions, fail-soft behavior, single-Kit behavior, lazy Kit lifecycle, and Notifications Kit split. Include one minimal background plugin example.

- [ ] **Step 2: Run focused and full verification**

Run:

```bash
pnpm check
pnpm test
pnpm build
node --test scripts/*.test.mjs scripts/lib/*.test.mjs
```

Also launch the Electron app and manually verify:

1. only the initial Kit session/window exists after startup;
2. Install Notification Skill is present immediately;
3. opening another Kit creates it once and later focuses it;
4. external notification delivery updates the badge and displays a toast;
5. opening Notification Center lazily loads its Kit UI;
6. a simulated broken startup plugin yields degraded status while the app remains usable.

- [ ] **Step 3: Request code review and address findings**

Review against the approved design, runtime isolation, lifecycle cleanup, menu ownership, and regression risk. Re-run affected tests after every fix.

- [ ] **Step 4: Commit documentation**

Commit: `[Docs] 完善 Kit 启动插件文档`

- [ ] **Step 5: Push the feature branch and update PR #10**

Push `feature/notification-kit`, confirm CI status, and update the PR description with the new startup-plugin/lazy-loading architecture and verification evidence.
