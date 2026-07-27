# Dynamic Kit Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one explicit Kit source snapshot authoritative across desktop startup, Server sessions, window assets, Catalog conflicts, Tray, stable builds, packaging, tests, and documentation.

**Architecture:** Electron resolves the Catalog once and passes an immutable `kitSources` snapshot to Server. Server resolves Kits only from that snapshot and retains the selected directory inside each Editor for safe window-entry serving. Catalog conflict resolution, stable plugin discovery, and desktop staging share source priority or `BUILTIN_KITS` declarations instead of independent scans and lists.

**Tech Stack:** Node.js 22, TypeScript, ESM, Vitest, Node test runner, Electron launcher scripts, npm workspaces.

## Global Constraints

- Use strict TDD for every behavior change: add one regression, observe the expected failure, implement minimally, and observe green before refactoring.
- Production Kit resolution accepts only explicit `kitSources`; remove `HARBORS_INSTALLED_KITS`, `installedKitDirs`, and Kit-directory scan fallbacks without a compatibility bridge.
- Source priority is exactly one-shot requested `explicit` > `builtin` > `development` > `installed`; same-priority different-directory ambiguity isolates the entire conflict group without fallback.
- Duplicate references to the same real directory are deduplicated before conflict grouping.
- Window entry paths remain Server-internal, must resolve to ordinary files inside the active Kit real root, and must not enter bootstrap payloads.
- `npm run start` keeps its existing command and uses a stable build that excludes non-builtin repository Kits; root `npm run build` retains full-repository behavior.
- `BUILTIN_KITS` is the only Kit allowlist for stable build and desktop staging; its current only member is Default Kit.
- Unavailable workspace records remain persisted but are not rendered in Tray.
- Do not add dependencies, Kit lifecycle features, UI diagnostics, or generated build artifacts to Git.
- Commit titles use `[Bug]` followed by a concise Chinese summary with no trailing period.

---

### Task 1: Authoritative Server Snapshot and Installed Window Entries

**Files:**
- Modify: `packages/server/src/assembly/config.ts`
- Modify: `packages/server/src/assembly/kit-catalog.ts`
- Modify: `packages/server/src/plugin/resolver.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/server/src/editor/index.ts`
- Modify: `packages/server/src/routes/window-entry.ts`
- Modify: `packages/server/tests/helpers/assembly.ts`
- Test: `packages/server/tests/integration.test.ts`
- Test: `packages/server/tests/application/client-asset.test.ts`
- Test: `packages/server/tests/application/server-lifecycle.test.ts`
- Test: `packages/server/tests/application/catalog.test.ts`
- Test: `packages/server/tests/assembly/config.test.ts`
- Test: `packages/server/tests/assembly/kit-catalog.test.ts`
- Test: `packages/server/tests/plugin/resolver.test.ts`
- Test: `packages/server/tests/framework/editor.test.ts`
- Test: `packages/server/tests/integration/integration.test.ts`
- Test: `packages/server/src/framework/__tests__/editor.test.ts`

**Interfaces:**
- Consumes: `AssemblyKitSource { directory: string; source: KitSourceKind }` from `assembly/config.ts`.
- Produces: required `AssemblyConfig.kitSources: AssemblyKitSource[]`, required `ServerOptions.kitSources` when no full `assembly` is supplied, and internal `Editor.kit.getCurrentDirectory(): string | undefined`.
- Produces: `resolveKit(nameOrPath, { kitSources })` with no directory scan fallback.

- [ ] **Step 1: Add failing explicit-source and window-entry integration tests**

Add a real temporary installed Kit fixture to `packages/server/tests/integration/integration.test.ts`. Supply:

```ts
kitSources: [
  { directory: defaultKitDirectory, source: 'builtin' },
  { directory: installedKitDirectory, source: 'installed' },
],
defaultKit: '@fixture/installed-kit',
```

Create literal `main.html` and `secondary.html` contents, create a session, then assert both
`/api/window-entry/main?sessionId=<id>` and `/api/window-entry/secondary?sessionId=<id>` return status 200 and contain their respective literal markers. The production change caught is the route attempting repository scans instead of the selected installed directory.

In `config.test.ts` and `plugin/resolver.test.ts`, add tests proving an absent/empty source snapshot is rejected and `resolveKit` never finds a Kit that exists only under `kitsDir`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test -w packages/server -- --run \
  tests/integration/integration.test.ts \
  tests/assembly/config.test.ts \
  tests/plugin/resolver.test.ts
