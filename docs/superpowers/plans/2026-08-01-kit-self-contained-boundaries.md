# Kit Self-Contained Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Harbors Kit a self-contained functional source unit whose ordinary feature changes modify only `kits/<kit>/**`.

**Architecture:** Replace repeated Kit registries with one filesystem-derived repository descriptor, move product-owned code and dependencies into nested Kit workspaces, and expose desktop needs through generic plugin capabilities. Enforce the boundary with Git diff checks and isolated build/test/pack verification.

**Tech Stack:** Node.js 22.18.0, npm 10.9.3, TypeScript 5.7, ES modules, Vitest, Node test runner, Bash, Electron 43, `@itharbors/kit-core`, and `@itharbors/kit-cli`.

## Global Constraints

- Ordinary Kit changes, including protocol, dependency, lockfile, resource, test, build, CI metadata, smoke script, and product documentation changes, modify only `kits/<slug>/**`.
- Framework API changes and one-time market trust changes are the only Kit-external exceptions and must be separate reviewable commits.
- All current Kits, including builtin `default`, use the same repository descriptor contract.
- Keep `kit.json` schema version 1 and the existing `.hkit`, checksum, SBOM, signature, install, activation, rollback, and revocation trust model.
- Repository-only metadata lives in `package.json.harbors`; it does not enter the runtime Kit manifest.
- Root tools discover Kits from `kits/*`; no production code or general test stores an official Kit slug list.
- A Kit may depend only on its own nested workspaces, third-party packages, and stable Framework APIs/toolchain; no Kit-to-Kit source dependency is allowed.
- The Framework runner is injected as a versioned build tool and is not recorded as a Kit product dependency.
- Preserve Web-first acceptance for shared behavior and add Electron acceptance for storage, notifications, Tray, BrowserWindow, native IPC, and packaging changes.
- Do not keep long-lived dual mechanisms after the final migration; do not delete user data during storage migration.
- Use TDD, inspect every diff, stage explicit paths only, and use `[Refactor]` plus a concise Chinese summary for implementation commits on this branch.

## File and ownership map

| Unit | Primary files | Responsibility |
| --- | --- | --- |
| Repository Kit descriptor | `scripts/lib/repository-kits.mjs` | Discover and normalize directory-local Kit development metadata |
| Market policy adapter | `scripts/lib/kit-monorepo.mjs`, `registry/policy.json` | Intersect discovered Kits with centrally trusted identities |
| Boundary enforcement | `scripts/lib/kit-boundary.mjs`, Kit workflow scripts | Reject cross-Kit and Kit-external feature diffs |
| Generic Kit toolchain | `packages/kit-cli/src/build.ts`, `packages/kit-cli/src/cli.ts` | Build/test declared Kit-local workspaces, plugins, hooks, resources |
| Generic orchestration | `scripts/lib/build-tasks.mjs`, `scripts/lib/kit-ci-selection.mjs` | Derive build/test/CI work from descriptors |
| Plugin-owned paths | `packages/server/src/framework/plugin/paths.ts` | Produce secure data/cache/temp directories by plugin owner |
| Kit-owned protocols | `kits/*/packages/contracts/**` | Keep main/panel messages inside their product boundary |
| Kit-owned UI libraries | `kits/{sqlite,mysql}/packages/relationship-graph/**` | Remove mutable source sharing between products |
| Kit dependency roots | `kits/*/package-lock.json` | Lock each Kit independently from the Framework root |

---

### Task 1: Add the repository Kit descriptor

**Files:**
- Create: `scripts/lib/repository-kits.mjs`
- Create: `scripts/lib/repository-kits.test.mjs`
- Create: `packages/kit-core/src/repository.ts`
- Create: `packages/kit-core/tests/repository.test.ts`
- Modify: `packages/kit-core/src/index.ts`
- Create: `kits/default/kit.json`
- Modify: `kits/default/package.json`
- Modify: `kits/{agent-guard,csv,mysql,notifications,scheduler,skill-manager,sqlite,traceweave}/package.json`
- Modify: root `package-lock.json`

**Interfaces:**
- Produces: `SUPPORTED_KIT_RUNNERS = ['macos-14', 'ubuntu-latest']`.
- Produces: `parseRepositoryKitPackage(value): RepositoryKitPackageMetadata` from `@itharbors/kit-core` as the only parser for `package.json.harbors`.
- Produces: `discoverRepositoryKits({ repositoryRoot }): Promise<ReadonlyArray<RepositoryKitDescriptor>>`.
- Produces: `loadRepositoryKit({ repositoryRoot, slug }): Promise<RepositoryKitDescriptor>`.
- `RepositoryKitDescriptor` has exact fields `slug`, `directory`, `id`, `version`, `label`, `distribution`, `target`, `permissions`, `ciRunner`, `summary`, `scripts`, `resources`, `legacyDataDirectories`, `manifest`, and `packageJson`.

- [ ] **Step 1: Write failing descriptor tests**

Add pure parser tests for exact keys, runner, scripts, resources, storage legacy names, and frozen output. Add temporary-repository tests that create `kits/zeta/{kit.json,package.json}` and assert discovery without a static list:

```js
const [kit] = await discoverRepositoryKits({ repositoryRoot });
assert.deepEqual({
  slug: kit.slug,
  id: kit.id,
  label: kit.label,
  distribution: kit.distribution,
  ciRunner: kit.ciRunner,
  summary: kit.summary,
}, {
  slug: 'zeta',
  id: '@example/kit-zeta',
  label: 'Zeta',
  distribution: 'market',
  ciRunner: 'ubuntu-latest',
  summary: 'Zeta fixture',
});
await assert.rejects(
  loadRepositoryKit({ repositoryRoot, slug: '../zeta' }),
  /canonical Kit slug/u,
);
```

Also cover mismatched `kit.json.id`, missing scripts, unsupported runner, duplicate real directory through a symlink, resource escape, and sorted output.

- [ ] **Step 2: Run the focused test and confirm the module is missing**

