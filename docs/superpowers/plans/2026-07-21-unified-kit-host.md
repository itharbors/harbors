# Unified Kit Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the separate single-Kit host mode while retaining `--kit` as a direct-start shortcut that augments the unified Catalog.

**Architecture:** Server and Client expose one mode-independent Kit host: the bare root is always the chooser and explicit Kit/session URLs mount the editor. Repository Kits are always discoverable; a configured external Kit is appended to both Server and Electron catalogs. Electron keeps lazy windows and uses `--kit` only to choose the one window opened after readiness.

**Tech Stack:** TypeScript, Node.js ESM, Electron, Vite, Vitest, Node test runner.

## Global Constraints

- `/` always renders the chooser and creates no session.
- `/kits/<id>` and `/?kit=<name-or-path>` remain direct editor entries.
- Public Catalog responses contain only `id`, `name`, and `label`.
- `KitHostMode`, Server `kitMode`, and `CE_KIT_MODE` are removed.
- `--kit` never filters repository Kits and never enables a separate runtime mode.
- A valid external `--kit` path is appended to the Catalog; invalid or missing explicit Kits fail startup.
- Electron creates no window without a selection and only the requested window with `--kit`.
- All Electron Kit windows use multi-Kit menu semantics.
- Implementation follows test-first red-green cycles.

---

### Task 1: Mode-independent public protocol and Client entry

**Files:**
- Modify: `packages/plugin-types/src/protocol/kit-catalog.ts`
- Modify: `packages/client/src/core/host-entry.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/tests/core/host-entry.test.ts`
- Modify: `packages/client/tests/index.test.ts`

**Interfaces:**
- Produces: `KitCatalogResponse = { kits: PublicKitCatalogEntry[] }` without `mode`.
- Produces: `selectHostEntry(url: URL): 'picker' | 'editor'`.
- Consumes: `GET /api/kits` and the existing `renderKitPicker*` functions.

- [x] **Step 1: Write failing Client tests**

Change the entry tests to require a chooser for the bare root with no mode argument and an editor for explicit `kit`, `session`, `sessionId`, `page`, or non-root URLs:

```ts
expect(selectHostEntry(new URL('http://localhost:8080/'))).toBe('picker');
expect(selectHostEntry(new URL('http://localhost:8080/?kit=mysql'))).toBe('editor');
expect(isKitCatalogResponse({ kits: [] })).toBe(true);
expect(isKitCatalogResponse({ mode: 'single', kits: [] })).toBe(true);
```

The final assertion intentionally proves extra fields are harmless while the required shape no longer needs `mode`. Update the source contract test to reject `catalog.mode` use.

- [x] **Step 2: Run tests and verify RED**

Run: `npm run test -w packages/client -- --run tests/core/host-entry.test.ts tests/index.test.ts`

Expected: FAIL because `selectHostEntry` still requires a mode and `KitCatalogResponse` requires it.

- [x] **Step 3: Implement the minimal protocol and Client change**

Delete `KitHostMode`, remove `mode` from `KitCatalogResponse`, change the selector to:

```ts
export function selectHostEntry(url: URL): HostEntry {
  if (url.pathname !== '/') return 'editor';
  for (const parameter of ['session', 'sessionId', 'kit', 'page']) {
    if (url.searchParams.has(parameter)) return 'editor';
  }
  return 'picker';
}
```

Call it as `selectHostEntry(new URL(window.location.href))` after Catalog validation.

- [x] **Step 4: Run tests and verify GREEN**

Run: `npm run test -w packages/client -- --run tests/core/host-entry.test.ts tests/index.test.ts`

Expected: all focused Client tests PASS.

---

### Task 2: Unified Server Catalog and routes

**Files:**
- Modify: `packages/server/src/assembly/kit-catalog.ts`
- Modify: `packages/server/src/routes/kit-catalog.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/tests/assembly/kit-catalog.test.ts`
- Modify: `packages/server/tests/routes/kit-catalog.test.ts`
- Modify: `packages/server/tests/integration/integration.test.ts`

**Interfaces:**
- Produces: `discoverKitCatalog(assembly: AssemblyConfig): Promise<KitCatalogEntry[]>`.
- Produces: `createKitCatalogRouter(catalogPromise)` returning `{ kits }`.
- Removes: `AppOptions.kitMode` and `ServerOptions.kitMode`.
- Preserves: `ServerOptions.defaultKit` as assembly fallback and optional external Catalog entry.
- Resolves: a Catalog package name to its verified internal directory before runtime creation.

- [x] **Step 1: Write failing Catalog and route tests**