```

Expected: the installed window-entry assertions fail with `KIT_ENTRY_NOT_FOUND`, and legacy/default scan expectations fail because production still accepts scan configuration.

- [ ] **Step 3: Make `kitSources` the only Server Kit resolution input**

Change `AssemblyConfig` so `kitSources` is a required array and remove `installedKitDirs`. Keep plugin directories and legacy Kit directory fields only if a non-Kit consumer still needs them; no Kit resolver may read them. Normalize with a defensive absolute-path copy:

```ts
kitSources: (override.kitSources ?? fileConfig.kitSources).map((item) => ({
  directory: path.resolve(item.directory),
  source: item.source,
})),
```

Make `listAssemblyKitSources` return only the normalized snapshot. Make `KitResolveContext` contain only `kitSources`, and make `resolveKit` search paths/names only within it.

Delete `parseInstalledKitDirs`, the `ServerOptions.installedKitDirs` field, and the `HARBORS_INSTALLED_KITS` read in `src/index.ts`. `parseKitSources(undefined)` must throw the existing `HARBORS_KIT_SOURCES` validation error; an explicit JSON `[]` must also fail because a runnable Server needs at least one source. If `createServer` receives `assembly`, use its sources; otherwise require `options.kitSources` before creating stores or opening a port.

- [ ] **Step 4: Retain the active Kit directory inside Editor and serve entries from it**

Add a closure variable in `createEditor`:

```ts
let activeKitDirectory: string | undefined;
```

Expose `getCurrentDirectory()` on `Editor.kit`. Assign `activeKitDirectory = kitPath` only after external plugins load, `kit.register`, and `kit.switchKit` succeed. Because assignment occurs after the switch transaction, failed switches keep the previous directory.

Replace `resolveKitRoot(editor, kit.name)` in `window-entry.ts` with `editor.kit.getCurrentDirectory()`. Remove repository, parent, plugin, and `node_modules` scanning imports and helpers. Validate the relative entry before resolving, then preserve realpath containment and regular-file checks.

- [ ] **Step 5: Migrate Server unit fixtures and run GREEN**

Update `tests/helpers/assembly.ts` so `testAssembly` is created with an explicit Default builtin source, then update every
`createServer` call in the listed Server tests to pass either `assembly: testAssembly` or a purpose-built source array. Use
literal arrays such as:

```ts
kitSources: [{ directory: path.join(projectRoot, 'kits/default'), source: 'builtin' }],
```

For tests needing multiple repository Kits, list each as `development`; do not introduce a production scan helper.

Run:

```bash
npm run test -w packages/server
```

Expected: 41 Server test files pass, including the new installed window-entry regression.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/server/src/assembly/config.ts packages/server/src/assembly/kit-catalog.ts \
  packages/server/src/plugin/resolver.ts packages/server/src/server.ts packages/server/src/index.ts \
  packages/server/src/editor/types.ts packages/server/src/editor/index.ts \
  packages/server/src/routes/window-entry.ts packages/server/tests/assembly/config.test.ts \
  packages/server/tests/assembly/kit-catalog.test.ts packages/server/tests/plugin/resolver.test.ts \
  packages/server/tests/framework/editor.test.ts packages/server/tests/integration/integration.test.ts \
  packages/server/tests/helpers/assembly.ts packages/server/tests/integration.test.ts \
  packages/server/tests/application/client-asset.test.ts \
  packages/server/tests/application/server-lifecycle.test.ts \
  packages/server/tests/application/catalog.test.ts \
  packages/server/src/framework/__tests__/editor.test.ts
git commit -m '[Bug] 统一 Server Kit 来源与窗口入口'
```

---

### Task 2: Catalog Conflict Isolation

**Files:**
- Modify: `scripts/lib/kit-catalog.mjs`
- Test: `scripts/lib/kit-catalog.test.mjs`

**Interfaces:**
- Consumes: existing resolved catalog entries with `name`, `menuRoot.id`, `directory`, and `source`.
- Produces: `resolveConflicts(entries, selectKey, label, onDiagnostic)` behavior used first for package name and then for menu root.
- Produces diagnostics with `KIT_SOURCE_SHADOWED` for lower-priority candidates and `KIT_SOURCE_CONFLICT` for isolated ambiguous groups.

- [ ] **Step 1: Add failing conflict-isolation tests**

Add controlled temporary manifests for:

1. two installed candidates with one package name plus one healthy installed Kit;
2. two installed candidates with one `menuRoot.id` plus one healthy Kit;
3. builtin versus installed and development versus installed collisions;
4. the same real directory repeated twice.