Run: `node --test scripts/lib/repository-kits.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `repository-kits.mjs`.

- [ ] **Step 3: Implement strict repository metadata parsing**

Implement the Kit Core parser and make the filesystem descriptor consume it. Use this package metadata contract:

```json
{
  "harbors": {
    "distribution": "market",
    "ci": { "runner": "ubuntu-latest" },
    "docs": { "summary": "Product summary" },
    "resources": [],
    "storage": { "legacyDataDirectories": [] },
    "scripts": {
      "build": "build",
      "test": "test:kit",
      "smoke": "smoke"
    }
  }
}
```

Kit Core performs shape and canonical-string validation without filesystem access. `resources` is an optional array of normalized Kit-relative regular files or directories. `storage.legacyDataDirectories` is an optional, unique array of canonical single directory names; it is repository/runtime migration metadata and cannot contain separators, dot segments, or absolute paths. `smoke` is optional; every other script key is required. The repository loader then rejects unknown `harbors` fields, paths outside the real Kit root, symlinks, missing `kit.json`, identity/version drift, and duplicate IDs. Read directories in lexical slug order and freeze returned records.

- [ ] **Step 4: Add directory-local metadata to every current Kit**

Use `distribution: "builtin"` and `ci.runner: "ubuntu-latest"` for Default. Preserve the current policy runner and summary for every market Kit. Add Default `kit.json` with id `@itharbors/kit-default`, version `0.0.1`, stable channel, publisher `itharbors`, current Kit API requirements, any/any target, empty permissions, and `entry: "package.json"`; add matching package version.

Refresh the root lockfile with `npm install --package-lock-only --ignore-scripts` so Default's newly explicit version and every workspace snapshot remain in sync. This is transitional Framework metadata; Task 11 removes Kit package records from the root lock.

- [ ] **Step 5: Run descriptor and manifest tests**

Run: `npm run test -w @itharbors/kit-core -- tests/repository.test.ts && node --test scripts/lib/repository-kits.test.mjs`

Expected: PASS. Do not weaken descriptor validation to preserve a static list; Task 2 updates the separate market-policy tests.

- [ ] **Step 6: Commit the descriptor contract**

```bash
git add packages/kit-core/src/repository.ts packages/kit-core/src/index.ts packages/kit-core/tests/repository.test.ts scripts/lib/repository-kits.mjs scripts/lib/repository-kits.test.mjs kits/*/package.json kits/default/kit.json package-lock.json
git commit -m "[Refactor] 建立自描述 Kit 目录契约"
```

---

### Task 2: Separate market trust from product metadata

**Files:**
- Modify: `registry/policy.json`
- Modify: `scripts/lib/kit-monorepo.mjs`
- Modify: `scripts/lib/kit-monorepo.test.mjs`
- Modify: `scripts/check-kit.mjs`
- Modify: `scripts/lib/kit-check.mjs`
- Modify: `scripts/lib/kit-check.test.mjs`
- Modify: `scripts/lib/kit-publish/release-source.mjs`
- Modify: `scripts/lib/kit-publish/release-source.test.mjs`
- Modify: `scripts/lib/kit-publish/metadata.mjs`
- Modify: `scripts/lib/kit-publish/metadata.test.mjs`
- Modify: `.github/workflows/publish-kit.yml`
- Modify: `.github/workflows/publish-kit-reusable.yml`

**Interfaces:**
- Consumes: `loadRepositoryKit` and `discoverRepositoryKits` from Task 1.
- Produces: `loadTrustedMarketKit({ repositoryRoot, slug })`, returning the descriptor plus trusted policy fields.
- Preserves: release/registry artifacts and schema parsers; label and summary are sourced from the Kit descriptor rather than policy.

- [ ] **Step 1: Replace static-list tests with discovery and trust-intersection tests**

Assert that a valid temporary Kit is discoverable but not trusted, and that policy metadata contains no product display or CI fields:

```js
assert.deepEqual(Object.keys(policy.kits.mysql).sort(), ['id']);
await assert.rejects(
  loadTrustedMarketKit({ repositoryRoot, slug: 'unapproved' }),
  /not trusted for market publication/u,
);
assert.equal((await loadTrustedMarketKit({ repositoryRoot, slug: 'mysql' })).summary,
  'MySQL 数据库连接、浏览、编辑、关系图与 SQL 工作台');
```

Add a release-tag regression proving `kit/traceweave/v0.1.0-preview.1` parses through a generic slug regex and is then policy-validated.

- [ ] **Step 2: Run focused tests and verify static assumptions fail**

Run: `node --test scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/kit-publish/release-source.test.mjs scripts/lib/kit-publish/metadata.test.mjs`

Expected: FAIL on `OFFICIAL_KIT_SLUGS`, policy field shape, or the TraceWeave tag exclusion.

- [ ] **Step 3: Make policy identity-only and derive all product metadata**

Change each `registry/policy.json.kits.<slug>` entry to:

```json
{ "id": "@itharbors/kit-<slug>" }
```

Keep repository, workflow, signer workflow, schema, and revocation policy unchanged. Replace `OFFICIAL_KIT_SLUGS` with the sorted policy key set returned at runtime. `loadTrustedMarketKit` must reject builtin descriptors, unknown policy IDs, and directory/policy identity drift.

- [ ] **Step 4: Generalize CLI and release tag parsing**

Use `^kit/([a-z0-9][a-z0-9-]*)/v(.+)$` for syntax only. Replace hard-coded usage with `Usage: node scripts/check-kit.mjs <kit-slug> --output-directory <absolute-directory>`. Validate the slug through the trusted loader before building.

- [ ] **Step 5: Feed release display metadata from the descriptor**

Keep existing `release.json` and `registry-entry.json` schemas. The publish preparation step passes `descriptor.label` from runtime `menuRoot.label`, `descriptor.summary`, and `descriptor.ciRunner`; the release-source verifier validates identity/trust and internally validates non-empty label/summary instead of comparing them to central policy copies.

- [ ] **Step 6: Run focused publication tests**

Run: `node --test scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/kit-publish/metadata.test.mjs scripts/lib/kit-publish/release-source.test.mjs scripts/lib/kit-publish/workflows.test.mjs`

Expected: PASS, including TraceWeave tag and untrusted-directory rejection.

- [ ] **Step 7: Commit governance separation**

```bash
git add registry/policy.json scripts/check-kit.mjs scripts/lib/kit-monorepo.mjs scripts/lib/kit-monorepo.test.mjs scripts/lib/kit-check.mjs scripts/lib/kit-check.test.mjs scripts/lib/kit-publish .github/workflows/publish-kit.yml .github/workflows/publish-kit-reusable.yml
git commit -m "[Refactor] 分离 Kit 信任与产品元数据"
```

---

### Task 3: Enforce Git change boundaries

**Files:**
- Create: `scripts/lib/kit-boundary.mjs`
- Create: `scripts/lib/kit-boundary.test.mjs`
- Create: `scripts/check-kit-boundary.mjs`
- Modify: `package.json`
- Modify: `.agents/skills/kit-workflow/scripts/finish-kit-change.sh`
- Modify: `scripts/lib/kit-workflow/finish.test.sh`
- Modify: `scripts/lib/kit-workflow/contract.test.sh`

**Interfaces:**
- Produces: `validateKitChangePaths({ slug, records }): { paths: string[] }`.
- Produces: `readChangedPathRecords({ repositoryRoot, base, head }): Promise<GitPathRecord[]>` using `git diff --name-status -z --find-renames`.
- Produces CLI: `npm run kit:boundary -- <slug> --base <commit> --head <commit>`.

- [ ] **Step 1: Write failing path and workflow tests**

Cover add/modify/delete, rename source and target, other Kit, root lockfile, spaces, newline/control characters, symlink, submodule, invalid slug, and a clean in-boundary diff:

```js
assert.deepEqual(validateKitChangePaths({
  slug: 'sqlite',
  records: [{ status: 'M', paths: ['kits/sqlite/package.json'] }],
}), { paths: ['kits/sqlite/package.json'] });
assert.throws(() => validateKitChangePaths({
  slug: 'sqlite',
  records: [{ status: 'R100', paths: ['kits/sqlite/a.ts', 'scripts/a.ts'] }],
}), /outside kits\/sqlite/u);
```

The shell test must prove `finish-kit-change.sh` rejects an out-of-boundary commit before pack, `gh`, push, or PR creation.

- [ ] **Step 2: Run tests and verify the checker is absent**

Run: `node --test scripts/lib/kit-boundary.test.mjs && bash scripts/lib/kit-workflow/finish.test.sh`

Expected: Node test FAIL with missing module.

- [ ] **Step 3: Implement NUL-safe Git parsing and validation**

Accept only canonical paths whose first two segments equal `kits` and the exact slug. Reject symlink/submodule modes by reading `git ls-files -s -z` for changed paths. Do not normalize unsafe input into acceptance. Emit `BOUNDARY_KIT=<slug>` and `BOUNDARY_FILES=<count>` on success; emit a single sanitized `ERROR=` line on failure.

- [ ] **Step 4: Wire the checker before product checks in finish**

After validating commits and before creating `pack_dir`, run:

```bash
npm --prefix "$repo_root" run kit:boundary -- "$kit" --base "$target_ref" --head HEAD
```

No network command may execute before this returns zero.

- [ ] **Step 5: Run boundary and workflow suites**

Run: `node --test scripts/lib/kit-boundary.test.mjs && npm run test:kit-workflow`

Expected: PASS.

- [ ] **Step 6: Commit the boundary gate**

```bash
git add scripts/lib/kit-boundary.mjs scripts/lib/kit-boundary.test.mjs scripts/check-kit-boundary.mjs package.json .agents/skills/kit-workflow/scripts/finish-kit-change.sh scripts/lib/kit-workflow
git commit -m "[Refactor] 强制 Kit 变更目录边界"
```

---

### Task 4: Move generic Kit build lifecycle into the CLI

**Files:**
- Create: `packages/kit-cli/src/build.ts`
- Create: `packages/kit-cli/tests/build.test.ts`
- Move/Refactor: `scripts/lib/plugin-build/{assets,discover,fs,scripts,styles,validate}.mjs` into `packages/kit-cli/src/plugin-build/**`
- Modify: `packages/kit-cli/src/cli.ts`
- Modify: `packages/kit-cli/src/index.ts`
- Modify: `packages/kit-cli/package.json`
- Modify: `scripts/ce-plugin.mjs`
- Modify: `scripts/lib/plugin-build/*.test.mjs`

**Interfaces:**
- Consumes: `parseRepositoryKitPackage` from `@itharbors/kit-core`; it does not define a second `harbors` metadata parser.
- Produces: `buildKit({ directory, commandRunner? }): Promise<BuildKitResult>`.
- Produces: `testKit({ directory, commandRunner? }): Promise<TestKitResult>`.
- Adds CLI commands `harbors-kit build <kit-directory>` and `harbors-kit test <kit-directory>`.
- Build lifecycle runs `build:prepare` when present, Kit-local workspace builds, then all declared plugins in manifest order.
- Test lifecycle runs the exact descriptor-declared package script, conventionally `test:kit`.

- [ ] **Step 1: Write failing lifecycle tests**

Create a temporary nested workspace Kit and a fake command runner. Assert the exact sequence:

```ts
expect(commands).toEqual([
  ['npm', ['run', 'build:prepare', '--if-present'], kitRoot],
  ['npm', ['run', 'build', '--workspaces', '--if-present'], kitRoot],
  ['plugin-build', [pluginA], kitRoot],
  ['plugin-build', [pluginB], kitRoot],
]);
```

Cover undeclared plugin directories, missing declared plugins, duplicate package names, plugin paths outside the Kit, failed hooks, and `test:kit` absence.

- [ ] **Step 2: Run CLI tests and confirm missing commands**

Run: `npm run test -w @itharbors/kit-cli -- tests/build.test.ts tests/cli.test.ts`

Expected: FAIL because `buildKit` and CLI commands do not exist.

- [ ] **Step 3: Extract plugin builder as a package-local library**

Port existing validation without loosening path, asset, panel, or symlink checks. Keep `scripts/ce-plugin.mjs` as a thin compatibility wrapper importing the built `@itharbors/kit-cli` API. Add required esbuild and CSS dependencies to Kit CLI, not to individual Kits.

- [ ] **Step 4: Implement deterministic lifecycle commands**

The CLI resolves the real Kit root, validates descriptor/runtime manifests, runs only known lifecycle stages, sanitizes errors, and never accepts a caller-provided executable or environment override. `build:prepare` and `test:kit` are package scripts owned by the Kit; the runner supplies the CLI binary and exact version.

- [ ] **Step 5: Run Kit CLI and compatibility-wrapper tests**

Run: `npm run build -w @itharbors/kit-cli && npm run test -w @itharbors/kit-cli && node --test scripts/lib/plugin-build/*.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the generic toolchain**

```bash
git add packages/kit-cli scripts/ce-plugin.mjs scripts/lib/plugin-build
git commit -m "[Refactor] 收口通用 Kit 构建生命周期"
```

---

### Task 5: Make root build, test, and CI descriptor-driven

**Files:**
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Modify: `scripts/lib/kit-ci-selection.mjs`
- Modify: `scripts/lib/kit-ci-selection.test.mjs`
- Create: `scripts/run-kit-matrix.mjs`
- Create: `scripts/lib/kit-matrix.test.mjs`
- Modify: `scripts/select-kit-ci.mjs`
- Modify: `.github/workflows/kit-ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: repository descriptors from Task 1 and Kit CLI lifecycle from Task 4.
- Produces: `selectKitSlugs(paths, descriptors)` with no static Kit or targeted-contract maps.
- Produces CLI matrix runner `node scripts/run-kit-matrix.mjs <build|test|check> [slug...]`.

- [ ] **Step 1: Write failing dynamic-selection tests**

Use descriptors `alpha` and `zeta` created in test setup, never source constants:

```js
assert.deepEqual(selectKitSlugs(['kits/zeta/packages/contracts/src/index.ts'], descriptors), ['zeta']);
assert.deepEqual(selectKitSlugs(['packages/kit-core/src/model.ts'], descriptors), ['alpha', 'zeta']);
assert.throws(() => selectKitSlugs(['kits/unknown/a.ts'], descriptors), /unknown Kit directory/u);
```

Assert the root package scripts contain no `@itharbors/kit-` names and no `test:agent-guard` exception.

- [ ] **Step 2: Run focused tests and verify static-list failure**

Run: `node --test scripts/lib/build-tasks.test.mjs scripts/lib/kit-ci-selection.test.mjs scripts/lib/kit-matrix.test.mjs`

Expected: FAIL on hard-coded workspaces or missing matrix runner.

- [ ] **Step 3: Derive build and CI work from descriptors**

Framework shared paths select every descriptor; `kits/<slug>/**` selects only that slug. Delete contract-target maps, Notification resource exceptions, and Kit-specific workspace tasks. Keep Framework workspace build tasks separate from Kit tasks; a Kit task invokes the injected CLI with its descriptor directory.

- [ ] **Step 4: Replace root test enumeration**

Move the current non-Kit workspace and Node test clauses verbatim into `test:framework`, then set root scripts to these generic entry points:

```json
{
  "kits:build": "node scripts/run-kit-matrix.mjs build",
  "kits:test": "node scripts/run-kit-matrix.mjs test",
  "kits:check": "node scripts/run-kit-matrix.mjs check",
  "test": "npm run test:framework && npm run kits:test && npm run test:workflows"
}
```

`test:framework` contains Gateway, Server, Client, Kit Core, Kit CLI, desktop/runtime, plugin-build, store, registry, and manager tests. `test:workflows` contains change-workflow, kit-workflow, app-workflow, publish, monorepo, selection, desktop, and documentation suites. Preserve every existing non-product command; remove only explicit product Kit enumeration and product exceptions.

- [ ] **Step 5: Run selection, build-plan, and CI workflow tests**

Run: `node --test scripts/lib/build-tasks.test.mjs scripts/lib/kit-ci-selection.test.mjs scripts/lib/kit-matrix.test.mjs scripts/lib/ci-workflow.test.mjs`

Expected: PASS with dynamic fixture Kits.

- [ ] **Step 6: Commit descriptor-driven orchestration**

```bash
git add scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs scripts/lib/kit-ci-selection.mjs scripts/lib/kit-ci-selection.test.mjs scripts/run-kit-matrix.mjs scripts/lib/kit-matrix.test.mjs scripts/select-kit-ci.mjs .github/workflows/kit-ci.yml package.json
git commit -m "[Refactor] 动态编排 Kit 构建测试"
```

---

### Task 6: Add generic plugin-owned storage paths

**Files:**
- Create: `packages/server/src/framework/plugin/paths.ts`
- Create: `packages/server/tests/framework/plugin-paths.test.ts`
- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/server/src/framework/plugin/index.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `scripts/lib/desktop-paths.mjs`
- Modify: `scripts/lib/desktop-paths.test.mjs`
- Modify: `scripts/lib/desktop-framework.mjs`
- Modify: `scripts/lib/desktop-framework.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`

**Interfaces:**
- Produces `PluginPaths { readonly data: string; readonly cache: string; readonly temp: string; readonly legacyData: readonly string[] }`.
- Produces `createPluginPaths({ roots, owner, legacyDataDirectories }): Promise<PluginPaths>`.
- Adds readonly `paths` to `PluginRuntime` and `ApplicationPluginRuntime`, bound by PluginModule to the currently loading owner.
- Adds generic absolute `pluginDataRoot`, `pluginCacheRoot`, and `pluginTempRoot` host configuration; the deprecated Agent Guard input remains read-only for this commit and is removed by Task 7 after its consumer migrates.

- [ ] **Step 1: Write failing security and runtime-owner tests**

Assert stable hashed/encoded owner directories, 0700 directory mode where supported, separate owners, no raw scoped package traversal, no symlink root, safe legacy directories beneath the application data root, and no paths in Panel runtime:

```ts
const roots = { applicationData: root, data: path.join(root, 'plugins/data'), cache, temp };
const first = await createPluginPaths({
  roots,
  owner: '@itharbors/agent-guard-background',
  legacyDataDirectories: ['agent-guard'],
});
const second = await createPluginPaths({
  roots,
  owner: '@itharbors/scheduler-service',
  legacyDataDirectories: [],
});
expect(first.data).not.toBe(second.data);
expect(path.relative(root, first.data).startsWith('..')).toBe(false);
expect(first.legacyData.every((value) => !path.relative(root, value).startsWith('..'))).toBe(true);
```

Add source-contract assertions that the new runtime path API contains no Kit-specific field names and that generic roots reach both application and session plugin loads. Keep existing legacy-input tests until Task 7.

- [ ] **Step 2: Run focused tests and verify missing generic API**

Run: `npm run test -w packages/server -- tests/framework/plugin-paths.test.ts tests/framework/plugin-runtime.test.ts && node --test scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: FAIL on missing `createPluginPaths` and old Agent Guard fields.

- [ ] **Step 3: Implement generic path derivation and owner binding**

Use a canonical safe owner encoding shared with existing Kit identity helpers or a lowercase SHA-256 directory key. Resolve and validate the roots before plugin load. Resolve descriptor-declared legacy directory names beneath the application data root and expose them as a frozen read-only list; never create, delete, or write them. PluginModule creates a frozen owner-specific runtime view for each load; plugins cannot request another owner or override roots.

- [ ] **Step 4: Replace desktop and Server environment plumbing**

Add generic environment variables:

```text
HARBORS_PLUGIN_DATA_ROOT
HARBORS_PLUGIN_CACHE_ROOT
HARBORS_PLUGIN_TEMP_ROOT
```

All are absolute, application-scoped roots. Preserve the old Agent Guard field as a deprecated compatibility input without changing its value or adding new uses. Task 7 migrates the consumer and deletes the field, environment variable, and tests in the same task.

- [ ] **Step 5: Run server and desktop path suites**

Run: `npm run test -w packages/server -- tests/framework/plugin-paths.test.ts tests/framework/plugin-runtime.test.ts tests/application/server-lifecycle.test.ts && node --test scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the Framework capability**

```bash
git add packages/server/src packages/server/tests scripts/lib/desktop-paths.mjs scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework.mjs scripts/lib/desktop-framework.test.mjs scripts/electron.mjs scripts/lib/electron-launcher.test.mjs
git commit -m "[Refactor] 提供通用插件存储目录"
```

---

### Task 7: Localize Agent Guard ownership

**Files:**
- Move: `packages/agent-guard-contracts/**` to `kits/agent-guard/packages/contracts/**`
- Move: `scripts/agent-guard-smoke.mjs` to `kits/agent-guard/scripts/smoke.mjs`
- Modify: `kits/agent-guard/package.json`
- Modify: `kits/agent-guard/plugins/*/package.json`
- Modify: `kits/agent-guard/plugins/agent-guard-background/main/src/service.ts`
- Modify: `kits/agent-guard/tests/**`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `scripts/lib/desktop-paths.mjs`
- Modify: `scripts/lib/desktop-paths.test.mjs`
- Modify: `scripts/lib/desktop-framework.mjs`
- Modify: `scripts/lib/desktop-framework.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ApplicationPluginRuntime.paths.data` from Task 6.
- Produces Kit-local workspace `@itharbors/agent-guard-contracts` with unchanged public exports.
- Produces Kit-local `smoke` lifecycle script.

- [ ] **Step 1: Add failing ownership assertions**

Extend Agent Guard manifest tests to assert root workspaces, build graph, and Server production sources contain no `agent-guard-contracts`, `agentGuardDataDir`, or `HARBORS_AGENT_GUARD_DATA_DIR`, while both Agent Guard plugins resolve the local contracts workspace.

- [ ] **Step 2: Run Agent Guard tests and confirm current leakage**

Run: `npm run test -w @itharbors/kit-agent-guard && node --test scripts/lib/build-tasks.test.mjs`

Expected: FAIL on root contracts ownership and old environment access.

- [ ] **Step 3: Move contracts and smoke without changing behavior**

Preserve package name and exports. Add `packages/*` and `plugins/*` to Agent Guard workspaces, omit `build:prepare`, set `test:kit` to the existing Vitest command, set `smoke` to the local script, and add `harbors.storage.legacyDataDirectories: ["agent-guard"]`. Update all imports through the unchanged package name.

- [ ] **Step 4: Consume plugin-owned data path**

Change service construction from environment access to runtime context and remove the deprecated host plumbing in the same step:

```ts
const service = createAgentGuardService({
  dataDir: runtime.paths.data,
  legacyDataDirs: runtime.paths.legacyData,
});
```

Keep the existing data compatibility reader for one version without deleting the legacy directory; all new writes use `runtime.paths.data`.

- [ ] **Step 5: Run Agent Guard build, tests, and smoke**

Run: `npm run build -w @itharbors/kit-cli && node packages/kit-cli/dist/cli.js build kits/agent-guard && node packages/kit-cli/dist/cli.js test kits/agent-guard && node kits/agent-guard/scripts/smoke.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Agent Guard localization**

```bash
git add kits/agent-guard packages/agent-guard-contracts packages/server/src/server.ts packages/server/src/index.ts scripts/agent-guard-smoke.mjs scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs scripts/lib/desktop-paths.mjs scripts/lib/desktop-paths.test.mjs scripts/lib/desktop-framework.mjs scripts/lib/desktop-framework.test.mjs scripts/electron.mjs scripts/lib/electron-launcher.test.mjs package.json package-lock.json
git commit -m "[Refactor] 收回 Agent Guard 专属实现"
```

---

### Task 8: Localize Notifications resources and remove desktop Kit identity

**Files:**
- Move: `scripts/prepare-notification-skill-resource.mjs` to `kits/notifications/scripts/prepare-skill-resource.mjs`
- Move: `scripts/lib/codex-skill-resource.mjs` to `kits/notifications/scripts/lib/codex-skill-resource.mjs`
- Create: `kits/notifications/resources/notify-user/**` from the current user-installable notification payload; keep `.agents/skills/notify-user/**` unchanged as the repository's generic agent workflow, not as a Notifications Kit build input
- Modify: `kits/notifications/package.json`
- Modify: `kits/notifications/plugins/notification-background/package.json`
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Modify: `scripts/lib/kit-ci-selection.mjs`
- Modify: `scripts/lib/kit-ci-selection.test.mjs`
- Modify: `scripts/electron.mjs`
- Modify: `scripts/lib/electron-launcher.test.mjs`
- Modify: `scripts/lib/notification-desktop.mjs`
- Modify: `scripts/lib/notification-desktop.test.mjs`
- Modify: `packages/kit-core/src/model.ts`
- Modify: `packages/kit-core/src/schema.ts`
- Modify: `packages/kit-core/tests/schema.test.ts`
- Create: `packages/server/src/application/notification-capability.ts`
- Create: `packages/server/tests/application/notification-capability.test.ts`
- Modify: `packages/server/src/application/runtime.ts`
- Modify: `packages/server/src/editor/types.ts`
- Modify: `packages/server/src/framework/plugin/index.ts`
- Modify: `packages/server/tests/framework/plugin-runtime.test.ts`
- Modify: `kits/notifications/kit.json`
- Modify: `kits/notifications/plugins/notification-background/main/src/index.ts`
- Modify: `kits/notifications/plugins/notification-center/main/src/index.ts`

**Interfaces:**
- Produces Kit-local `build:prepare` that copies only declared local resources into the notification plugin dist.
- Produces generic `resolveOwnerKit(pluginOwner, catalog): string | undefined` for desktop notification-center navigation.
- Produces permission `notifications` and `ApplicationPluginRuntime.host.notifications` with `create`, `list`, `markRead`, `markAllRead`, and `remove` methods.
- Removes `NOTIFICATION_KIT_NAME` and any host-side `@itharbors/kit-notifications` constant.

- [ ] **Step 1: Write failing resource and owner-resolution tests**

Assert the Notifications build works after copying only `kits/notifications` plus the injected toolchain. Add a catalog fixture where an arbitrary startup plugin owner maps to an arbitrary Kit:

```js
assert.equal(resolveOwnerKit('@example/background', [{
  name: '@example/kit-zeta',
  startupPlugins: ['@example/background'],
}]), '@example/kit-zeta');
```

Assert desktop production sources contain neither `NOTIFICATION_KIT_NAME` nor `@itharbors/kit-notifications`.

Add capability tests with an arbitrary application plugin owner. A desktop owner whose Kit declares `notifications` receives a frozen client; a Web owner gets `CAPABILITY_UNSUPPORTED`; an undeclared desktop owner gets `CAPABILITY_NOT_PERMITTED`. Assert the client accepts only normalized notification input and never exposes the host port or base URL.

- [ ] **Step 2: Run focused tests and verify current fixed paths fail**

Run: `npm run test -w @itharbors/kit-notifications && npm run test -w @itharbors/kit-core && npm run test -w packages/server -- tests/application/notification-capability.test.ts tests/framework/plugin-runtime.test.ts && node --test scripts/lib/build-tasks.test.mjs scripts/lib/kit-ci-selection.test.mjs scripts/lib/notification-desktop.test.mjs scripts/lib/electron-launcher.test.mjs`

Expected: FAIL on root resource steps and desktop Kit constant.

- [ ] **Step 3: Move resource preparation under the Kit**

Preserve byte-for-byte resource output and safety limits. The local script accepts no arbitrary source/output arguments; it resolves both beneath the Kit root. Configure `build:prepare` and `harbors.resources` locally. The Kit-local payload is the only source consumed by the Notifications build; `.agents/skills/notify-user/**` remains a Framework/developer workflow and must not be read by Kit build code.

- [ ] **Step 4: Resolve notification navigation by plugin ownership**

Use the validated Catalog snapshot to map the notification application plugin owner to its Kit. Missing/ambiguous ownership returns no navigation target and logs a sanitized diagnostic; it must not fall back to a named Kit.

- [ ] **Step 5: Add a permission-gated host capability and migrate both plugins**

Add `notifications` to `KIT_PERMISSIONS` and the Notifications manifest. Define the public capability as:

```ts
interface NotificationHostCapability {
  create(input: NotificationInput): Promise<NotificationRecord>;
  list(): Promise<NotificationSnapshot>;
  markRead(id: string): Promise<NotificationRecord>;
  markAllRead(): Promise<{ unreadCount: number }>;
  remove(id: string): Promise<void>;
}
```

ApplicationRuntime binds permissions from the validated owning Kit descriptor before PluginModule constructs the runtime view. Desktop uses an internal loopback client with fixed routes and size/time limits; Web and missing permissions return the exact structured errors from the design. Replace both Notifications plugins' direct `fetch`/port reads with `runtime.host.notifications`; no Kit code reads `HARBORS_NOTIFICATION_PORT` afterward.

- [ ] **Step 6: Run Notifications, capability, and desktop suites**

Run: `npm run test -w @itharbors/kit-core && npm run test -w packages/server -- tests/application/notification-capability.test.ts tests/framework/plugin-runtime.test.ts && node packages/kit-cli/dist/cli.js build kits/notifications && node packages/kit-cli/dist/cli.js test kits/notifications && node --test scripts/lib/notification-*.test.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/build-tasks.test.mjs scripts/lib/kit-ci-selection.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Notifications localization**

```bash
git add kits/notifications packages/kit-core packages/server/src/application packages/server/src/editor/types.ts packages/server/src/framework/plugin/index.ts packages/server/tests/application packages/server/tests/framework/plugin-runtime.test.ts scripts/prepare-notification-skill-resource.mjs scripts/lib/codex-skill-resource.mjs scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs scripts/lib/kit-ci-selection.mjs scripts/lib/kit-ci-selection.test.mjs scripts/electron.mjs scripts/lib/electron-launcher.test.mjs scripts/lib/notification-desktop.mjs scripts/lib/notification-desktop.test.mjs
git commit -m "[Refactor] 收回通知资源与桌面身份"
```

---

### Task 9: Move all remaining private contracts into their Kits

**Files:**
- Move: `packages/csv-contracts/**` to `kits/csv/packages/contracts/**`
- Move: `packages/sqlite-contracts/**` to `kits/sqlite/packages/contracts/**`
- Move: `packages/mysql-contracts/**` to `kits/mysql/packages/contracts/**`
- Move: `packages/traceweave-contracts/**` to `kits/traceweave/packages/contracts/**`
- Modify: `kits/{csv,sqlite,mysql,traceweave}/package.json`
- Modify: `kits/{csv,sqlite,mysql,traceweave}/plugins/*/package.json`
- Modify: `kits/{csv,sqlite,mysql,traceweave}/tests/**`
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Preserves package names and exported TypeScript APIs.
- Each contracts package is a workspace only of its owning Kit.
- Removes all `packages/*-contracts` build tasks and CI path mappings.

- [ ] **Step 1: Add one ownership test per Kit**

Each Kit test resolves its contracts package real path and asserts it starts with that Kit root. Add a root invariant:

```js
for (const name of ['csv', 'sqlite', 'mysql', 'traceweave']) {
  assert.equal(existsSync(path.join(repositoryRoot, 'packages', `${name}-contracts`)), false);
}
```

- [ ] **Step 2: Run focused Kit tests and confirm ownership fails**

Run: `npm run test -w @itharbors/kit-csv && npm run test -w @itharbors/kit-sqlite && npm run test -w @itharbors/kit-mysql && npm run test -w @itharbors/kit-traceweave`

Expected: FAIL on real-path ownership assertions.

- [ ] **Step 3: Move contracts in four mechanical slices**

For each Kit, move its package intact, add the local workspace, update local scripts, and run that Kit before moving to the next. Do not change message names, payload shapes, exports, versions, or behavior.

- [ ] **Step 4: Remove root build and test registrations**

Delete the four root workspace tasks/dependency maps and explicit tests. The generic descriptor and Kit lifecycle must discover them from local manifests.

- [ ] **Step 5: Run all four isolated lifecycle checks**

Run: `for kit in csv sqlite mysql traceweave; do node packages/kit-cli/dist/cli.js build "kits/$kit" && node packages/kit-cli/dist/cli.js test "kits/$kit"; done`

Expected: PASS for all four Kits.

- [ ] **Step 6: Commit private contracts localization**

```bash
git add kits/csv kits/sqlite kits/mysql kits/traceweave packages/csv-contracts packages/sqlite-contracts packages/mysql-contracts packages/traceweave-contracts scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs package.json package-lock.json
git commit -m "[Refactor] 迁回 Kit 私有协议"
```

---

### Task 10: Remove mutable cross-Kit Relationship Graph source

**Files:**
- Copy then independently own: `packages/relationship-graph/**` under `kits/sqlite/packages/relationship-graph/**`
- Copy then independently own: `packages/relationship-graph/**` under `kits/mysql/packages/relationship-graph/**`
- Delete: `packages/relationship-graph/**`
- Modify: `kits/sqlite/package.json`
- Modify: `kits/mysql/package.json`
- Modify: `kits/sqlite/plugins/sqlite-relationships/package.json`
- Modify: `kits/mysql/plugins/mysql-relationships/package.json`
- Modify: `scripts/lib/build-tasks.mjs`
- Modify: `scripts/lib/build-tasks.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Preserves `@itharbors/relationship-graph` imports inside each Kit at migration time.
- Package resolution is local to the owning Kit; there is no root or cross-Kit package instance.

- [ ] **Step 1: Add real-path and isolation tests**

From each Kit root resolve `@itharbors/relationship-graph/package.json` and assert the real path belongs to that Kit. Assert the two real paths differ and root package is absent.

- [ ] **Step 2: Run database Kit tests and verify shared resolution**

Run: `npm run test -w @itharbors/kit-sqlite && npm run test -w @itharbors/kit-mysql`

Expected: FAIL because both resolve the root workspace.

- [ ] **Step 3: Establish two local package owners**

Copy source, tests, configs, and package metadata into each Kit, add local workspaces, then delete the root package. Preserve behavior and package API; do not create a relative import between Kits.

- [ ] **Step 4: Run each package and Kit independently**

Run: `node packages/kit-cli/dist/cli.js build kits/sqlite && node packages/kit-cli/dist/cli.js test kits/sqlite && node packages/kit-cli/dist/cli.js build kits/mysql && node packages/kit-cli/dist/cli.js test kits/mysql`

Expected: PASS.

- [ ] **Step 5: Commit independent UI ownership**

```bash
git add kits/sqlite kits/mysql packages/relationship-graph scripts/lib/build-tasks.mjs scripts/lib/build-tasks.test.mjs package.json package-lock.json
git commit -m "[Refactor] 分离数据库关系图实现"
```

---

### Task 11: Give every Kit an independent lockfile

**Files:**
- Create: `kits/{default,agent-guard,csv,mysql,notifications,scheduler,skill-manager,sqlite,traceweave}/package-lock.json`
- Modify: all `kits/*/package.json` workspace and lifecycle scripts
- Modify: root `package.json`
- Modify: root `package-lock.json`
- Create: `scripts/lib/kit-install.mjs`
- Create: `scripts/lib/kit-install.test.mjs`
- Modify: `scripts/run-kit-matrix.mjs`
- Modify: `scripts/lib/kit-check.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces `ensureKitInstall({ descriptor, cacheRoot, npmExecutable? }): Promise<KitInstallResult>`.
- Cache key contains lockfile SHA-256, runner version, platform, architecture, and Node ABI.
- Root npm workspaces become exactly `packages/*` and `plugins/*`; `kits/*` is removed.

