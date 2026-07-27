# Kit Source Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run start` load only explicit built-in and active installed Kits while `npm run dev` additionally loads repository Kit sources through one deterministic resolver.

**Architecture:** Add an explicit built-in Kit declaration and make the Electron-side catalog resolver the desktop source authority. Serialize its resolved source snapshot to the Framework, teach Server assembly to consume that snapshot instead of rescanning repository directories, and reject marketplace installation of built-in IDs before network access.

**Tech Stack:** Node.js 22 ESM, Electron 43, TypeScript, Node test runner, Vitest, npm workspaces.

## Global Constraints

- Do not add another npm start subcommand.
- `npm run start` includes only builtin and active installed sources.
- `npm run dev` additionally includes repository development sources.
- Source priority is `explicit > development > builtin > installed`; `explicit` preserves the existing `--kit` compatibility path.
- Builtin and marketplace IDs are permanently mutually exclusive.
- Multiple installed versions may remain on disk, but only `installed.json.active` participates in startup.
- A conflicting installed Kit must not prevent unrelated Kits from starting.
- Do not expose source paths, digests, download URLs, or commits through the public Catalog API.
- Keep Node.js at `>=22.12.0` and add no dependencies.
- Every commit title uses `[Feature]` with a concise Chinese summary and no trailing period.

---

### Task 1: Explicit Built-in Declaration and Source Resolver

**Files:**
- Create: `scripts/lib/builtin-kits.mjs`
- Modify: `scripts/lib/desktop-build.mjs:12-90`
- Modify: `scripts/lib/kit-catalog.mjs:1-194`
- Modify: `scripts/lib/kit-catalog.test.mjs:1-301`
- Modify: `scripts/lib/desktop-build.test.mjs:17-110`

**Interfaces:**
- Produces: `BUILTIN_KITS: readonly { slug: string; id: string }[]`.
- Produces: `discoverKits({ rootDir, profile, requestedKit, installedKits, failOnInstalledError?, onDiagnostic? }): Promise<KitCatalogEntry[]>`.
- Produces: catalog entry `source` values `builtin | installed | development | explicit`.
- Produces: diagnostic callback values `{ code, kit?, source, message }` without public path serialization.

- [ ] **Step 1: Write failing source-policy tests**

Add tests that create `default`, `mysql`, and installed fixtures, then assert:

```js
const stable = await discoverKits({ rootDir, profile: 'stable', installedKits: [installed] });
assert.deepEqual(stable.map((kit) => [kit.name, kit.source]), [
  ['@itharbors/kit-default', 'builtin'],
  ['@example/kit-installed', 'installed'],
]);

const development = await discoverKits({ rootDir, profile: 'development' });
assert.deepEqual(development.map((kit) => kit.name), [
  '@itharbors/kit-default',
  '@itharbors/kit-mysql',
]);
assert.equal(development.find((kit) => kit.name.endsWith('mysql')).source, 'development');
```

Add a test where an installed source has `@itharbors/kit-mysql` and assert development wins without mutating the input. Add a corrupted active installed fixture and assert it is diagnosed and skipped unless `failOnInstalledError: true`.

- [ ] **Step 2: Run the catalog tests and verify failure**

Run: `node --test scripts/lib/kit-catalog.test.mjs scripts/lib/desktop-build.test.mjs`

Expected: FAIL because `profile`, explicit built-in declarations, and conflict diagnostics do not exist.

- [ ] **Step 3: Add the explicit built-in declaration**

Create `scripts/lib/builtin-kits.mjs`:

```js
export const BUILTIN_KITS = Object.freeze([
  Object.freeze({ slug: 'default', id: '@itharbors/kit-default' }),
]);

export const BUILTIN_KIT_IDS = Object.freeze(BUILTIN_KITS.map((kit) => kit.id));
```

Import `BUILTIN_KITS` in `desktop-build.mjs` and generate Default Kit runtime entries from the same declaration instead of maintaining an independent product/builtin assumption.