Assert literal final package-name arrays and diagnostic codes. For same-priority ambiguity, assert both conflicting candidates are absent and the healthy Kit remains. For priority collisions, assert only the higher-priority candidate remains. The production change caught is throwing from `assertUnique` or `resolvePackageConflicts`, which currently aborts discovery.

- [ ] **Step 2: Run the Catalog test and verify RED**

Run:

```bash
node --test scripts/lib/kit-catalog.test.mjs
```

Expected: same-priority package collisions throw and menu-root collisions abort the whole Catalog.

- [ ] **Step 3: Implement grouped conflict resolution**

Replace `resolvePackageConflicts` plus `assertUnique` with one reusable resolver. Deduplicate by `realpath(directory)` where possible, falling back to `path.resolve(directory)` only for a path that disappeared after validation. Group by the selected key, compute the exact priority from `SOURCE_PRIORITY`, and apply:

```js
if (highestCandidates.length === 1) {
  const winner = highestCandidates[0];
  resolved.push(winner);
  for (const shadowed of group.filter((entry) => entry !== winner)) {
    onDiagnostic({
      code: 'KIT_SOURCE_SHADOWED',
      kit: selectKey(shadowed),
      source: shadowed.source,
      message: `${label} ${selectKey(shadowed)} from ${shadowed.source} was shadowed by ${winner.source}`,
    });
  }
} else {
  for (const conflict of group) {
    onDiagnostic({
      code: 'KIT_SOURCE_CONFLICT',
      kit: selectKey(conflict),
      source: conflict.source,
      message: `${label} ${selectKey(conflict)} has conflicting ${conflict.source} sources`,
    });
  }
}
```

Run it for `entry.name`, then for `entry.menuRoot.id`. Preserve strict behavior for an explicitly requested Kit: if its canonical name is absent after conflict resolution, throw an error naming its conflict rather than silently selecting Default.

- [ ] **Step 4: Run GREEN and the launcher regression set**

Run:

```bash
node --test scripts/lib/kit-catalog.test.mjs scripts/lib/electron-launcher.test.mjs
```

Expected: all tests pass with unrelated Kits retained during conflicts.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/lib/kit-catalog.mjs scripts/lib/kit-catalog.test.mjs
git commit -m '[Bug] 隔离冲突 Kit 并保留健康目录'
```

---

### Task 3: Hide Unavailable Workspaces from Tray

**Files:**
- Modify: `scripts/lib/electron-launcher.mjs`
- Test: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: `kits` from the current Catalog and `workspaceRecords` retained by WorkspaceStore.
- Produces: Tray Kit entries derived only from `kits`; workspace persistence remains unchanged.

- [ ] **Step 1: Change the Tray regression expectation and verify RED**

Rename the existing test to `builds tray entries only for the current Catalog while retaining workspace input`. Keep an unavailable record in the input, but expect only Default, SQLite, separators, Kit Manager, and Quit. Invoke the click handlers using their new literal indexes and assert the same visible actions.

Run:

```bash
node --test --test-name-pattern='tray entries only' scripts/lib/electron-launcher.test.mjs
```

Expected: FAIL because `@itharbors/kit-removed (Unavailable)` is still rendered.

- [ ] **Step 2: Remove unavailable menu rendering and verify GREEN**

Delete `availableNames` and `unavailableEntries` from `buildTrayTemplate`. Keep the `workspaceRecords` field accepted by the input so callers need no state migration, but build the returned Kit section exclusively from `kits`.

Run:

```bash
node --test scripts/lib/workspace-store.test.mjs scripts/lib/electron-launcher.test.mjs
```

Expected: both suites pass, proving records remain persisted while Tray hides them.

- [ ] **Step 3: Commit Task 3**

```bash
git add scripts/lib/electron-launcher.mjs scripts/lib/electron-launcher.test.mjs
git commit -m '[Bug] 隐藏托盘中的不可用 Kit'
```

---

### Task 4: Stable Start Build from Builtin Declarations

**Files:**
- Modify: `package.json`
- Modify: `scripts/ce-plugin.mjs`
- Modify: `scripts/lib/plugin-build/discover.mjs`
- Create: `scripts/lib/plugin-build/discover.test.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Consumes: `BUILTIN_KITS` from `scripts/lib/builtin-kits.mjs`.
- Produces: `discoverRuntimePlugins(repoRoot)` returning framework plugins plus plugins beneath declared builtin Kit directories only.
- Produces: `ce-plugin build --runtime` and root `build:runtime`; `prestart` becomes `npm run build:runtime`.

- [ ] **Step 1: Add failing behavioral discovery and prestart tests**