- [ ] **Step 1: Write failing lock ownership and cache tests**

Assert every descriptor has `package-lock.json`, root lock has no `kits/` package keys, lock/package drift fails, changed lock hash misses cache, partial cache is never reused, and two Kits use different install roots.

- [ ] **Step 2: Run install tests and confirm shared-lock failure**

Run: `node --test scripts/lib/kit-install.test.mjs scripts/lib/kit-monorepo.test.mjs`

Expected: FAIL because Kits still depend on the root lock/workspace.

- [ ] **Step 3: Normalize Kit-local package roots**

Every Kit package declares its own `private`, version, workspaces, lifecycle scripts, product dependencies, and local workspace dependencies. Generate each lock with:

```bash
npm install --package-lock-only --ignore-scripts --prefix "kits/<slug>"
```

Do not use `file:` dependencies that leave the Kit root. Framework CLI/SDK is injected by the runner and excluded from product locks.

- [ ] **Step 4: Cut root workspace and lock ownership**

Remove `kits/*` from root workspaces, remove Kit/product packages from root lock, and run root `npm install --package-lock-only --ignore-scripts`. Implement atomic cache preparation with a temporary directory and completion record written last.

- [ ] **Step 5: Run root install and every Kit install**

Run: `npm ci && for kit in default agent-guard csv mysql notifications scheduler skill-manager sqlite traceweave; do npm ci --ignore-scripts --prefix "kits/$kit"; done`