Require repository discovery to stay complete when `defaultKit` selects a repository Kit and append a valid external Kit without removing repository entries:

```ts
const catalog = await discoverKitCatalog({ ...assembly(), defaultKit: externalDirectory });
expect(catalog.map((entry) => entry.name)).toEqual([
  '@itharbors/kit-default',
  '@example/external-kit',
  '@itharbors/kit-mysql',
]);
```

Update route and integration expectations to `{ kits: [...] }`, remove the single-mode integration case, and add a configured-external Server case that exposes built-in plus external entries without a session.

- [x] **Step 2: Run tests and verify RED**

Run: `npm run test -w packages/server -- --run tests/assembly/kit-catalog.test.ts tests/routes/kit-catalog.test.ts tests/integration/integration.test.ts`

Expected: FAIL because discovery still filters in single mode and routes still require/return mode.

- [x] **Step 3: Implement unified discovery**

Scan repository directories, resolve `assembly.defaultKit`, append its resolved directory to the candidate set, then read, directory-dedupe, validate, sort, and uniqueness-check the final entries. A selected external manifest is not silently ignored:

```ts
const explicitDirectory = await resolveKit(assembly.defaultKit, context);
directories.add(path.resolve(explicitDirectory));
```

Keep scanned invalid manifests ignored, but throw `Invalid Kit manifest for selected Kit` if the explicitly resolved directory cannot produce an entry.

- [x] **Step 4: Remove Server mode plumbing**

Remove `kitMode` from app/server options, remove `CE_KIT_MODE` parsing, call `discoverKitCatalog(assembly)`, and construct `createKitCatalogRouter(kitCatalogPromise)`. Return:

```ts
sendJson(res, 200, {
  kits: catalog.map(({ id, name, label }) => ({ id, name, label })),
});
```

- [x] **Step 5: Run tests and verify GREEN**

Run: `npm run test -w packages/server -- --run tests/assembly/kit-catalog.test.ts tests/routes/kit-catalog.test.ts tests/integration/integration.test.ts`

Expected: all focused Server tests PASS.

---

### Task 3: `--kit` development shortcut without host mode

**Files:**
- Modify: `scripts/lib/dev-launcher.mjs`
- Modify: `scripts/dev.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Produces: `createDevServerEnv(baseEnv, requestedKit)` that removes stale mode/default values and sets only an explicit default.
- Produces: `createDevPages(requestedKit)` that always lists the chooser and optionally a URL-encoded requested Kit.

- [x] **Step 1: Write failing launcher tests**

Require no-argument startup to clear inherited mode/default settings and explicit startup to retain only the requested default:

```js
assert.deepEqual(createDevServerEnv(base, ''), { PATH: '/bin' });
assert.deepEqual(createDevServerEnv(base, '@itharbors/kit-mysql'), {
  PATH: '/bin',
  CE_DEFAULT_KIT: '@itharbors/kit-mysql',
});
assert.deepEqual(createDevPages('@itharbors/kit-mysql')[0], ['Kit chooser', '/']);
assert.deepEqual(createDevPages('@itharbors/kit-mysql')[1], [
  'Requested Kit',
  '/?kit=%40itharbors%2Fkit-mysql',
]);
```

- [x] **Step 2: Run test and verify RED**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: FAIL because `CE_KIT_MODE` is still emitted and the root changes to Editor.

- [x] **Step 3: Implement launcher helpers and logs**

Delete inherited `CE_KIT_MODE` and `CE_DEFAULT_KIT`, set only an explicit `CE_DEFAULT_KIT`, always label `/` as `Kit chooser`, and insert a `Requested Kit` page using `encodeURIComponent(requestedKit)`. Remove the `Kit host mode` log from `scripts/dev.mjs`.

- [x] **Step 4: Run test and verify GREEN**

Run: `node --test scripts/lib/electron-launcher.test.mjs`

Expected: all Electron launcher script tests PASS.

---

### Task 4: Electron Catalog augmentation and unified menu behavior

**Files:**
- Modify: `scripts/lib/kit-catalog.mjs`
- Modify: `scripts/lib/kit-catalog.test.mjs`
- Modify: `scripts/lib/electron-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/electron.mjs`

**Interfaces:**
- Changes: `discoverKits({ rootDir, requestedKit })` returns all repository Kits plus a distinct external requested Kit.
- Produces: `resolveRequestedKitName(catalog, requestedKit, rootDir)` for canonical Electron window keys.
- Changes: `parseElectronOptions(args)` returns `{ requestedKit: string | null }` without mode.
- Changes: `createKitWindowUrl(startUrl, kit, workspace)` always writes `menuMode=multi`.

- [x] **Step 1: Write failing Electron Catalog tests**

Replace filtering assertions with augmentation assertions:

```js
const byPackage = await discoverKits({ rootDir, requestedKit: '@itharbors/kit-mysql' });
assert.deepEqual(byPackage.map((kit) => kit.name), [
  '@itharbors/kit-mysql',
  '@itharbors/kit-sqlite',
]);
const withExternal = await discoverKits({ rootDir, requestedKit: externalKit });
assert.equal(withExternal.length, 3);
```

Also require invalid or missing explicit Kits to reject while scanned invalid manifests remain ignored.

- [x] **Step 2: Write failing Electron launcher tests**

Require mode-free options and always-multi URLs:

```js
assert.deepEqual(parseElectronOptions([]), { requestedKit: null });
assert.deepEqual(parseElectronOptions(['--kit=mysql']), { requestedKit: 'mysql' });
assert.equal(new URL(createKitWindowUrl(startUrl, kit, workspace)).searchParams.get('menuMode'), 'multi');
```

Keep the initialization test proving only the requested Kit is auto-opened.

- [x] **Step 3: Run tests and verify RED**

Run: `node --test scripts/lib/kit-catalog.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: FAIL because requested Kits still filter the Catalog and Electron options still expose single mode.