Create a temporary repository fixture in `discover.test.mjs` containing framework plugin `plugins/menu`, builtin `kits/default/plugins/log`, and non-builtin `kits/broken/plugins/failure`. Assert:

```js
assert.deepEqual(
  discoverRuntimePlugins(root).map((item) => path.relative(root, item)),
  ['kits/default/plugins/log', 'plugins/menu'],
);
```

Update the launcher script contract test to expect `prestart === 'npm run build:runtime'` and `build:runtime` to invoke `ce-plugin.mjs build --runtime`, while root `build` still invokes the all-plugin build.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test scripts/lib/plugin-build/discover.test.mjs scripts/lib/electron-launcher.test.mjs
```

Expected: `discoverRuntimePlugins` is missing and `prestart` still equals `npm run build`.

- [ ] **Step 3: Implement runtime plugin discovery and the stable build script**

Export `discoverRuntimePlugins(repoRoot)` from `discover.mjs`. Append framework plugins from `<root>/plugins`, then only `<root>/kits/<slug>/plugins` for slugs in `BUILTIN_KITS`; sort and return. Extend `ce-plugin.mjs` argument handling so `--runtime` selects this function and `--all` keeps its full repository behavior.

Add root scripts with the exact division:

```json
"prestart": "npm run build:runtime",
"plugins:build:runtime": "node scripts/ce-plugin.mjs build --runtime",
"build:runtime": "npm run build -w @itharbors/plugin-types && npm run build -w @itharbors/kit-core && npm run build -w @itharbors/kit-cli && npm run build -w packages/client && npm run build -w packages/server && npm run plugins:build:runtime"
```

Do not add CSV/SQLite/MySQL contracts or relationship-graph to `build:runtime` unless an actual current builtin import makes the build fail; if one is required, document the import in the task report and add only that package.

- [ ] **Step 4: Prove stable build excludes a broken non-builtin Kit**

In the discovery test fixture, make the non-builtin plugin manifest/source invalid enough that direct `discoverPlugin` or the all-plugin path rejects it. Assert runtime discovery omits it and all discovery includes it. Then run:

```bash
node --test scripts/lib/plugin-build/discover.test.mjs scripts/lib/plugin-build/scripts.test.mjs \
  scripts/lib/electron-launcher.test.mjs
npm run build:runtime
```

Expected: tests and the real stable runtime build pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add package.json scripts/ce-plugin.mjs scripts/lib/plugin-build/discover.mjs \
  scripts/lib/plugin-build/discover.test.mjs scripts/lib/electron-launcher.test.mjs
git commit -m '[Bug] 限制稳定启动只构建内置 Kit'
```

---

### Task 5: Derive Desktop Staging from `BUILTIN_KITS`

**Files:**
- Modify: `scripts/lib/desktop-build.mjs`
- Test: `scripts/lib/desktop-build.test.mjs`

**Interfaces:**
- Consumes: `BUILTIN_KITS` and each builtin Kit's actual `plugins/*/package.json` plus declared built output directories.
- Produces: a desktop copy plan that rejects every `kits/<slug>` not in the builtin slug set and discovers builtin plugin assets without `DEFAULT_KIT_PLUGINS`.

- [ ] **Step 1: Expand the desktop staging regressions and verify RED**

Add CSV to the existing forbidden directory loop:

```js
for (const forbidden of ['csv', 'mysql', 'notifications', 'sqlite']) {
```

Add a custom `stageDesktopFiles` rejection for `kits/csv/package.json`. Add an extra plugin directory under the Default fixture with a valid package, `main/dist`, and one contributed panel `entry`; assert the output contains it without adding that name to production code. The production changes caught are the incomplete `PRODUCT_KITS` set and the hardcoded `DEFAULT_KIT_PLUGINS` list.

- [ ] **Step 2: Run the desktop build test and verify RED**

Run:

```bash
node --test scripts/lib/desktop-build.test.mjs
```

Expected: CSV staging is not rejected and the additional builtin plugin is absent.

- [ ] **Step 3: Implement declaration-driven staging**

Replace `PRODUCT_KITS` with:

```js
const BUILTIN_KIT_SLUGS = new Set(BUILTIN_KITS.map(({ slug }) => slug));
```

Reject any source whose first two portable path segments are `kits/<slug>` when the slug is not in that set. Replace `DEFAULT_KIT_PLUGINS` with asynchronous enumeration beneath each builtin `plugins` directory. Read each plugin package's `main` and `ce-editor.contribute.panel[*].entry`, convert them to their containing built directories, and add package plus built directory entries deterministically. Reject malformed paths through the existing copy-plan validation rather than copying source trees.