Expected: PASS without modifying any lockfile.

- [ ] **Step 6: Run isolated build/test/check matrix**

Run: `npm run build -w @itharbors/kit-cli && npm run kits:build && npm run kits:test && npm run kits:check`

Expected: PASS.

- [ ] **Step 7: Commit independent dependency roots**

```bash
git add kits/*/package.json kits/*/package-lock.json package.json package-lock.json scripts/lib/kit-install.mjs scripts/lib/kit-install.test.mjs scripts/run-kit-matrix.mjs scripts/lib/kit-check.mjs .gitignore
git commit -m "[Refactor] 隔离 Kit 依赖锁文件"
```

---

### Task 12: Derive builtin packaging and documentation from descriptors

**Files:**
- Delete: `scripts/lib/builtin-kits.mjs`
- Modify: `packages/kit-cli/src/plugin-build/discover.ts` (the Task 4 replacement)
- Modify: `scripts/lib/desktop-build.mjs`
- Modify: `scripts/lib/desktop-build.test.mjs`
- Modify: `scripts/build-desktop.mjs`
- Modify: `scripts/lib/kit-docs.test.mjs`
- Modify: `readme.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/{system-overview,kit-and-session-model}.md`
- Modify: `docs/guides/{developing-plugins-and-kits,development-workflow,kit-artifacts}.md`
- Modify: every `kits/*/README.md` missing the local lifecycle and ownership contract