- [ ] **Step 4: Implement candidate collection and deterministic conflict resolution**

Refactor `discoverKits` around candidates:

```js
const SOURCE_PRIORITY = Object.freeze({ installed: 1, builtin: 2, development: 3, explicit: 4 });

export async function discoverKits({
  rootDir,
  profile = 'stable',
  requestedKit,
  installedKits = [],
  failOnInstalledError = false,
  onDiagnostic = () => {},
} = {}) {
  const candidates = await collectCandidates({ rootDir, profile, requestedKit, installedKits });
  const entries = await validateCandidates(candidates, { failOnInstalledError, onDiagnostic });
  return resolveConflicts(entries, onDiagnostic).sort(compareKits);
}
```

Collection rules:

```js
// Always explicit builtin directories.
BUILTIN_KITS.map(({ slug }) => ({ directory: path.join(rootDir, 'kits', slug), source: 'builtin' }));
// Only development profile enumerates other rootDir/kits children.
// Installed sources carry their InstalledKitStore identity metadata.
// An external requested path remains explicit for compatibility.
```

For cross-source duplicate package IDs, keep only the highest-priority entry and call `onDiagnostic`. For duplicate package IDs at the same priority, reject every member of that conflict group. After package resolution, reject every member of a duplicate `menuRoot.id` group. Invalid builtin manifests throw; invalid development manifests are diagnosed and skipped; invalid installed manifests are skipped unless strict pending validation requests `failOnInstalledError`.

- [ ] **Step 5: Make desktop packaging consume the declaration**

Update the packaging test so it checks every `BUILTIN_KITS` slug is staged and every non-builtin fixture is excluded. Keep the existing inventory and source-exclusion assertions.

- [ ] **Step 6: Run focused tests**

Run: `node --test scripts/lib/kit-catalog.test.mjs scripts/lib/desktop-build.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/builtin-kits.mjs scripts/lib/kit-catalog.mjs scripts/lib/kit-catalog.test.mjs scripts/lib/desktop-build.mjs scripts/lib/desktop-build.test.mjs
git commit -m "[Feature] 统一 Kit 来源解析"
```

---

### Task 2: Reject Marketplace Installation of Built-in IDs

**Files:**
- Modify: `scripts/lib/kit-registry/manager.mjs:1-234`
- Modify: `scripts/lib/kit-registry/manager.test.mjs:62-303`
- Modify: `scripts/lib/kit-manager-service.mjs:140-190`
- Modify: `scripts/lib/kit-manager-service.test.mjs:1-180`
- Modify: `scripts/lib/kit-manager-view.mjs:20-220`
- Modify: `scripts/lib/kit-manager-view.test.mjs:80-230`

**Interfaces:**
- Consumes: `BUILTIN_KIT_IDS` from Task 1.
- Produces: `KitRegistryManager` constructor option `builtinKitIds?: string[]`.
- Produces: install rejection error `{ code: 'BUILTIN_KIT_ID', message: 'Kit <id> is built into Harbors' }`.
- Produces: Kit Manager projection field `builtin: true` and a disabled `Built in` action.

- [ ] **Step 1: Write a failing preflight test**

Construct a manager with fakes that count resolver and downloader calls:

```js
const manager = new KitRegistryManager({
  ...dependencies,
  builtinKitIds: ['@itharbors/kit-default'],
});
await assert.rejects(
  manager.install({ id: '@itharbors/kit-default', version: '1.0.0', channel: 'stable' }),
  (error) => error.code === 'BUILTIN_KIT_ID',
);
assert.equal(resolveCalls, 0);
assert.equal(downloadCalls, 0);
```

Assert the audit entry is `kit.install/failure/BUILTIN_KIT_ID` and the Store snapshot remains unchanged.
Also assert `list()` marks the matching market entry `{ builtin: true }` and the Kit Manager view renders a disabled
`Built in` button without invoking `install`.

- [ ] **Step 2: Run the manager tests and verify failure**

Run: `node --test scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-service.test.mjs scripts/lib/kit-manager-view.test.mjs`