- [ ] **Step 4: Run GREEN and desktop verification**

Run:

```bash
node --test scripts/lib/desktop-build.test.mjs
npm run test:desktop
```

Expected: every desktop test passes and the staged Kit top level remains exactly `default`.

- [ ] **Step 5: Commit Task 5**

```bash
git add scripts/lib/desktop-build.mjs scripts/lib/desktop-build.test.mjs
git commit -m '[Bug] 统一桌面内置 Kit 打包清单'
```

---

### Task 6: Acceptance and Documentation Migration

**Files:**
- Modify: `scripts/lib/kit-registry/acceptance.test.mjs`
- Modify: `scripts/lib/kit-manager-acceptance.test.mjs`
- Modify: `scripts/lib/dev-launcher.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `docs/guides/kit-artifacts.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`

**Interfaces:**
- Consumes: Task 1's explicit `createServer({ kitSources })` contract.
- Produces: end-to-end acceptance coverage that reaches Server Catalog and installed window entries through the authoritative snapshot.

- [ ] **Step 1: Migrate acceptance Server construction and add entry assertions**

Replace each acceptance use of:

```js
installedKitDirs: activeSources.map(({ directory }) => directory),
```

with a complete snapshot containing the explicit Default builtin source and mapped installed sources:

```js
kitSources: [
  { directory: defaultKitDirectory, source: 'builtin' },
  ...activeSources.map(({ directory }) => ({ directory, source: 'installed' })),
],
```

In the Kit Manager acceptance flow, after activation and session creation, request main and secondary window entries and assert 200 plus the fixture markers. This test must exercise the real Server, not a mocked route.

- [ ] **Step 2: Remove legacy launcher assumptions and run acceptance tests**

Delete stale `HARBORS_INSTALLED_KITS` setup/assertions from `electron-launcher.test.mjs`; continue asserting that `HARBORS_KIT_SOURCES` is an immutable serialized snapshot.
Delete the obsolete inherited-variable cleanup from `dev-launcher.mjs`; the launcher should set only the authoritative snapshot.

Run:

```bash
node --test scripts/lib/kit-registry/acceptance.test.mjs \
  scripts/lib/kit-manager-acceptance.test.mjs scripts/lib/electron-launcher.test.mjs
```

Expected: acceptance tests pass using only explicit source snapshots.

- [ ] **Step 3: Update active documentation**

In `kit-artifacts.md`, replace the old installed-only environment variable description with `HARBORS_KIT_SOURCES` and explain that only the active installed directory enters the snapshot. In `developing-plugins-and-kits.md`, call only Default builtin; describe CSV, SQLite, MySQL, and Notifications as official market Kits whose repository directories are loaded automatically only by `npm run dev`.

Do not add prose-source grep tests. Run the existing documentation suite as its current compatibility contract.

- [ ] **Step 4: Verify legacy mechanisms are absent**

Run:

```bash
rg -n 'HARBORS_INSTALLED_KITS|installedKitDirs' packages scripts docs/guides \
  -g '!**/dist/**' -g '!**/node_modules/**'
```

Expected: exit 1 with no matches. If a fixture intentionally tests rejection of an unknown legacy field, name it generically through an excess-property object instead of retaining the old symbol.

Then run:

```bash
node --test scripts/lib/kit-docs.test.mjs
npm run build
npm test
```

Expected: build and full repository test suite pass.

- [ ] **Step 5: Commit Task 6**

```bash
git add scripts/lib/kit-registry/acceptance.test.mjs scripts/lib/kit-manager-acceptance.test.mjs \
  scripts/lib/dev-launcher.mjs scripts/lib/electron-launcher.test.mjs docs/guides/kit-artifacts.md \
  docs/guides/developing-plugins-and-kits.md
git commit -m '[Bug] 迁移动态 Kit 验收与文档'
```

---

## Final Verification

- [ ] Run `git diff --check 282eec2...HEAD` and inspect `git status --short`.
- [ ] Run `npm run build:runtime` and confirm only runtime/builtin plugin targets are discovered.
- [ ] Run `npm run build`.
- [ ] Run `npm test` and record exact pass/fail totals.
- [ ] Re-run the installed main/secondary window-entry regression and conflict-isolation suites.
- [ ] Re-read `docs/superpowers/specs/2026-07-27-dynamic-kit-convergence-design.md` and map every goal to Tasks 1-6.
- [ ] Dispatch a whole-branch code review over merge-base `282eec2` through `HEAD`, fix load-bearing findings once, and perform one scoped re-review.