**Interfaces:**
- Consumes: `descriptor.distribution`.
- Stable build and desktop staging include exactly descriptors with `distribution === 'builtin'`.
- Root docs describe discovery and ownership rules without enumerating product slugs.

- [ ] **Step 1: Write failing builtin and documentation invariants**

Use a temporary descriptor fixture with an arbitrary builtin slug and assert runtime plugin discovery/staging selects it. Add source scans that reject `BUILTIN_KITS`, current official slug arrays, and hand-written root product lists.

- [ ] **Step 2: Run focused tests and verify static builtin failure**

Run: `node --test scripts/lib/desktop-build.test.mjs scripts/lib/kit-docs.test.mjs && npm run test -w @itharbors/kit-cli -- tests/build.test.ts`

Expected: FAIL on `builtin-kits.mjs` and static documentation assumptions.

- [ ] **Step 3: Replace builtin constants with descriptor filters**

Stable build, runtime plugin discovery, and desktop staging receive discovered descriptors. Reject multiple descriptors with the same id/menu root and reject market Kit inputs to builtin staging. Delete the constant module.

- [ ] **Step 4: Move product documentation to Kit README files**

Root documentation explains the general contract and links to the dynamically discovered `kits/` directory, without maintaining a current product table. Each Kit README includes its local install/build/test/smoke commands, permissions, platform target, and ownership boundary.