Expected: FAIL because builtin IDs are not accepted or checked.

- [ ] **Step 3: Implement the install guard**

Store a validated immutable Set in the manager constructor and reject inside the per-Kit queue before resolver access:

```js
if (this.#builtinKitIds.has(input.id)) {
  throw Object.assign(new Error(`Kit ${input.id} is built into Harbors`), {
    code: 'BUILTIN_KIT_ID',
  });
}
```

Pass `BUILTIN_KIT_IDS` from `createKitManagerService` so the production manager always has the guard.
Thread the same Set through the sanitized manager projection:

```js
if (this.#builtinKitIds.has(kit.id)) kit.builtin = true;
```

When `kit.builtin === true`, render a disabled action instead of the Stable/Preview install actions. Keep installed
state visible if legacy data already contains the ID so the conflict can be diagnosed without executing it.

- [ ] **Step 4: Run focused tests**

Run: `node --test scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-service.test.mjs scripts/lib/kit-manager-view.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/kit-registry/manager.mjs scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-service.mjs scripts/lib/kit-manager-service.test.mjs scripts/lib/kit-manager-view.mjs scripts/lib/kit-manager-view.test.mjs
git commit -m "[Feature] 阻止安装内置 Kit"
```

---

### Task 3: Pass One Resolved Desktop Source Snapshot

**Files:**
- Modify: `scripts/electron.mjs:320-380,462-510`
- Modify: `scripts/dev.mjs:1-35`
- Modify: `scripts/lib/dev-launcher.mjs:1-33`
- Modify: `scripts/lib/electron-launcher.test.mjs:101-145,808-820`
- Modify: `scripts/lib/desktop-framework.mjs:13-51,132-145`
- Modify: `scripts/lib/desktop-framework.test.mjs:10-77,125-180`

**Interfaces:**
- Consumes: Task 1 `discoverKits` profile behavior.
- Produces: `HARBORS_KIT_SOURCES`, a JSON array of `{ directory: absolutePath, source: 'builtin' | 'installed' | 'development' | 'explicit' }`.
- Produces: `parseKitSources(value)` in `desktop-framework.mjs`.

- [ ] **Step 1: Write failing launcher and environment tests**

Assert stable and development environments preserve a supplied source snapshot and clear the legacy installed-only variable:

```js
const sources = [{ directory: '/repo/kits/default', source: 'builtin' }];
const env = createDevServerEnv({}, '', sources);
assert.equal(env.HARBORS_KIT_SOURCES, JSON.stringify(sources));
assert.equal('HARBORS_INSTALLED_KITS' in env, false);
```

Update packaged environment fixtures to use `HARBORS_KIT_SOURCES`. Reject relative paths, unknown source kinds, extra object fields, duplicate directories, and malformed JSON.

- [ ] **Step 2: Run launcher tests and verify failure**

Run: `node --test scripts/lib/electron-launcher.test.mjs scripts/lib/desktop-framework.test.mjs`

Expected: FAIL because only `HARBORS_INSTALLED_KITS` exists.

- [ ] **Step 3: Serialize Electron's resolved catalog**

Call Task 1 resolver with:

```js
profile: runtimeProfile === 'development' ? 'development' : 'stable'
```

After resolving, derive one frozen snapshot:

```js
kitSources = kitCatalog.map(({ directory, source }) => ({ directory, source }));
```

Pass `HARBORS_KIT_SOURCES: JSON.stringify(kitSources)` to both packaged and source Framework processes. Pending activation validation calls `discoverKits` with the same profile and `failOnInstalledError: true`; final startup calls it in tolerant mode and logs diagnostics.

- [ ] **Step 4: Make standalone dev:web resolve development sources**

Before spawning the stack, resolve a development Catalog and pass its source snapshot into `createDevStackEnvironments`. Preserve an external `--kit` entry as `explicit`.

- [ ] **Step 5: Parse the snapshot for packaged Framework startup**

Replace the installed-only parser with:

```js
function parseKitSources(value) {
  const parsed = JSON.parse(value);
  // Require a JSON array, exact keys directory/source, absolute unique paths,
  // and source in builtin|installed|development|explicit.
  return Object.freeze(parsed.map((item) => Object.freeze({ ...item })));
}
```

Pass `{ kitSources: environment.kitSources }` into `createAssembly`.

- [ ] **Step 6: Run focused tests**

Run: `node --test scripts/lib/electron-launcher.test.mjs scripts/lib/desktop-framework.test.mjs scripts/lib/kit-catalog.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/electron.mjs scripts/dev.mjs scripts/lib/dev-launcher.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/desktop-framework.mjs scripts/lib/desktop-framework.test.mjs
git commit -m "[Feature] 按启动模式传递 Kit 来源"
```

---

### Task 4: Make Server Consume the Resolved Snapshot

**Files:**
- Modify: `packages/server/src/assembly/config.ts:1-40`
- Modify: `packages/server/src/assembly/kit-catalog.ts:1-116`
- Modify: `packages/server/src/application/catalog.ts:91-126`
- Modify: `packages/server/src/plugin/resolver.ts:11-87`
- Modify: `packages/server/src/server.ts:15-72`
- Modify: `packages/server/src/index.ts:1-19`
- Modify: `packages/server/tests/assembly/kit-catalog.test.ts:1-230`
- Modify: `packages/server/tests/application/catalog.test.ts`
- Modify: `packages/server/tests/plugin/resolver.test.ts:134-143`
- Modify: `packages/server/tests/assembly/config.test.ts`

**Interfaces:**
- Consumes: Task 3 serialized `HARBORS_KIT_SOURCES`.
- Produces: `AssemblyKitSource { directory: string; source: KitSourceKind }`.
- Produces: `AssemblyConfig.kitSources: AssemblyKitSource[] | null`; `null` retains explicit library/test fallback scanning, a supplied array is authoritative.
- Produces: `parseKitSources(value: string | undefined): AssemblyKitSource[] | undefined` in `server.ts`.

- [ ] **Step 1: Write failing authoritative-source tests**

Create Default and MySQL under a repository `kits/` directory, then supply only Default plus one installed fixture:

```ts
const catalog = await discoverKitCatalog({
  ...assembly(),
  kitSources: [
    { directory: defaultDirectory, source: 'builtin' },
    { directory: installedDirectory, source: 'installed' },
  ],
});
expect(catalog.map((entry) => entry.name)).toEqual([
  '@itharbors/kit-default',
  '@example/kit-installed',
]);
```

Assert MySQL is neither in the public Catalog nor application startup discovery, and `resolveKit('@itharbors/kit-mysql', ctx)` rejects when it is outside authoritative `kitSources`.

- [ ] **Step 2: Run Server tests and verify failure**

Run: `npm test -w packages/server -- --run tests/assembly/config.test.ts tests/assembly/kit-catalog.test.ts tests/application/catalog.test.ts tests/plugin/resolver.test.ts`

Expected: FAIL because assembly does not have authoritative sources.

- [ ] **Step 3: Extend and normalize assembly configuration**

Add exact source types and copy/freeze semantics:

```ts
export type KitSourceKind = 'builtin' | 'installed' | 'development' | 'explicit';
export interface AssemblyKitSource { directory: string; source: KitSourceKind }
export interface AssemblyConfig { /* existing fields */ kitSources: AssemblyKitSource[] | null }
```

Default to `null`. When overridden, resolve every directory to an absolute path and copy the records so callers cannot mutate assembly state.

- [ ] **Step 4: Route all Server Kit enumeration through one helper**

Add `listAssemblyKitSources(assembly)` in `assembly/kit-catalog.ts`. If `kitSources !== null`, return it exactly after path deduplication. Otherwise retain current directory scanning for direct library/test callers. Use this helper in public Catalog and application plugin discovery.

Update `resolveKit` to check authoritative sources by path/name and avoid `builtinKitsDir`/`kitsDir` scanning when `kitSources` is supplied.