- [x] **Step 4: Implement Catalog augmentation**

Always discover and validate the repository Catalog first. For a requested repository name/path, return the full Catalog unchanged. For a valid external directory, append it, rerun uniqueness validation, and sort by label/name. Unknown or invalid explicit values continue to throw.

- [x] **Step 5: Implement unified Electron semantics**

Remove mode from parsed options, make `createKitWindowUrl` always set `menuMode=multi`, call it without a mode argument, and always build the aggregate application menu:

```js
const template = buildMultiKitMenuTemplate({
  focusedSessionId: sessionId,
  sessions: getOrderedMenuSessions(),
}, adapters);
```

- [x] **Step 6: Run tests and verify GREEN**

Run: `node --test scripts/lib/kit-catalog.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: all focused Node tests PASS.

---

### Task 5: Documentation, full verification, and live acceptance

**Files:**
- Modify: `docs/architecture/kit-and-session-model.md`
- Modify: `docs/architecture/runtime-flows.md`
- Modify: `docs/architecture/system-overview.md`
- Modify: `docs/architecture/ui-system.md`
- Modify: `docs/guides/development-workflow.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`
- Modify: `readme.md`
- Modify: `docs/superpowers/plans/2026-07-21-unified-kit-host.md`

**Interfaces:**
- Documents: one host mode, stable paths, `--kit` shortcut, external Catalog augmentation, and in-app-browser workflow.

- [x] **Step 1: Update active documentation**

Remove claims that `--kit` enables single mode or changes `/`. Document that it prints a Requested Kit URL, Electron auto-opens only that Kit, repository Kits remain selectable, and external Kit paths are temporarily registered.

- [x] **Step 2: Run focused workspace suites**

Run: `npm run test -w packages/gateway`

Run: `npm run test -w packages/server`

Run: `npm run test -w packages/client`

Run: `node --test scripts/lib/kit-catalog.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: all focused suites PASS with zero failures.

- [x] **Step 3: Run repository verification**

Run: `npm run check`

Expected: build, all repository tests, change-workflow tests, and plugin checks exit 0.

- [x] **Step 4: Live-verify no-argument startup**

Start `npm run dev:web` on free ports. Record session count, open `/`, and prove the chooser contains Default/MySQL/SQLite without increasing the count. Open each stable path and verify `bootstrap.kitName` values remain isolated.

- [x] **Step 5: Live-verify repository `--kit` shortcut**

Start `npm run dev:web -- --kit @itharbors/kit-mysql` on free ports. Verify `/api/kits` still lists all repository Kits, `/` remains the chooser, the printed Requested Kit URL loads MySQL, and no other Kit runtime is created.

- [x] **Step 6: Live-verify an external Kit path**

Create a disposable valid Kit outside repository Catalog directories, start with its path, verify Catalog contains built-ins plus the external public entry, and verify both its stable `/kits/<id>` route and requested URL initialize that external Kit. Remove only the disposable fixture afterward.

- [x] **Step 7: Review, commit, and push**

Run `git diff --check`, inspect status and full staged diff, stage only plan-listed files, scan for credentials/session ids, and commit:

```text
[Bug] 统一 Kit 主机启动模型
```

Push `bug/kit-lifecycle` to update existing PR #8 and leave the no-argument chooser running on port 8080 for user review.