- [ ] **Step 5: Run packaging and documentation tests**

Run: `node --test scripts/lib/desktop-build.test.mjs scripts/lib/desktop-package.test.mjs scripts/lib/kit-docs.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit dynamic builtin and docs**

```bash
git add scripts/lib/builtin-kits.mjs scripts/lib/desktop-build.mjs scripts/lib/desktop-build.test.mjs scripts/build-desktop.mjs packages/kit-cli scripts/lib/kit-docs.test.mjs readme.md docs kits/*/README.md
git commit -m "[Refactor] 统一 Kit 内建发现与文档"
```

---

### Task 13: Add final architecture boundary audit and acceptance

**Files:**
- Create: `scripts/lib/kit-architecture-boundary.mjs`
- Create: `scripts/lib/kit-architecture-boundary.test.mjs`
- Create: `scripts/check-kit-architecture.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yaml`
- Modify: `.github/workflows/kit-ci.yml`
- Modify: `docs/guides/development-workflow.md`

**Interfaces:**
- Produces CLI `npm run kits:boundary` that audits the complete current tree.
- Enforces no Kit-to-Kit source reference, no local dependency escape, no Kit-specific Framework production names/env, no static product lists, and isolated lifecycle success.

- [ ] **Step 1: Write failing architecture audit fixtures**

Create temporary fixtures for cross-Kit relative imports, `file:../../../packages/private`, missing lockfile, root production `HARBORS_ZETA_*`, static slug arrays, and a valid stable Framework dependency. Assert exact normalized error codes:

```js
assert.deepEqual(result.errors.map((error) => error.code), [
  'KIT_CROSS_IMPORT',
  'KIT_LOCAL_DEPENDENCY_ESCAPE',
  'KIT_LOCK_MISSING',
  'FRAMEWORK_KIT_SPECIAL_CASE',
  'STATIC_KIT_REGISTRY',
]);
```

- [ ] **Step 2: Run the audit test and confirm the checker is absent**

Run: `node --test scripts/lib/kit-architecture-boundary.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement deterministic static audit**

Parse JSON manifests and TypeScript/JavaScript import specifiers; do not rely only on substring search. Restrict special-case scanning to Framework production files and explicit general tests, excluding governance identity policy and temporary fixtures. Emit all violations in sorted order and fail once with a summary.

- [ ] **Step 4: Wire mandatory CI gates**

Framework CI runs static architecture audit plus Framework tests. Kit CI runs diff boundary, static architecture audit for the target, isolated install/build/test/pack/inspect, and no other Kit. Release repeats the target Kit isolation check.

- [ ] **Step 5: Run complete automated verification**

Run:

```bash
npm run kits:boundary
npm run build
npm test
npm run plugins:check
node packages/kit-cli/dist/cli.js validate kits/default
for kit in agent-guard csv mysql notifications scheduler skill-manager sqlite traceweave; do
  output="$(mktemp -d)/$kit"
  npm run kit:check -- "$kit" --output-directory "$output"
done
```

Expected: every command exits 0; each market Kit check produces exactly one inspectable `.hkit`, while Default validates as builtin and is not passed to the market checker.

- [ ] **Step 6: Run runtime acceptance**

Run `npm run dev:web`, open the Kit selector, and verify at least one simple Kit plus Agent Guard, Notifications, SQLite, and TraceWeave create isolated sessions and load their main panels. Then run Electron and verify Agent Guard retains data through restart, Notifications opens its owner Kit without a hard-coded id, Kit Manager install/activate/rollback works, and stable startup includes only discovered builtin Kits.

Expected: browser and Electron checks match the approved design with no Kit-specific host environment fields or root product dependencies.

- [ ] **Step 7: Commit final enforcement**

```bash
git add scripts/lib/kit-architecture-boundary.mjs scripts/lib/kit-architecture-boundary.test.mjs scripts/check-kit-architecture.mjs package.json .github/workflows/ci.yaml .github/workflows/kit-ci.yml docs/guides/development-workflow.md
git commit -m "[Refactor] 建立 Kit 架构边界验收"
```

## Final completion audit

- [ ] Compare every goal and coverage row in `docs/superpowers/specs/2026-08-01-kit-self-contained-boundaries-design.md` to authoritative code or test evidence.
- [ ] Confirm `git status --short` is clean and review `git diff origin/main...HEAD` for generated output, user data, or unintended files.
- [ ] Confirm all commits use the repository title convention and the branch remains `refactor/kit-self-contained-boundaries`.
- [ ] Run the complete automated and runtime acceptance from Task 13 again on final HEAD.
- [ ] Dispatch a whole-branch architecture/code review; resolve all Critical and Important findings and adjudicate Minor findings explicitly.
- [ ] Use the repository finishing workflow only after all evidence proves the original goal, then create and verify the PR.