- [ ] **Step 5: Parse the source snapshot at the Server entry**

Implement strict parsing equivalent to Task 3 and call:

```ts
createServer({
  ...existing,
  kitSources: parseKitSources(process.env.HARBORS_KIT_SOURCES),
});
```

Thread `kitSources` through `ServerOptions` into `createDefaultAssemblyConfig`.

- [ ] **Step 6: Run focused Server tests**

Run: `npm test -w packages/server -- --run tests/assembly/config.test.ts tests/assembly/kit-catalog.test.ts tests/application/catalog.test.ts tests/plugin/resolver.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/assembly/config.ts packages/server/src/assembly/kit-catalog.ts packages/server/src/application/catalog.ts packages/server/src/plugin/resolver.ts packages/server/src/server.ts packages/server/src/index.ts packages/server/tests/assembly/config.test.ts packages/server/tests/assembly/kit-catalog.test.ts packages/server/tests/application/catalog.test.ts packages/server/tests/plugin/resolver.test.ts
git commit -m "[Feature] 统一 Server Kit 来源快照"
```

---

### Task 5: Documentation and End-to-End Regression

**Files:**
- Modify: `README.md:38-55,140-155`
- Modify: `docs/guides/development-workflow.md:25-108`
- Modify: `docs/architecture/kit-and-session-model.md:100-126`
- Modify: `scripts/lib/kit-docs.test.mjs`
- Modify: `scripts/lib/kit-manager-acceptance.test.mjs:126-310`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: documented stable/development source semantics and regression coverage.

- [ ] **Step 1: Write failing documentation-contract assertions**

Require the guides to state all of:

```js
for (const phrase of [
  'npm run start',
  '只加载内置 Kit 和已激活的商城 Kit',
  'npm run dev',
  '额外加载仓库 kits/*',
  '<userData>/kit-store/kits/<encoded-kit-id>/<version>',
]) assert.match(documentation, new RegExp(escape(phrase), 'u'));
```

Add an acceptance assertion that a fixture installed and activated through Kit Manager appears in the resolved source snapshot after restart, while a non-builtin repository fixture does not appear in stable mode.

- [ ] **Step 2: Run documentation and acceptance tests and verify failure**

Run: `node --test scripts/lib/kit-docs.test.mjs scripts/lib/kit-manager-acceptance.test.mjs`

Expected: FAIL because the current guide says `start` scans all `kits/*`.

- [ ] **Step 3: Update user and architecture documentation**

Document:

```text
npm run start = builtin + active installed
npm run dev   = builtin + active installed + repository development
```

Explain that install writes immutable version directories, activation selects one version, builtin IDs cannot be installed from the market, and development shadowing never mutates `installed.json`.

- [ ] **Step 4: Run the focused cross-layer suite**

Run:

```bash
node --test scripts/lib/kit-catalog.test.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/desktop-framework.test.mjs scripts/lib/desktop-build.test.mjs scripts/lib/kit-registry/manager.test.mjs scripts/lib/kit-manager-service.test.mjs scripts/lib/kit-manager-view.test.mjs scripts/lib/kit-docs.test.mjs scripts/lib/kit-manager-acceptance.test.mjs
npm test -w packages/server -- --run tests/assembly/config.test.ts tests/assembly/kit-catalog.test.ts tests/application/catalog.test.ts tests/plugin/resolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run repository verification**

Run: `npm run check`

Expected: PASS with no typecheck, build, test, Kit, desktop, or workflow failures.

- [ ] **Step 6: Inspect the final change**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: only the design, plan, implementation, tests, and relevant docs are changed; no generated temporary Store or package artifacts are present.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/guides/development-workflow.md docs/architecture/kit-and-session-model.md scripts/lib/kit-docs.test.mjs scripts/lib/kit-manager-acceptance.test.mjs docs/superpowers/plans/2026-07-26-kit-source-resolution.md
git commit -m "[Feature] 完善 Kit 来源行为文档"
```
